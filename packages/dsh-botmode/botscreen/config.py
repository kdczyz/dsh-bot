"""BotScreen 全局配置：路径、编号映射、动态槽位分配、环境常量。"""
from __future__ import annotations

import fcntl
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from typing import Dict, Optional

# ---- 底座路径 ---------------------------------------------------------------
def _default_data_root() -> str:
    explicit = os.environ.get("BOTSCREEN_DATA_ROOT", "").strip()
    if explicit:
        return explicit
    legacy = "/data/botscreen"
    if os.path.isdir(legacy) and os.access(legacy, os.W_OK):
        return legacy
    return os.path.join(os.path.expanduser("~"), ".dsh", "botmode", "screens")


DATA_ROOT = _default_data_root()
CGROUP_ROOT = os.environ.get("BOTSCREEN_CGROUP_ROOT", "/sys/fs/cgroup/botscreen")
KASMVNC_WWW = os.environ.get("BOTSCREEN_KASMVNC_WWW", "/usr/share/kasmvnc/www")
#: 所有虚拟屏共用一份 Xauthority 文件（按 DISPLAY 分条目），
#: 这样网关单进程内的 mss 可以跨屏抓图而无需切换环境变量。
SHARED_XAUTHORITY = os.environ.get(
    "BOTSCREEN_XAUTHORITY", os.path.join(DATA_ROOT, "Xauthority.shared")
)
WEB_ROOT = os.environ.get(
    "BOTSCREEN_WEB_ROOT",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web"),
)

# ---- 编号映射（方案二.1） ----------------------------------------------------
DISPLAY_BASE = int(os.environ.get("BOTSCREEN_DISPLAY_BASE", "100"))
WS_PORT_BASE = int(os.environ.get("BOTSCREEN_WS_PORT_BASE", "6100"))

#: 网关协议代数（DSH Host 用于校验网关接口兼容性并自动替换旧进程）
GATEWAY_API_VERSION = 3
#: 统一虚拟桌面规格代数（用于检测并淘汰旧版/错位桌面进程）
DESKTOP_SPEC_VERSION = 3
#: 顶部统一导航栏固定高度（px），Openbox margins 与 iconlayer 共享此常量
TOPBAR_HEIGHT = 34

# ---- 虚拟屏固定几何（锁死最小够用分辨率，兼顾视觉识别与低带宽/低内存） ----------
SCREEN_WIDTH = int(os.environ.get("BOTSCREEN_WIDTH", "1280"))
SCREEN_HEIGHT = int(os.environ.get("BOTSCREEN_HEIGHT", "720"))
#: 色深：默认 24 位（亦支持 16 位进一步压缩帧缓冲带宽）。
SCREEN_DEPTH = int(os.environ.get("BOTSCREEN_DEPTH", "24"))
FRAME_RATE = int(os.environ.get("BOTSCREEN_FPS", "10"))
#: 按需增量推流：64×64 脏矩形网格 + 100ms 采样 + 断开 5 秒自动销毁抓屏会话
TILE_SIZE = int(os.environ.get("BOTSCREEN_TILE_SIZE", "64"))
STREAM_INTERVAL_MS = int(os.environ.get("BOTSCREEN_STREAM_MS", "100"))
CAPTURE_IDLE_HIBERNATE = float(os.environ.get("BOTSCREEN_CAPTURE_HIBERNATE", "5.0"))

# ---- 生命周期参数 ------------------------------------------------------------
#: 默认闲置策略：stop（自动保存桌面会话并彻底关闭进程，释放 100% 内存与 CPU）；可选 freeze
IDLE_MODE = os.environ.get("BOTSCREEN_IDLE_MODE", "stop").strip().lower()
IDLE_STOP_SECONDS = float(os.environ.get("BOTSCREEN_IDLE_STOP", "120"))
IDLE_FREEZE_SECONDS = float(os.environ.get("BOTSCREEN_IDLE_FREEZE", str(int(IDLE_STOP_SECONDS))))
LONG_FREEZE_SECONDS = float(os.environ.get("BOTSCREEN_LONG_FREEZE", "300"))
WATCHDOG_INTERVAL = float(os.environ.get("BOTSCREEN_WATCHDOG_INTERVAL", "10"))
#: 冻结后主动向 swap/zram 换出的内存比例（0 = 关闭）。
#: cgroup.freeze 只暂停进程，不会自动换出匿名页；需要 memory.reclaim 触发。
RECLAIM_PCT = int(os.environ.get("BOTSCREEN_RECLAIM_PCT", "60"))
#: 单次回收的内存上限（MB）。没有上限时 200MB+ 的屏会在内核里等很久。
RECLAIM_MAX_MB = int(os.environ.get("BOTSCREEN_RECLAIM_MAX_MB", "96"))

