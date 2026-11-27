"""虚拟屏实例层：统一规格 Xvfb + Openbox + 轻量桌面壳的按需拉起、会话持久化恢复与销毁。"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import signal
import subprocess
import time
from typing import List, Optional

from .audit import Auditor
from .cgroup import CgroupError, CgroupManager
from .config import (
    BOOT_TIMEOUT,
    DESKTOP_SHELL,
    DESKTOP_SPEC_VERSION,
    DOCK_MARGIN_BOTTOM,
    FRAME_RATE,
    IDLE_MODE,
    LONG_FREEZE_SECONDS,
    RECLAIM_MAX_MB,
    RECLAIM_PCT,
    SCREEN_DEPTH,
    SCREEN_HEIGHT,
    SCREEN_WIDTH,
    SHARED_XAUTHORITY,
    TOPBAR_HEIGHT,
    VNC_WEB_DIR,
    WINDOW_MANAGER,
    X_BACKEND,
    XVFB_BIN,
    display_for,
    paths_for,
    rfb_port_for,
    ws_port_for,
)
from .desktop import DesktopShell
from .driver import ScreenDriver
from .resources import MemoryBlocked, require_memory, summarize as memory_summary
from .session import (
    capture_session,
    ensure_chrome_session_prefs,
    graceful_close_apps,
    has_saved_session,
    load_preview_from_disk,
    restore_session,
)
from .state import ScreenLock, State
from .streamer import TileStreamHub

# ---- 统一 Openbox 主题与窗口按钮位图（确保所有宿主机/所有 Bot 标题栏与缩小/放大/关闭按钮完全一致） ----
OPENBOX_THEMERC = """# BotScreen Unified Dark Theme
border.width: 1
padding.width: 6
padding.height: 5
window.handle.width: 4
window.client.padding.width: 0
window.client.padding.height: 0
menu.overlap: 2

window.active.title.bg: flat solid
window.active.title.bg.color: #1c2430
window.active.label.bg: parentrelative
window.active.label.text.color: #e6edf5
window.active.handle.bg: flat solid
window.active.handle.bg.color: #1c2430
window.active.grip.bg: flat solid
window.active.grip.bg.color: #2c3849
window.active.border.color: #364559

window.inactive.title.bg: flat solid
window.inactive.title.bg.color: #131820
window.inactive.label.bg: parentrelative
window.inactive.label.text.color: #8b9bb0
window.inactive.handle.bg: flat solid
window.inactive.handle.bg.color: #131820
window.inactive.grip.bg: flat solid
window.inactive.grip.bg.color: #1e2632
window.inactive.border.color: #25303f

window.active.button.unpressed.bg: flat solid
window.active.button.unpressed.bg.color: #1c2430
window.active.button.unpressed.image.color: #cbd5e1
window.active.button.hover.bg: flat solid
window.active.button.hover.bg.color: #2d3b4e
window.active.button.hover.image.color: #ffffff
window.active.button.pressed.bg: flat solid
window.active.button.pressed.bg.color: #3b4f68
window.active.button.pressed.image.color: #ffffff
window.active.button.disabled.bg: parentrelative
window.active.button.disabled.image.color: #475569
window.active.button.toggled.unpressed.bg: flat solid
window.active.button.toggled.unpressed.bg.color: #1c2430
window.active.button.toggled.unpressed.image.color: #46b39d
window.active.button.toggled.hover.bg: flat solid
window.active.button.toggled.hover.bg.color: #2d3b4e
window.active.button.toggled.hover.image.color: #7ee3cf
window.active.button.toggled.pressed.bg: flat solid
window.active.button.toggled.pressed.bg.color: #3b4f68
window.active.button.toggled.pressed.image.color: #ffffff

window.inactive.button.unpressed.bg: parentrelative
window.inactive.button.unpressed.image.color: #64748b
window.inactive.button.hover.bg: flat solid
window.inactive.button.hover.bg.color: #253040
window.inactive.button.hover.image.color: #cbd5e1
window.inactive.button.pressed.bg: flat solid
window.inactive.button.pressed.bg.color: #334155
window.inactive.button.pressed.image.color: #ffffff
window.inactive.button.disabled.bg: parentrelative
window.inactive.button.disabled.image.color: #334155
window.inactive.button.toggled.unpressed.bg: parentrelative
window.inactive.button.toggled.unpressed.image.color: #64748b

