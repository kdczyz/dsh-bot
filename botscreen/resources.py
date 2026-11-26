"""宿主资源门禁：一张虚拟屏启动前先确认内存够。

参照 Hermes `tools/bot_desktop/resources.py` 的口径：可用内存取"cgroup 还允许的"与
"内核报告的 MemAvailable"的**较小值**（8 GB 限额跑在 4 GB 机器上，不是 8 GB）。

为什么需要它：一块带 Chrome 的屏冷启动会瞬间吃掉 200 MB~1 GB。机器紧张时，
不设门禁的结果是 Chrome 在登录中途被 OOM 杀掉，或者连网关一起被拖死。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .config import MIN_FREE_MB

_MIB = 1024 * 1024
_CGROUP_V2 = Path("/sys/fs/cgroup")
_CGROUP_V1 = Path("/sys/fs/cgroup/memory")
_MEMINFO = Path("/proc/meminfo")


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