# ---- 启动门禁 ---------------------------------------------------------------
#: 拉起一张屏前要求的最小可用内存（MB）。0 = 关闭门禁。
MIN_FREE_MB = int(os.environ.get("BOTSCREEN_MIN_FREE_MB", "1024"))
#: Xvfb 二进制（默认 PATH 里的；源码编译时用 BOTSCREEN_XVFB_BIN 指定绝对路径）
XVFB_BIN = os.environ.get("BOTSCREEN_XVFB_BIN", "Xvfb")


def _detect_x_backend() -> str:
    raw = os.environ.get("BOTSCREEN_X_BACKEND", "").strip().lower()
    if raw in ("xvfb", "kasmvnc"):
        return raw
    if shutil.which(XVFB_BIN) or os.path.isfile(XVFB_BIN):
        return "xvfb"
    if shutil.which("Xvnc"):
        return "kasmvnc"
    return "xvfb"


#: X server 后端：默认极致轻量纯 Xvfb（无常驻 VNC 编码器）；可选 kasmvnc
X_BACKEND = _detect_x_backend()
#: noVNC 静态前端目录（仅可选外部 VNC 模式使用）
VNC_WEB_DIR = os.environ.get("BOTSCREEN_VNC_WEB", "/usr/share/novnc")
#: x11vnc 按需 RFB 端口基址（5950 + 序号，仅按需拉起 -once 时使用）
RFB_PORT_BASE = int(os.environ.get("BOTSCREEN_RFB_PORT_BASE", "5950"))

#: 窗口管理器：统一轻量 openbox（带完整标题栏与最小化/最大化/关闭按钮 + 顶部 34px 导航栏留白）
WINDOW_MANAGER = os.environ.get("BOTSCREEN_WM", "openbox").strip().lower()
#: 默认开启统一轻量纯 Python 桌面壳（壁纸 + 桌面图标 + 顶部导航/任务栏，零 tint2/xfdesktop 错位）
DESKTOP_SHELL = os.environ.get("BOTSCREEN_DESKTOP", "1") == "1"

#: 人类持有时是否连 Agent 截图一并拒绝（Hermes 的 fail-closed 语义：人可能在输密码）。
SCREENSHOT_FAIL_CLOSED = os.environ.get("BOTSCREEN_SCREENSHOT_FAIL_CLOSED", "1") == "1"
BOOT_TIMEOUT = float(os.environ.get("BOTSCREEN_BOOT_TIMEOUT", "15"))

# ---- 网关自身 ---------------------------------------------------------------
GATEWAY_HOST = os.environ.get("BOTSCREEN_HOST", "127.0.0.1")
GATEWAY_PORT = int(os.environ.get("BOTSCREEN_PORT", "6200"))

# ---- 审计 ------------------------------------------------------------------
AUDIT_ENABLED = os.environ.get("BOTSCREEN_AUDIT", "1") == "1"
THUMB_WIDTH = 320

# 支持 BOTSCREEN_1..n 形式批量登记；默认 bot_01..bot_04
DEFAULT_BOTS = os.environ.get(
    "BOTSCREEN_BOTS", "bot_01,bot_02,bot_03,bot_04"
).split(",")

SLOTS_FILE = os.environ.get("BOTSCREEN_SLOTS_FILE", os.path.join(DATA_ROOT, "slots.json"))


def _legacy_numeric_slot(bot_id: str) -> Optional[int]:
    """仅对纯数字后缀形式（如 bot_01..bot_999）保留原序号，避免影响已有屏。"""
    prefix, _, suffix = bot_id.rpartition("_")
    if prefix == "bot" and suffix.isdigit():
        val = int(suffix)
        if 1 <= val <= 999:
            return val
    return None


