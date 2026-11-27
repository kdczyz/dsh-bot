"""宿主资源门禁与系统信息采集：
- 虚拟屏启动前内存门禁（cgroup 与 /proc/meminfo 取较小值）
- 系统信息实时采集（磁盘占用、内存占用、CPU 占用、开机时长），纯标准库零第三方依赖
"""
from __future__ import annotations

import os
import platform
import shutil
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Sequence

from .config import DEFAULT_DISK_PATHS, MIN_FREE_MB

_MIB = 1024 * 1024
_GIB = 1024 * 1024 * 1024
_CGROUP_V2 = Path("/sys/fs/cgroup")
_CGROUP_V1 = Path("/sys/fs/cgroup/memory")
_MEMINFO = Path("/proc/meminfo")
_PROC_STAT = Path("/proc/stat")
_PROC_UPTIME = Path("/proc/uptime")

_CPU_LOCK = threading.Lock()
_LAST_CPU_SAMPLE: Optional[tuple[int, int, float]] = None  # (total_jiffies, idle_jiffies, mono_ts)
_HOST_SUMMARY_LOCK = threading.Lock()
_HOST_SUMMARY_CACHE: Optional[tuple[float, tuple[str, ...], Optional[bool], dict]] = None
_HOST_SUMMARY_TTL_SEC = 0.4


class MemoryBlocked(RuntimeError):
    """可用内存不足，拒绝拉起新屏。"""


@dataclass
class MemoryInfo:
    available_mb: Optional[int]   # None = 读不到（非 Linux / 特殊沙箱）
    limit_mb: Optional[int]       # cgroup 限额，无限额则为机器 MemTotal


def _read_int(path: Path) -> Optional[int]:
    try:
        text = path.read_text(encoding="utf-8-sig").strip()
    except OSError:
        return None
    return int(text) if text.isdigit() else None  # "max" → None


def _meminfo() -> dict:
    out = {}
    try:
        with open(_MEMINFO, encoding="utf-8") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                parts = rest.split()
                if parts and parts[0].isdigit():
                    out[key] = int(parts[0])
    except OSError:
        pass
    return out


def _cgroup_limit_and_usage() -> tuple[Optional[int], Optional[int]]:
    """返回 (limit_bytes, usage_bytes)；v2 优先，退到 v1。"""
    limit = _read_int(_CGROUP_V2 / "memory.max")
    usage = _read_int(_CGROUP_V2 / "memory.current")
    if limit is None and usage is None:
        limit = _read_int(_CGROUP_V1 / "memory.limit_in_bytes")
        usage = _read_int(_CGROUP_V1 / "memory.usage_in_bytes")
    if limit is not None and limit > 1 << 50:  # "unlimited" 常见写法
        limit = None
    return limit, usage