window.label.text.justify: left
menu.title.bg: flat solid
menu.title.bg.color: #1c2430
menu.title.text.color: #e6edf5
menu.items.bg: flat solid
menu.items.bg.color: #151b24
menu.items.text.color: #d7dee4
menu.items.active.bg: flat solid
menu.items.active.bg.color: #293748
menu.items.active.text.color: #ffffff
menu.border.color: #334155
menu.border.width: 1
"""

# 10x10 清晰 XBM 标题栏按钮图标：最小化(—)、最大化(□)、还原(❐)、关闭(×)
OPENBOX_XBMS = {
    "iconify.xbm": (
        "#define iconify_width 10\n#define iconify_height 10\n"
        "static unsigned char iconify_bits[] = {\n"
        "  0x00,0x00, 0x00,0x00, 0x00,0x00, 0x00,0x00, 0x00,0x00,\n"
        "  0x00,0x00, 0xfe,0x01, 0xfe,0x01, 0x00,0x00, 0x00,0x00\n};\n"
    ),
    "max.xbm": (
        "#define max_width 10\n#define max_height 10\n"
        "static unsigned char max_bits[] = {\n"
        "  0x00,0x00, 0xfe,0x01, 0xfe,0x01, 0x02,0x01, 0x02,0x01,\n"
        "  0x02,0x01, 0x02,0x01, 0x02,0x01, 0xfe,0x01, 0x00,0x00\n};\n"
    ),
    "max_toggled.xbm": (
        "#define max_toggled_width 10\n#define max_toggled_height 10\n"
        "static unsigned char max_toggled_bits[] = {\n"
        "  0x00,0x00, 0xf8,0x01, 0x08,0x01, 0xfe,0x01, 0x42,0x01,\n"
        "  0x42,0x01, 0xfe,0x01, 0x42,0x00, 0x7e,0x00, 0x00,0x00\n};\n"
    ),
    "close.xbm": (
        "#define close_width 10\n#define close_height 10\n"
        "static unsigned char close_bits[] = {\n"
        "  0x00,0x00, 0x06,0x01, 0x8e,0x01, 0xdc,0x00, 0x78,0x00,\n"
        "  0x78,0x00, 0xdc,0x00, 0x8e,0x01, 0x06,0x01, 0x00,0x00\n};\n"
    ),
}

OPENBOX_RC = """<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <resistance>
    <strength>8</strength>
    <screen_edge_strength>14</screen_edge_strength>
  </resistance>
  <focus>
    <focusNew>yes</focusNew>
    <followMouse>no</followMouse>
    <focusLast>yes</focusLast>
    <underMouse>no</underMouse>
    <raiseOnFocus>yes</raiseOnFocus>
  </focus>
  <placement>
    <policy>Smart</policy>
    <center>yes</center>
    <monitor>Primary</monitor>
    <primaryMonitor>1</primaryMonitor>
  </placement>
  <theme>
    <name>BotScreen</name>
    <titleLayout>NLIMC</titleLayout>
    <keepBorder>yes</keepBorder>
    <animateIconify>no</animateIconify>
    <font place="ActiveWindow">
      <name>sans</name>
      <size>9</size>
      <weight>bold</weight>
      <slant>normal</slant>
    </font>
    <font place="InactiveWindow">
      <name>sans</name>
      <size>9</size>
      <weight>normal</weight>
      <slant>normal</slant>
    </font>
  </theme>
  <desktops>
    <number>1</number>
    <firstdesk>1</firstdesk>
    <popupTime>0</popupTime>
  </desktops>
  <resize>
    <drawContents>yes</drawContents>
    <popupShow>Nonpixel</popupShow>
  </resize>
  <margins>
    <top>{topbar_height}</top>
    <bottom>{dock_margin}</bottom>
    <left>0</left>
    <right>0</right>
  </margins>
  <keyboard>
    <keybind key="A-F4">
      <action name="Close"/>
    </keybind>
    <keybind key="A-F9">
      <action name="Iconify"/>
    </keybind>
    <keybind key="A-F10">
      <action name="ToggleMaximize"/>
    </keybind>
    <keybind key="A-Tab">
      <action name="NextWindow">
        <finalactions>
          <action name="Focus"/>
          <action name="Raise"/>
          <action name="Unshade"/>
        </finalactions>
      </action>
    </keybind>
  </keyboard>
  <mouse>
    <dragThreshold>4</dragThreshold>
    <doubleClickTime>400</doubleClickTime>
    <context name="Frame">
      <mousebind button="A-Left" action="Press">
        <action name="Focus"/>
        <action name="Raise"/>
      </mousebind>
      <mousebind button="A-Left" action="Drag">
        <action name="Move"/>
      </mousebind>
      <mousebind button="A-Right" action="Drag">
        <action name="Resize"/>
      </mousebind>
    </context>
    <context name="Titlebar">
      <mousebind button="Left" action="Drag">
        <action name="Move"/>
      </mousebind>
      <mousebind button="Left" action="DoubleClick">
        <action name="ToggleMaximize"/>
      </mousebind>
    </context>
    <context name="Titlebar Top Right Bottom Left TLCorner TRCorner BRCorner BLCorner">
      <mousebind button="Left" action="Press">
        <action name="Focus"/>
        <action name="Raise"/>
        <action name="Unshade"/>
      </mousebind>
    </context>
    <context name="Top">
      <mousebind button="Left" action="Drag">
        <action name="Resize"><edge>top</edge></action>
      </mousebind>
    </context>
    <context name="Left">
      <mousebind button="Left" action="Drag">
        <action name="Resize"><edge>left</edge></action>
      </mousebind>
    </context>
    <context name="Right">
      <mousebind button="Left" action="Drag">
        <action name="Resize"><edge>right</edge></action>
      </mousebind>
    </context>
    <context name="Bottom">
      <mousebind button="Left" action="Drag">
        <action name="Resize"><edge>bottom</edge></action>
      </mousebind>
    </context>
    <context name="TRCorner BRCorner TLCorner BLCorner">
      <mousebind button="Left" action="Drag">
        <action name="Resize"/>
      </mousebind>
    </context>
    <context name="Client">
      <mousebind button="Left" action="Press">
        <action name="Focus"/>
        <action name="Raise"/>
      </mousebind>
      <mousebind button="Middle" action="Press">
        <action name="Focus"/>
        <action name="Raise"/>
      </mousebind>
      <mousebind button="Right" action="Press">
        <action name="Focus"/>
        <action name="Raise"/>
      </mousebind>
    </context>
    <context name="Iconify">
      <mousebind button="Left" action="Press">
        <action name="Focus"/>
        <action name="Raise"/>
      </mousebind>
      <mousebind button="Left" action="Click">
        <action name="Iconify"/>
      </mousebind>
    </context>
    <context name="Maximize">
      <mousebind button="Left" action="Press">
        <action name="Focus"/>
        <action name="Raise"/>
      </mousebind>
      <mousebind button="Left" action="Click">
        <action name="ToggleMaximize"/>
      </mousebind>
    </context>
    <context name="Close">
      <mousebind button="Left" action="Press">
        <action name="Focus"/>
        <action name="Raise"/>
      </mousebind>
      <mousebind button="Left" action="Click">
        <action name="Close"/>
      </mousebind>
    </context>
  </mouse>
  <applications>
    <application name="botscreen-topbar">
      <decor>no</decor>
      <layer>above</layer>
      <desktop>all</desktop>
      <skip_taskbar>yes</skip_taskbar>
      <skip_pager>yes</skip_pager>
      <focus>no</focus>
      <position force="yes"><x>0</x><y>0</y></position>
    </application>
    <application name="botscreen-dock">
      <decor>no</decor>
      <layer>below</layer>
      <desktop>all</desktop>
      <skip_taskbar>yes</skip_taskbar>
      <skip_pager>yes</skip_pager>
      <focus>no</focus>
      <position force="yes"><x>center</x><y>-10</y></position>
    </application>
    <application name="botscreen-desktop">
      <decor>no</decor>
      <layer>below</layer>
      <desktop>all</desktop>
      <skip_taskbar>yes</skip_taskbar>
      <skip_pager>yes</skip_pager>
      <position force="yes"><x>0</x><y>0</y></position>
    </application>
    <application type="normal">
      <decor>yes</decor>
    </application>
  </applications>