class SlotAllocator:
    """持久化 bot_id -> 正整数槽位映射，确保任意 UUID Bot ID 不撞 DISPLAY/端口。"""

    def __init__(self, path: str = SLOTS_FILE) -> None:
        self.path = path
        self._slots: Dict[str, int] = {}
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as fh:
                raw = json.load(fh)
            if isinstance(raw, dict):
                self._slots = {
                    str(k): int(v)
                    for k, v in raw.items()
                    if isinstance(v, int) and 1 <= v <= 999
                }
        except (OSError, json.JSONDecodeError, ValueError):
            self._slots = {}

    def _save(self) -> None:
        directory = os.path.dirname(self.path)
        os.makedirs(directory, exist_ok=True)
        lock_path = self.path + ".lock"
        with open(lock_path, "a+", encoding="utf-8") as lock_fh:
            try:
                fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
            except OSError:
                pass
            fd, tmp = tempfile.mkstemp(dir=directory, prefix=".slots-")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(self._slots, fh, ensure_ascii=False, indent=2)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            finally:
                try:
                    fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass

    def all_slots(self) -> Dict[str, int]:
        return dict(self._slots)

    def allocate(self, bot_id: str) -> int:
        if bot_id in self._slots:
            return self._slots[bot_id]
        used = set(self._slots.values())
        legacy = _legacy_numeric_slot(bot_id)
        if legacy is not None and legacy not in used:
            slot = legacy
        else:
            slot = 1
            while slot in used:
                slot += 1
        self._slots[bot_id] = slot
        try:
            self._save()
        except OSError:
            pass
        return slot

    def release(self, bot_id: str) -> None:
        if bot_id in self._slots:
            self._slots.pop(bot_id, None)
            try:
                self._save()
            except OSError:
                pass


def bot_index(bot_id: str, slot: Optional[int] = None) -> int:
    """优先使用显式分配的槽位；回退支持 bot_01 -> 1。"""
    if slot is not None and slot >= 1:
        return int(slot)
    legacy = _legacy_numeric_slot(bot_id)
    if legacy is not None:
        return legacy
    digits = "".join(ch for ch in bot_id if ch.isdigit())
    return int(digits) if digits and int(digits) <= 999 else 1


def rfb_port_for(bot_id: str, slot: Optional[int] = None) -> int:
    return RFB_PORT_BASE + bot_index(bot_id, slot=slot)


def display_for(bot_id: str, slot: Optional[int] = None) -> int:
    return DISPLAY_BASE + bot_index(bot_id, slot=slot)


def ws_port_for(bot_id: str, slot: Optional[int] = None) -> int:
    return WS_PORT_BASE + bot_index(bot_id, slot=slot)


@dataclass(frozen=True)
class BotPaths:
    """单个 Bot 的目录规范（方案二.2）。"""

    root: str

    @property
    def home(self) -> str:
        return os.path.join(self.root, "home")

    @property
    def downloads(self) -> str:
        return os.path.join(self.root, "downloads")

    @property
    def audit(self) -> str:
        return os.path.join(self.root, "audit")

    @property
    def runtime(self) -> str:
        return os.path.join(self.root, "runtime")

    @property
    def xauthority(self) -> str:
        return os.path.join(self.runtime, "Xauthority")

    @property
    def token_file(self) -> str:
        return os.path.join(self.runtime, "token.json")

    @property
    def lease_file(self) -> str:
        """跨进程可见的控制权租约（落盘 + flock），网关重启后可恢复。"""
        return os.path.join(self.runtime, "lease.json")

    @property
    def session_file(self) -> str:
        """关闭前保存的桌面窗口与应用会话状态（重启虚拟屏时自动还原）。"""
        return os.path.join(self.runtime, "session_state.json")

    @property
    def preview_file(self) -> str:
        """关闭前保存的最后桌面预览图（停止状态下零开销展示上次画面）。"""
        return os.path.join(self.runtime, "last_preview.jpg")

    @property
    def spec_file(self) -> str:
        """当前运行虚拟屏的规格版本标记。"""
        return os.path.join(self.runtime, "desktop_spec.json")

    @property
    def actions_log(self) -> str:
        return os.path.join(self.audit, "actions.jsonl")


def paths_for(bot_id: str) -> BotPaths:
    return BotPaths(root=os.path.join(DATA_ROOT, bot_id))