def memory_info() -> MemoryInfo:
    info = _meminfo()
    mem_available = info.get("MemAvailable")
    mem_total = info.get("MemTotal")
    limit, usage = _cgroup_limit_and_usage()

    candidates = []
    if mem_available is not None:
        candidates.append(mem_available // 1024)  # kB → MB
    if limit is not None:
        candidates.append(max(0, (limit - (usage or 0)) // _MIB))
    if not candidates:
        return MemoryInfo(None, (mem_total // 1024) if mem_total else None)
    return MemoryInfo(min(candidates), (limit // _MIB) if limit else (mem_total // 1024 if mem_total else None))


def min_free_mb() -> int:
    return MIN_FREE_MB


def memory_blocker(info: Optional[MemoryInfo] = None, need_mb: Optional[int] = None) -> Optional[str]:
    """不能启动的原因；None 表示可以启动。读不到内存不算阻塞（宁可启动）。"""
    if need_mb is not None and need_mb <= 0:
        return None
    info = info or memory_info()
    need = min_free_mb() if need_mb is None else need_mb
    if info.available_mb is None:
        return None
    if info.available_mb >= need:
        return None
    limit = f" / 限额 {info.limit_mb} MB" if info.limit_mb else ""
    return (
        f"内存不足，暂不拉起虚拟屏：可用 {info.available_mb} MB{limit}，"
        f"需要至少 {need} MB（BOTSCREEN_MIN_FREE_MB）。"
        f"先冻结空闲屏，或调低该阈值。"
    )


def require_memory() -> None:
    """启动前的门禁：不足就抛 MemoryBlocked（消息可直接给前端看）。"""
    blocker = memory_blocker()
    if blocker:
        raise MemoryBlocked(blocker)


def summarize() -> dict:
    info = memory_info()
    return {
        "available_mb": info.available_mb,
        "limit_mb": info.limit_mb,
        "min_free_mb": min_free_mb(),
        "blocker": memory_blocker(info),
    }


# ---------------------------------------------------------------- 系统信息采集 ----
_LAST_CPU_PCT: Optional[float] = None


def _read_cpu_jiffies() -> Optional[tuple[int, int]]:
    """读取 /proc/stat 第一行汇总 CPU jiffies，返回 (total, idle_plus_iowait)。"""
    try:
        with open(_PROC_STAT, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("cpu "):
                    parts = [int(x) for x in line.split()[1:] if x.isdigit()]
                    if len(parts) >= 4:
                        idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
                        return sum(parts), idle
    except OSError:
        pass
    return None


def prime_cpu_sample() -> None:
    """在网关启动时预采样一次 CPU jiffies，确保首次接口查询无需等待。"""
    global _LAST_CPU_SAMPLE
    sample = _read_cpu_jiffies()
    if sample is not None:
        with _CPU_LOCK:
            _LAST_CPU_SAMPLE = (sample[0], sample[1], time.monotonic())


def cpu_info(sample_interval: float = 0.08) -> dict:
    """采集 CPU 占用率、逻辑核心数与 1/5/15 分钟系统负载。"""
    global _LAST_CPU_SAMPLE, _LAST_CPU_PCT
    usage_pct: Optional[float] = None
    estimated = False
    now_mono = time.monotonic()

    with _CPU_LOCK:
        prev = _LAST_CPU_SAMPLE
        cached_pct = _LAST_CPU_PCT

    cur = _read_cpu_jiffies()
    if cur is not None:
        if prev is not None and (now_mono - prev[2]) < 0.15 and cached_pct is not None:
            # 高频并发查询时直接复用 150ms 内的最近计算值，避免 0-jiffy 抖动
            usage_pct = cached_pct
        elif prev is not None and (cur[0] - prev[0]) > 0:
            total_diff = cur[0] - prev[0]
            idle_diff = max(0, cur[1] - prev[1])
            usage_pct = max(0.0, min(100.0, (1.0 - idle_diff / total_diff) * 100.0))
            with _CPU_LOCK:
                _LAST_CPU_SAMPLE = (cur[0], cur[1], now_mono)
                _LAST_CPU_PCT = usage_pct
        else:
            # 冷启动首次采样：短间隔两次读取计算瞬时占用率
            wait = max(0.02, min(0.5, float(sample_interval))) if sample_interval > 0 else 0.0
            if wait > 0:
                time.sleep(wait)
                cur2 = _read_cpu_jiffies()
                now2 = time.monotonic()
                if cur2 is not None and (cur2[0] - cur[0]) > 0:
                    total_diff = cur2[0] - cur[0]
                    idle_diff = max(0, cur2[1] - cur[1])
                    usage_pct = max(0.0, min(100.0, (1.0 - idle_diff / total_diff) * 100.0))
                    with _CPU_LOCK:
                        _LAST_CPU_SAMPLE = (cur2[0], cur2[1], now2)
                        _LAST_CPU_PCT = usage_pct
                else:
                    with _CPU_LOCK:
                        _LAST_CPU_SAMPLE = (cur[0], cur[1], now_mono)
                    usage_pct = cached_pct if cached_pct is not None else 0.0
            else:
                with _CPU_LOCK:
                    _LAST_CPU_SAMPLE = (cur[0], cur[1], now_mono)
                usage_pct = cached_pct if cached_pct is not None else 0.0

    cores = os.cpu_count() or 1
    load_avg = None
    try:
        l1, l5, l15 = os.getloadavg()
        load_avg = {"1m": round(l1, 2), "5m": round(l5, 2), "15m": round(l15, 2)}
    except (OSError, AttributeError):
        load_avg = None

    # 极端受限沙箱无法读取 /proc/stat 时，用 1 分钟系统负载按核数估算 CPU 占用率
    if usage_pct is None and load_avg is not None:
        usage_pct = max(0.0, min(100.0, (load_avg["1m"] / max(1, cores)) * 100.0))
        estimated = True

    return {
        "usage_percent": round(usage_pct, 1) if usage_pct is not None else None,
        "cores": cores,
        "load_avg": load_avg,
        "estimated": estimated,
    }


def memory_usage() -> dict:
    """采集内存占用详情（兼容 cgroup 限额与 /proc/meminfo 宿主机内存，无重复文件读取）。"""
    raw = _meminfo()
    mem_total_kb = raw.get("MemTotal")
    mem_available_kb = raw.get("MemAvailable")
    mem_free_kb = raw.get("MemFree")
    swap_total_kb = raw.get("SwapTotal", 0)
    swap_free_kb = raw.get("SwapFree", 0)
    cg_limit, cg_usage = _cgroup_limit_and_usage()

    host_total_bytes = mem_total_kb * 1024 if mem_total_kb is not None else None
    host_avail_bytes = mem_available_kb * 1024 if mem_available_kb is not None else None
    host_free_bytes = mem_free_kb * 1024 if mem_free_kb is not None else None

    # 有效总量取 cgroup 限额与宿主机物理内存的较小值
    cgroup_limited = False
    total_bytes = host_total_bytes
    if cg_limit is not None:
        if total_bytes is None or cg_limit < total_bytes:
            total_bytes = cg_limit
            cgroup_limited = True

    avail_candidates = []
    if host_avail_bytes is not None:
        avail_candidates.append(host_avail_bytes)
    if cg_limit is not None:
        avail_candidates.append(max(0, cg_limit - (cg_usage or 0)))
    available_bytes = min(avail_candidates) if avail_candidates else host_free_bytes

    used_bytes: Optional[int] = None
    usage_percent: Optional[float] = None
    if total_bytes is not None and total_bytes > 0 and available_bytes is not None:
        used_bytes = max(0, total_bytes - available_bytes)
        usage_percent = round((used_bytes / total_bytes) * 100.0, 1)

    gate_avail_mb = (available_bytes // _MIB) if avail_candidates else None
    gate_limit_mb = (
        (cg_limit // _MIB)
        if cg_limit is not None
        else ((mem_total_kb // 1024) if mem_total_kb is not None else None)
    )
    gate = MemoryInfo(gate_avail_mb, gate_limit_mb)
    swap_total_bytes = swap_total_kb * 1024
    swap_used_bytes = max(0, (swap_total_kb - swap_free_kb) * 1024)

    return {
        "total_bytes": total_bytes,
        "used_bytes": used_bytes,
        "available_bytes": available_bytes,
        "free_bytes": host_free_bytes,
        "total_mb": (total_bytes // _MIB) if total_bytes is not None else None,
        "used_mb": (used_bytes // _MIB) if used_bytes is not None else None,
        "available_mb": gate.available_mb,
        "limit_mb": gate.limit_mb,
        "usage_percent": usage_percent,
        "swap_total_mb": swap_total_bytes // _MIB,
        "swap_used_mb": swap_used_bytes // _MIB,
        "min_free_mb": min_free_mb(),
        "blocker": memory_blocker(gate),
        "cgroup_limited": cgroup_limited,
        "source": "cgroup" if cgroup_limited else "host",
    }


def proc_tree_memory_bytes(pids: Sequence[int]) -> int:
    """在 cgroup 不可用的沙箱中，按 /proc/<pid>/status 的 VmRSS 汇总指定进程树的真实内存占用（字节）。"""
    total_kb = 0
    seen: set[int] = set()
    for raw_pid in pids:
        try:
            pid = int(raw_pid)
        except (TypeError, ValueError):
            continue
        if pid <= 0 or pid in seen:
            continue
        seen.add(pid)
        try:
            with open(f"/proc/{pid}/status", encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("VmRSS:"):
                        parts = line.split()
                        if len(parts) >= 2 and parts[1].isdigit():
                            total_kb += int(parts[1])
                        break
        except OSError:
            continue
    return total_kb * 1024


def _single_disk_usage(path: str) -> dict:
    try:
        usage = shutil.disk_usage(path)
        pct = round((usage.used / usage.total) * 100.0, 1) if usage.total > 0 else 0.0
        return {
            "path": path,
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
            "total_gb": round(usage.total / _GIB, 2),
            "used_gb": round(usage.used / _GIB, 2),
            "free_gb": round(usage.free / _GIB, 2),
            "usage_percent": pct,
            "ok": True,
        }
    except OSError as exc:
        return {
            "path": path,
            "total_bytes": None,
            "used_bytes": None,
            "free_bytes": None,
            "total_gb": None,
            "used_gb": None,
            "free_gb": None,
            "usage_percent": None,
            "ok": False,
            "error": str(exc),
        }


def disk_info(paths: Optional[Sequence[str]] = None) -> dict:
    """采集一个或多个挂载点的磁盘占用信息；默认使用第一个有效路径作为主盘摘要。"""
    raw_paths = list(paths) if paths else list(DEFAULT_DISK_PATHS)
    clean_paths: list[str] = []
    for item in raw_paths:
        p = str(item or "").strip()
        if p and p not in clean_paths:
            clean_paths.append(p)
    if not clean_paths:
        clean_paths = ["/"]

    mounts = [_single_disk_usage(p) for p in clean_paths]
    primary = next((m for m in mounts if m.get("ok")), mounts[0])
    return {
        "path": primary["path"],
        "total_bytes": primary["total_bytes"],
        "used_bytes": primary["used_bytes"],
        "free_bytes": primary["free_bytes"],
        "total_gb": primary["total_gb"],
        "used_gb": primary["used_gb"],
        "free_gb": primary["free_gb"],
        "usage_percent": primary["usage_percent"],
        "mounts": mounts,
    }


def _format_uptime(seconds: float) -> tuple[str, str, int, int, int, int]:
    total = max(0, int(seconds))
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    zh_parts = []
    en_parts = []
    if days:
        zh_parts.append(f"{days}天")
        en_parts.append(f"{days}d")
    if hours or days:
        zh_parts.append(f"{hours}小时")
        en_parts.append(f"{hours}h")
    zh_parts.append(f"{minutes}分")
    en_parts.append(f"{minutes}m")
    if not days and not hours:
        zh_parts.append(f"{secs}秒")
        en_parts.append(f"{secs}s")
    return " ".join(zh_parts), " ".join(en_parts), days, hours, minutes, secs


def uptime_info() -> dict:
    """采集系统开机时长（优先读取 /proc/uptime）。"""
    uptime_seconds: Optional[float] = None
    try:
        raw = _PROC_UPTIME.read_text(encoding="utf-8").strip().split()
        if raw:
            uptime_seconds = float(raw[0])
    except (OSError, ValueError):
        uptime_seconds = None

    if uptime_seconds is None:
        uptime_seconds = time.monotonic()

    zh_fmt, en_fmt, days, hours, minutes, secs = _format_uptime(uptime_seconds)
    boot_ts = max(0.0, time.time() - uptime_seconds)
    boot_iso = datetime.fromtimestamp(boot_ts, tz=timezone.utc).isoformat()
    return {
        "seconds": int(uptime_seconds),
        "days": days,
        "hours": hours,
        "minutes": minutes,
        "secs": secs,
        "formatted": zh_fmt,
        "formatted_en": en_fmt,
        "boot_time": boot_iso,
    }


def system_info(
    disk_paths: Optional[Sequence[str]] = None,
    sample_interval: float = 0.08,
    cgroup_available: Optional[bool] = None,
) -> dict:
    """汇总系统信息：主机标识、CPU 占用、内存占用、磁盘占用、开机时长。"""
    now = time.time()
    out = {
        "hostname": socket.gethostname(),
        "os": platform.system(),
        "arch": platform.machine(),
        "kernel": platform.release(),
        "platform": platform.platform(),
        "timestamp": now,
        "collected_at": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
        "cpu": cpu_info(sample_interval=sample_interval),
        "memory": memory_usage(),
        "disk": disk_info(disk_paths),
        "uptime": uptime_info(),
    }
    if cgroup_available is not None:
        out["cgroup"] = bool(cgroup_available)
    return out


def host_summary(
    disk_paths: Optional[Sequence[str]] = None,
    *,
    cgroup_available: Optional[bool] = None,
    fresh: bool = False,
) -> dict:
    """兼容旧版 `host` 摘要字段（available_mb/limit_mb/min_free_mb/blocker）并附带完整系统信息。"""
    global _HOST_SUMMARY_CACHE
    path_key = tuple(str(p).strip() for p in (disk_paths or DEFAULT_DISK_PATHS) if str(p).strip()) or ("/",)
    now_mono = time.monotonic()
    if not fresh:
        with _HOST_SUMMARY_LOCK:
            cached = _HOST_SUMMARY_CACHE
        if (
            cached is not None
            and (now_mono - cached[0]) < _HOST_SUMMARY_TTL_SEC
            and cached[1] == path_key
            and cached[2] == cgroup_available
        ):
            return dict(cached[3])

    sys_data = system_info(
        disk_paths=path_key,
        sample_interval=0.05,
        cgroup_available=cgroup_available,
    )
    mem = sys_data["memory"]
    summary = {
        "available_mb": mem["available_mb"],
        "limit_mb": mem["limit_mb"],
        "min_free_mb": mem["min_free_mb"],
        "blocker": mem["blocker"],
        **sys_data,
    }
    with _HOST_SUMMARY_LOCK:
        _HOST_SUMMARY_CACHE = (time.monotonic(), path_key, cgroup_available, summary)
    return dict(summary)


def host_system(
    disk_paths: Optional[Sequence[str]] = None,
    *,
    cgroup_available: Optional[bool] = None,
    fresh: bool = False,
) -> dict:
    """`host_summary()` 语义别名，返回包含内存门禁四字段与完整主机系统指标的字典。"""
    return host_summary(disk_paths=disk_paths, cgroup_available=cgroup_available, fresh=fresh)