</openbox_config>
"""

KASMVNC_YAML = """network:
  protocol: http
  interface: 127.0.0.1
  websocket_port: auto
  ssl:
    require_ssl: false
desktop:
  resolution:
    width: {width}
    height: {height}
  allow_resize: false
  pixel_depth: {depth}
security:
  brute_force_protection:
    blacklist_threshold: 0
encoding:
  max_frame_rate: {fps}
  rect_encoding_mode:
    min_quality: 7
user_session:
  idle_timeout: never
"""


class ScreenWorker:
    """一张虚拟屏的全部运行时状态。"""

    def __init__(self, bot_id: str, slot: Optional[int] = None) -> None:
        self.bot_id = bot_id
        self.slot = slot
        self.paths = paths_for(bot_id)
        self.display = display_for(bot_id, slot=slot)
        self.ws_port = ws_port_for(bot_id, slot=slot)
        self.rfb_port = rfb_port_for(bot_id, slot=slot)
        self._vnc_procs: List[subprocess.Popen] = []
        self.lock = ScreenLock(bot_id, lease_path=self.paths.lease_file)
        self.cg = CgroupManager()
        self.driver = ScreenDriver(bot_id, self.display, self.paths)
        self.auditor = Auditor(bot_id, self.paths)
        self.streamer = TileStreamHub(self)
        self.desktop = DesktopShell(
            bot_id,
            self.paths,
            os.path.join(os.path.dirname(__file__), "desktop", "assets"),
            self.display,
        )
        self._xvnc: Optional[subprocess.Popen] = None
        self._openbox: Optional[subprocess.Popen] = None
        self._apps: List[subprocess.Popen] = []
        self._adopted_xvnc: Optional[int] = None
        self._adopted_openbox: Optional[int] = None
        self._started_at: Optional[float] = None
        self._last_error: Optional[str] = None
        self._token: Optional[str] = None
        self.last_preview: Optional[bytes] = None
        self.last_preview_at: Optional[float] = None
        self._lifecycle_lock: Optional[asyncio.Lock] = None

    @property
    def lifecycle_lock(self) -> asyncio.Lock:
        if self._lifecycle_lock is None:
            self._lifecycle_lock = asyncio.Lock()
        return self._lifecycle_lock

    # ---- 目录与统一规格配置 -------------------------------------------------
    def prepare(self) -> None:
        theme_dir = os.path.join(self.paths.home, ".themes", "BotScreen", "openbox-3")
        for d in (
            self.paths.root,
            self.paths.home,
            self.paths.downloads,
            self.paths.audit,
            self.paths.runtime,
            os.path.join(self.paths.home, ".vnc"),
            os.path.join(self.paths.home, ".config", "openbox"),
            os.path.join(self.paths.runtime, "openbox"),
            os.path.join(self.paths.home, "Desktop"),
            theme_dir,
        ):
            os.makedirs(d, exist_ok=True)
        with open(os.path.join(theme_dir, "themerc"), "w", encoding="utf-8") as fh:
            fh.write(OPENBOX_THEMERC)
        for fname, content in OPENBOX_XBMS.items():
            with open(os.path.join(theme_dir, fname), "w", encoding="utf-8") as fh:
                fh.write(content)
        with open(os.path.join(self.paths.home, ".vnc", "kasmvnc.yaml"), "w", encoding="utf-8") as fh:
            fh.write(
                KASMVNC_YAML.format(
                    width=SCREEN_WIDTH,
                    height=SCREEN_HEIGHT,
                    depth=SCREEN_DEPTH,
                    fps=FRAME_RATE,
                )
            )
        rc_text = OPENBOX_RC.format(
            topbar_height=TOPBAR_HEIGHT if DESKTOP_SHELL else 0,
            dock_margin=DOCK_MARGIN_BOTTOM if DESKTOP_SHELL else 0,
        )
        with open(os.path.join(self.paths.runtime, "openbox", "rc.xml"), "w", encoding="utf-8") as fh:
            fh.write(rc_text)
        with open(os.path.join(self.paths.home, ".config", "openbox", "rc.xml"), "w", encoding="utf-8") as fh:
            fh.write(rc_text)
        self._ensure_xauth()
        _ = self.token

    def _write_spec_marker(self) -> None:
        payload = {
            "spec_version": DESKTOP_SPEC_VERSION,
            "x_backend": X_BACKEND,
            "wm": WINDOW_MANAGER,
            "desktop_shell": DESKTOP_SHELL,
            "width": SCREEN_WIDTH,
            "height": SCREEN_HEIGHT,
            "depth": SCREEN_DEPTH,
            "topbar_height": TOPBAR_HEIGHT if DESKTOP_SHELL else 0,
            "updated_at": time.time(),
        }
        try:
            with open(self.paths.spec_file, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2)
        except OSError:
            pass

    def spec_mismatch(self) -> bool:
        """检查已接管的旧虚拟屏是否与当前统一桌面规格不一致。"""
        try:
            with open(self.paths.spec_file, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return True
        if not isinstance(data, dict):
            return True
        return (
            int(data.get("spec_version") or 0) != DESKTOP_SPEC_VERSION
            or data.get("x_backend") != X_BACKEND
            or data.get("wm") != WINDOW_MANAGER
            or bool(data.get("desktop_shell")) != bool(DESKTOP_SHELL)
            or int(data.get("width") or 0) != SCREEN_WIDTH
            or int(data.get("height") or 0) != SCREEN_HEIGHT
        )

    def _ensure_xauth(self) -> None:
        """在共享 Xauthority 中登记本屏 cookie（幂等）。"""
        os.makedirs(os.path.dirname(SHARED_XAUTHORITY), exist_ok=True)
        probe = subprocess.run(
            ["xauth", "-f", SHARED_XAUTHORITY, "list", f":{self.display}"],
            capture_output=True,
            text=True,
            check=False,
        )
        if probe.stdout.strip():
            return
        cookie = secrets.token_hex(16)
        subprocess.run(
            ["xauth", "-f", SHARED_XAUTHORITY, "add", f":{self.display}", ".", cookie],
            check=True,
            capture_output=True,
        )

    # ---- token ------------------------------------------------------------
    @property
    def token(self) -> str:
        if self._token:
            return self._token
        try:
            with open(self.paths.token_file) as fh:
                self._token = json.load(fh)["token"]
        except (OSError, KeyError, json.JSONDecodeError):
            self._token = self._rotate_token()
        return self._token

    def _rotate_token(self) -> str:
        token = secrets.token_urlsafe(24)
        os.makedirs(self.paths.runtime, exist_ok=True)
        with open(self.paths.token_file, "w") as fh:
            json.dump({"token": token, "rotated_at": time.time()}, fh)
        os.chmod(self.paths.token_file, 0o600)
        self._token = token
        return token

    def rotate_token(self) -> str:
        return self._rotate_token()

    def load_cached_preview(self) -> Optional[bytes]:
        if self.last_preview:
            return self.last_preview
        disk = load_preview_from_disk(self.paths.preview_file)
        if disk:
            self.last_preview = disk
        return disk

    # ---- 启动 / 接管 -------------------------------------------------------
    def _alive(self, proc: Optional[subprocess.Popen]) -> bool:
        return proc is not None and proc.poll() is None

    @staticmethod
    def _pid_alive(pid: Optional[int]) -> bool:
        if not pid:
            return False
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def healthy(self) -> bool:
        if self._alive(self._xvnc):
            return True
        if self._pid_alive(self._adopted_xvnc):
            return True
        return False

    def _find_pids(self, marker: str, extra: str = "") -> List[int]:
        """按 cmdline 查找本屏的 Xvfb / Xvnc / openbox 进程。"""
        found: List[int] = []
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as fh:
                    argv = [a.decode(errors="ignore") for a in fh.read().split(b"\x00") if a]
            except OSError:
                continue
            if not argv:
                continue
            joined = " ".join(argv)
            if marker in argv and (not extra or extra in joined):
                found.append(pid)
        return found

    def attach(self) -> bool:
        """接管网关重启前就已存在的屏（进程树仍在原 cgroup 中）。"""
        socket_path = f"/tmp/.X11-unix/X{self.display}"
        if not os.path.exists(socket_path):
            return False
        pids = self._find_pids(f":{self.display}")
        if not pids:
            return False
        if not self._pid_alive(self._adopted_xvnc) or self._adopted_xvnc not in pids:
            self._adopted_xvnc = pids[0]
        ob = self._find_pids(os.path.join(self.paths.runtime, "openbox", "rc.xml"))
        if ob and self._pid_alive(ob[0]):
            self._adopted_openbox = ob[0]
        else:
            display_tag = f"DISPLAY=:{self.display}".encode()
            for entry in os.listdir("/proc"):
                if not entry.isdigit():
                    continue
                pid = int(entry)
                try:
                    with open(f"/proc/{pid}/comm", "rb") as fh:
                        if fh.read().strip() != b"xfwm4":
                            continue
                    with open(f"/proc/{pid}/environ", "rb") as fh:
                        if display_tag in fh.read().split(b"\x00"):
                            self._adopted_openbox = pid
                            break
                except OSError:
                    continue
        self.driver.reset_grabber()
        frozen = False
        try:
            frozen = self.cg.is_frozen(self.bot_id)
        except CgroupError:
            frozen = False
        if DESKTOP_SHELL and not frozen and not self.desktop.snapshot()["started"] and not self.spec_mismatch():
            try:
                self.desktop.start(lambda pid: self.cg.reap(self.bot_id, pid))
            except Exception:  # noqa: BLE001
                pass
        self.lock.restore_from_disk()
        if self.lock.state is State.HUMAN_TAKEOVER:
            pass
        elif self.lock.state in (State.STOPPED, State.STARTING):
            self.lock.mark_active("adopted")
        if frozen:
            self.lock.mark_frozen()
        return True

    async def start(self, apps: Optional[List[List[str]]] = None, restore: bool = True) -> dict:
        async with self.lifecycle_lock:
            return await self._start_unlocked(apps=apps, restore=restore)

    async def _start_unlocked(self, apps: Optional[List[List[str]]] = None, restore: bool = True) -> dict:
        if not self.healthy():
            await asyncio.to_thread(self.attach)
        if self.healthy():
            if self.spec_mismatch():
                # 发现旧规格进程（如历史 Xvnc/无按钮 Openbox），先保存窗口现场并重启为统一规格
                await self._stop_unlocked(save_session=True)
            else:
                await self.thaw()
                return self.status()
        try:
            require_memory()
        except MemoryBlocked as exc:
            self._last_error = str(exc)
            raise
        await self.lock.begin_start()
        self.prepare()
        self.cg.ensure_root()
        self.cg.ensure_bot(self.bot_id)
        try:
            if X_BACKEND == "xvfb":
                await asyncio.to_thread(self._spawn_xvfb)
            else:
                await asyncio.to_thread(self._spawn_xvnc)
            await self._wait_ready()
            await asyncio.to_thread(self._spawn_wm)
            if DESKTOP_SHELL:
                await asyncio.to_thread(
                    self.desktop.start,
                    lambda pid: self.cg.reap(self.bot_id, pid),
                )
            self._write_spec_marker()
            if restore:
                await asyncio.to_thread(restore_session, self)
            if apps:
                for argv in apps:
                    await asyncio.to_thread(self._spawn_app, argv)
            self.lock.mark_active("ready")
            self._started_at = time.time()
            self._last_error = None
        except Exception as exc:  # noqa: BLE001
            self._last_error = str(exc)
            self.lock.mark_stopped("start failed")
            await self._stop_unlocked(save_session=False)
            raise
        return self.status()

    def _reap_stale_display(self) -> None:
        """清理上一轮遗留的 :N X server / 推流进程与锁文件，避免端口或 DISPLAY 冲突。"""
        marker = f":{self.display}"
        ws_marker = str(self.ws_port)
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            if pid == os.getpid():
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as fh:
                    argv = fh.read().split(b"\x00")
            except OSError:
                continue
            names = [a.decode(errors="ignore") for a in argv if a]
            if not names:
                continue
            exe = os.path.basename(names[0])
            is_x_server = ("Xvnc" in exe or exe == "Xvfb") and marker in names
            is_x11vnc = exe == "x11vnc" and marker in names
            is_ws = "websockify" in exe and ws_marker in names
            if is_x_server or is_x11vnc or is_ws:
                if self._xvnc is not None and pid == self._xvnc.pid:
                    continue
                if pid == self._adopted_xvnc:
                    continue
                if self._xvnc is not None and pid in self.cg.pids(self.bot_id):
                    continue
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
        for path in (f"/tmp/.X{self.display}-lock", f"/tmp/.X11-unix/X{self.display}"):
            try:
                os.unlink(path)
            except OSError:
                pass

    def _spawn_xvfb(self) -> None:
        """极致轻量纯内存帧缓冲 Xvfb，平时不启动任何常驻 VNC / 视频编码进程。"""
        env = dict(os.environ)
        env.update(
            HOME=self.paths.home,
            XAUTHORITY=SHARED_XAUTHORITY,
            DISPLAY=f":{self.display}",
        )
        argv = [
            XVFB_BIN,
            f":{self.display}",
            "-screen", "0", f"{SCREEN_WIDTH}x{SCREEN_HEIGHT}x{SCREEN_DEPTH}",
            "-nolisten", "tcp",
            "-auth", SHARED_XAUTHORITY,
            "-dpi", "96",
            "+extension", "MIT-SHM",
            "+extension", "XTEST",
        ]
        self._reap_stale_display()
        with open(os.path.join(self.paths.runtime, "xvfb.log"), "ab", buffering=0) as log:
            self._xvnc = subprocess.Popen(
                argv, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
            )
        self.cg.reap(self.bot_id, self._xvnc.pid)
        if os.environ.get("BOTSCREEN_ENABLE_VNC", "0") == "1" and shutil.which("x11vnc") and shutil.which("websockify"):
            with open(os.path.join(self.paths.runtime, "x11vnc.log"), "ab", buffering=0) as vnc_log:
                self._vnc_procs.append(subprocess.Popen(
                    ["x11vnc", "-display", f":{self.display}", "-rfbport", str(self.rfb_port),
                     "-localhost", "-forever", "-shared", "-nopw", "-quiet", "-noxdamage",
                     "-repeat", "-cursor", "arrow"],
                    env=env, stdout=vnc_log, stderr=subprocess.STDOUT, start_new_session=True,
                ))
            with open(os.path.join(self.paths.runtime, "websockify.log"), "ab", buffering=0) as ws_log:
                self._vnc_procs.append(subprocess.Popen(
                    ["websockify", "--web", VNC_WEB_DIR, str(self.ws_port), f"localhost:{self.rfb_port}"],
                    env=env, stdout=ws_log, stderr=subprocess.STDOUT, start_new_session=True,
                ))
        self._last_error = None

    def _spawn_xvnc(self) -> None:
        env = dict(os.environ)
        env.update(
            HOME=self.paths.home,
            XAUTHORITY=SHARED_XAUTHORITY,
            DISPLAY=f":{self.display}",
        )
        argv = [
            "Xvnc",
            f":{self.display}",
            "-geometry", f"{SCREEN_WIDTH}x{SCREEN_HEIGHT}",
            "-depth", str(SCREEN_DEPTH),
            "-interface", "127.0.0.1",
            "-websocketPort", str(self.ws_port),
            "-FrameRate", str(FRAME_RATE),
            "-DynamicQualityMin", "7",
            "-SecurityTypes", "None",
            "-DisableBasicAuth=1",
            "-sslOnly", "0",
            "-auth", SHARED_XAUTHORITY,
        ]
        self._reap_stale_display()
        with open(os.path.join(self.paths.runtime, "xvnc.log"), "ab", buffering=0) as log:
            self._xvnc = subprocess.Popen(
                argv, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
            )
        self.cg.reap(self.bot_id, self._xvnc.pid)

    def _spawn_wm(self) -> None:
        """统一窗口管理器：默认带完整标题栏与最小化/最大化/关闭按钮的 Openbox。"""
        wm = (WINDOW_MANAGER or "openbox").strip().lower()
        if wm in ("none", "off", "0", "false"):
            return
        if wm == "openbox":
            if shutil.which("openbox"):
                return self._spawn_openbox()
            if shutil.which("xfwm4"):
                wm = "xfwm4"
            else:
                return
        env = dict(os.environ)
        env.update(
            HOME=self.paths.home,
            XAUTHORITY=SHARED_XAUTHORITY,
            DISPLAY=f":{self.display}",
            XDG_CONFIG_HOME=os.path.join(self.paths.home, ".config"),
            XDG_CACHE_HOME=os.path.join(self.paths.home, ".cache"),
            XDG_DATA_HOME=os.path.join(self.paths.home, ".local", "share"),
        )
        if wm == "fluxbox" and shutil.which("fluxbox"):
            with open(os.path.join(self.paths.runtime, "fluxbox.log"), "ab", buffering=0) as log:
                self._openbox = subprocess.Popen(
                    ["fluxbox"], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
                )
            self.cg.reap(self.bot_id, self._openbox.pid)
            return
        if shutil.which("xfwm4"):
            with open(os.path.join(self.paths.runtime, "xfwm4.log"), "ab", buffering=0) as log:
                self._openbox = subprocess.Popen(
                    ["xfwm4", "--compositor=off"],
                    env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                )
            self.cg.reap(self.bot_id, self._openbox.pid)
            return
        if shutil.which("openbox"):
            self._spawn_openbox()

    def _spawn_openbox(self) -> None:
        env = dict(os.environ)
        env.update(
            HOME=self.paths.home,
            XAUTHORITY=SHARED_XAUTHORITY,
            DISPLAY=f":{self.display}",
            XDG_CONFIG_HOME=os.path.join(self.paths.home, ".config"),
            XDG_DATA_HOME=os.path.join(self.paths.home, ".local", "share"),
        )
        with open(os.path.join(self.paths.runtime, "openbox.log"), "ab", buffering=0) as log:
            self._openbox = subprocess.Popen(
                ["openbox", "--config-file", os.path.join(self.paths.runtime, "openbox", "rc.xml")],
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        self.cg.reap(self.bot_id, self._openbox.pid)
        # 等待 Openbox 注册 _NET_SUPPORTING_WM_CHECK，避免后续窗口在 WM 就绪前映射导致无标题栏
        deadline = time.time() + 2.5
        while time.time() < deadline:
            if self._openbox.poll() is not None:
                break
            probe = subprocess.run(
                ["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            if "window id #" in probe.stdout:
                break
            time.sleep(0.08)

    def _spawn_app(self, argv: List[str], cwd: Optional[str] = None) -> int:
        env = dict(os.environ)
        env.update(
            HOME=self.paths.home,
            XAUTHORITY=SHARED_XAUTHORITY,
            DISPLAY=f":{self.display}",
            XDG_CONFIG_HOME=os.path.join(self.paths.home, ".config"),
            XDG_DATA_HOME=os.path.join(self.paths.home, ".local", "share"),
            XDG_CACHE_HOME=os.path.join(self.paths.home, ".cache"),
        )
        run_cwd = cwd if (cwd and os.path.isdir(cwd)) else self.paths.home
        with open(os.path.join(self.paths.runtime, "apps.log"), "ab", buffering=0) as log:
            proc = subprocess.Popen(
                argv,
                env=env,
                cwd=run_cwd,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        self._apps.append(proc)
        try:
            self.cg.reap(self.bot_id, proc.pid)
        except CgroupError:
            pass
        return proc.pid

    def open_app(
        self,
        app: str = "chrome",
        url: Optional[str] = None,
        cwd: Optional[str] = None,
        path: Optional[str] = None,
    ) -> dict:
        """在虚拟屏内拉起常用应用（隔离 HOME 与 Chrome Profile，严格位于顶部导航栏下方）。"""
        kind = (app or "chrome").strip().lower()
        top_offset = TOPBAR_HEIGHT + 12 if DESKTOP_SHELL else 0
        bottom_pad = DOCK_MARGIN_BOTTOM + 8 if DESKTOP_SHELL else 0
        win_w = SCREEN_WIDTH - 80 if DESKTOP_SHELL else SCREEN_WIDTH
        win_h = max(360, SCREEN_HEIGHT - top_offset - bottom_pad) if DESKTOP_SHELL else SCREEN_HEIGHT
        if kind in ("chrome", "browser"):
            exe = next(
                (shutil.which(n) for n in ("google-chrome", "chromium", "chromium-browser") if shutil.which(n)),
                None,
            )
            if not exe:
                raise RuntimeError("未找到 google-chrome / chromium 可执行文件")
            ensure_chrome_session_prefs(self.paths.home, mark_clean_exit=False)
            argv = [
                exe,
                "--no-sandbox",
                "--disable-gpu",
                "--no-first-run",
                "--disable-dev-shm-usage",
                f"--user-data-dir={os.path.join(self.paths.home, '.config', 'google-chrome')}",
                f"--window-position=40,{top_offset}",
                f"--window-size={win_w},{win_h}",
            ]
            if url:
                argv.append(url)
        elif kind in ("terminal", "xterm", "shell"):
            xfce_term = shutil.which("xfce4-terminal")
            if xfce_term:
                argv = [xfce_term, "--geometry=110x28"]
                if cwd and os.path.isdir(cwd):
                    argv.append(f"--working-directory={cwd}")
            else:
                exe = shutil.which("xterm") or shutil.which("x-terminal-emulator")
                if not exe:
                    raise RuntimeError("未找到终端可执行文件")
                argv = [exe, "-fa", "Monospace", "-fs", "11", f"-geometry", f"110x28+60+{top_offset + 8}"]
        elif kind in ("files", "pcmanfm", "thunar"):
            exe = next((shutil.which(n) for n in ("pcmanfm", "thunar", "nautilus", "nemo") if shutil.which(n)), None)
            if not exe:
                raise RuntimeError("未找到文件管理器（pcmanfm / thunar）")
            target = path if (path and (os.path.isdir(path) or path.startswith("trash://"))) else self.paths.home
            argv = [exe, target]
        else:
            raise ValueError(f"不支持的应用类型: {app}")
        pid = self._spawn_app(argv, cwd=cwd)
        return {"ok": True, "app": kind, "pid": pid, "url": url}

    async def _wait_ready(self) -> None:
        socket_path = f"/tmp/.X11-unix/X{self.display}"
        deadline = time.time() + BOOT_TIMEOUT
        while time.time() < deadline:
            if not self.healthy():
                raise RuntimeError(f"X server exited early, see {self.paths.runtime}/xvfb.log")
            if os.path.exists(socket_path):
                try:
                    await asyncio.to_thread(
                        subprocess.run,
                        ["xdotool", "getdisplaygeometry"],
                        env=self.driver.env,
                        capture_output=True,
                        timeout=3,
                        check=True,
                    )
                    self.driver.reset_grabber()
                    return
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    pass
            await asyncio.sleep(0.15)
        raise RuntimeError(f"display :{self.display} not ready in {BOOT_TIMEOUT}s")

    # ---- 冻结 / 唤醒 / 按需拉起 -------------------------------------------
    async def freeze(self) -> dict:
        if not self.healthy():
            return self.status()
        if self.lock.state in (State.HUMAN_TAKEOVER, State.NEED_HUMAN):
            return self.status()
        await asyncio.to_thread(self.driver.close_capture)
        already = self.cg.is_frozen(self.bot_id)
        if not already:
            await asyncio.to_thread(self.cg.freeze, self.bot_id, True)
        self.lock.mark_frozen()
        if RECLAIM_PCT > 0 and not already:
            current_mem = self.cg.memory_current(self.bot_id)
            if current_mem >= 32 * 1024 * 1024:
                budget = min(
                    int(current_mem * RECLAIM_PCT / 100),
                    RECLAIM_MAX_MB * 1024 * 1024,
                )
                self.cg.reclaim_async(self.bot_id, budget)
        return self.status()

    async def thaw(self) -> dict:
        if not self.healthy():
            return self.status()
        was_frozen = self.cg.is_frozen(self.bot_id)
        long_flag = was_frozen and self.lock.long_freeze(LONG_FREEZE_SECONDS)
        if was_frozen:
            await asyncio.to_thread(self.cg.freeze, self.bot_id, False)
            self.driver.reset_grabber()
        self.lock.mark_thawed()
        st = self.status()
        st["resumed_from_long_freeze"] = bool(long_flag)
        return st

    async def ensure_awake(self) -> dict:
        async with self.lifecycle_lock:
            if not self.healthy() or self.spec_mismatch():
                st = await self._start_unlocked(restore=True)
                st["resumed_from_long_freeze"] = False
                return st
            st = await self.thaw()
            return st

    # ---- 停止与销毁（默认先保存桌面全部窗口现场与预览，再彻底释放内存与 CPU） ----
    def _kill(self, proc: Optional[subprocess.Popen]) -> None:
        if proc is None or proc.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except OSError:
            proc.terminate()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except OSError:
                proc.kill()

    async def stop(self, save_session: bool = True) -> dict:
        async with self.lifecycle_lock:
            return await self._stop_unlocked(save_session=save_session)

    async def _stop_unlocked(self, save_session: bool = True) -> dict:
        await self.streamer.shutdown()
        if save_session and self.healthy():
            await asyncio.to_thread(self._save_and_graceful_close)
        await asyncio.to_thread(self._stop_sync)
        self.lock.mark_stopped("stop")
        return self.status()

    def _save_and_graceful_close(self) -> None:
        """关闭前若处于冻结态先临时解冻，采集窗口现场 + 预览图，优雅退出 Chrome/应用确保标签页完整落盘。"""
        try:
            if self.cg.is_frozen(self.bot_id):
                self.cg.freeze(self.bot_id, False)
                self.driver.reset_grabber()
        except CgroupError:
            pass
        try:
            snap = capture_session(
                self.display,
                self.paths.home,
                self.paths.session_file,
                self.paths.preview_file,
                driver=self.driver,
            )
            if snap.get("preview_bytes"):
                self.last_preview = snap["preview_bytes"]
                self.last_preview_at = time.time()
        except Exception:  # noqa: BLE001
            pass
        try:
            graceful_close_apps(self.display, self.paths.home, timeout=3.0)
        except Exception:  # noqa: BLE001
            pass

    def _stop_sync(self) -> None:
        # 必须在终止 Xvfb/Xvnc 之前释放所有 libX11/XShm 连接，否则 XSync/XCloseDisplay 遇到已断连的
        # X server 会触发 libX11 默认 IOErrorHandler 直接 exit(1) 杀死整个网关进程！
        self.driver.reset_grabber()
        try:
            self.cg.freeze(self.bot_id, False)
        except CgroupError:
            pass
        for proc in reversed(self._vnc_procs):
            self._kill(proc)
        self._vnc_procs.clear()
        try:
            self.desktop.stop()
        except Exception:  # noqa: BLE001
            pass
        for proc in reversed(self._apps):
            self._kill(proc)
        self._apps.clear()
        self._kill(self._openbox)
        self._kill(self._xvnc)
        for pid in (self._adopted_openbox, self._adopted_xvnc):
            if self._pid_alive(pid):
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
        # 彻底清理残留于该 display / cgroup 中的所有进程，保证内存与 CPU 归零
        try:
            leftover = self.cg.pids(self.bot_id)
        except CgroupError:
            leftover = []
        for pid in leftover:
            if pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
        if leftover:
            time.sleep(0.25)
            try:
                still = self.cg.pids(self.bot_id)
            except CgroupError:
                still = []
            for pid in still:
                if pid != os.getpid():
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except OSError:
                        pass
        self._openbox = None
        self._xvnc = None
        self._adopted_openbox = None
        self._adopted_xvnc = None
        self._reap_stale_display()
        for path in (f"/tmp/.X{self.display}-lock", f"/tmp/.X11-unix/X{self.display}"):
            try:
                os.unlink(path)
            except OSError:
                pass
        try:
            self.cg.destroy(self.bot_id)
        except CgroupError:
            pass
        self.driver.reset_grabber()
        self._started_at = None

    # ---- 观测 -------------------------------------------------------------
    def status(self) -> dict:
        st = self.lock.snapshot()
        mem = 0
        pids: List[int] = []
        frozen = False
        try:
            mem = self.cg.memory_current(self.bot_id)
            pids = self.cg.pids(self.bot_id)
            frozen = self.cg.is_frozen(self.bot_id)
        except CgroupError:
            pass
        st.update(
            {
                "bot_id": self.bot_id,
                "display": f":{self.display}",
                "ws_port": self.ws_port,
                "rfb_port": self.rfb_port if X_BACKEND == "xvfb" else None,
                "x_backend": X_BACKEND,
                "wm": WINDOW_MANAGER,
                "width": SCREEN_WIDTH,
                "height": SCREEN_HEIGHT,
                "depth": SCREEN_DEPTH,
                "topbar_height": TOPBAR_HEIGHT if DESKTOP_SHELL else 0,
                "desktop_spec_version": DESKTOP_SPEC_VERSION,
                "idle_mode": IDLE_MODE,
                "has_saved_session": has_saved_session(self.paths.session_file),
                "has_cached_preview": bool(self.last_preview or os.path.isfile(self.paths.preview_file)),
                "healthy": self.healthy(),
                "cgroup_frozen": frozen,
                "pids": pids,
                "memory_bytes": mem,
                "stream": {
                    "subscribers": self.streamer.active_subscribers,
                    "capture_active": self.streamer.capture_active,
                },
                "uptime": None if not self._started_at else round(time.time() - self._started_at, 1),
                "last_error": self._last_error,
                "memory_gate": memory_summary(),
                "desktop": self.desktop.snapshot() if DESKTOP_SHELL else None,
                "paths": {
                    "root": self.paths.root,
                    "downloads": self.paths.downloads,
                    "audit": self.paths.audit,
                },
            }
        )
        return st

    def heal_desktop(self) -> list:
        """watchdog 调用：补齐桌面上已经退出的组件。"""
        if not DESKTOP_SHELL:
            return []
        try:
            return self.desktop.ensure_running(lambda pid: self.cg.reap(self.bot_id, pid))
        except Exception:  # noqa: BLE001
            return []

    def purge(self) -> None:
        """彻底销毁（停止 + 删除数据目录）。"""
        self._stop_sync()
        shutil.rmtree(self.paths.root, ignore_errors=True)
        self.lock.mark_stopped("purge")
