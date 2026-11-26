"""虚拟屏实例层：KasmVNC + Openbox 的拉起、冻结、唤醒、销毁（方案四.1/四.2）。"""
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
from .desktop import DesktopShell
from .resources import MemoryBlocked, require_memory, summarize as memory_summary
from .cgroup import CgroupError, CgroupManager
from .config import (
    DESKTOP_SHELL,
    RECLAIM_MAX_MB,
    RECLAIM_PCT,
    SHARED_XAUTHORITY,
    BOOT_TIMEOUT,
    FRAME_RATE,
    LONG_FREEZE_SECONDS,
    SCREEN_DEPTH,
    SCREEN_HEIGHT,
    SCREEN_WIDTH,
    display_for,
    paths_for,
    WINDOW_MANAGER,
    X_BACKEND,
    VNC_WEB_DIR,
    XVFB_BIN,
    rfb_port_for,
    ws_port_for,
)
from .driver import ScreenDriver
from .state import ScreenLock, State
from .streamer import TileStreamHub

OPENBOX_RC = """<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <theme>
    <name>Clearlooks</name>
    <titleLayout></titleLayout>
    <keepBorder>no</keepBorder>
    <animateIconify>no</animateIconify>
  </theme>
  <desktops>
    <number>1</number>
    <popupTime>0</popupTime>
  </desktops>
  <resize>
    <drawContents>no</drawContents>
    <popupShow>Never</popupShow>
  </resize>
  <applications>
    <application class="*">
      <decor>no</decor>
      <maximized>yes</maximized>
      <position force="yes"><x>0</x><y>0</y></position>
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
            bot_id, self.paths,
            os.path.join(os.path.dirname(__file__), "desktop", "assets"),
            self.display,
        )
        self._xvnc: Optional[subprocess.Popen] = None
        self._openbox: Optional[subprocess.Popen] = None
        self._apps: List[subprocess.Popen] = []
        # 网关重启后接管的既有进程（无 Popen 句柄，只能按 pid 管理）
        self._adopted_xvnc: Optional[int] = None
        self._adopted_openbox: Optional[int] = None
        self._started_at: Optional[float] = None
        self._last_error: Optional[str] = None
        self._token: Optional[str] = None
        self.last_preview: Optional[bytes] = None
        self.last_preview_at: Optional[float] = None

    # ---- 目录与配置 -------------------------------------------------------
    def prepare(self) -> None:
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
        ):
            os.makedirs(d, exist_ok=True)
        with open(os.path.join(self.paths.home, ".vnc", "kasmvnc.yaml"), "w") as fh:
            fh.write(
                KASMVNC_YAML.format(
                    width=SCREEN_WIDTH,
                    height=SCREEN_HEIGHT,
                    depth=SCREEN_DEPTH,
                    fps=FRAME_RATE,
                )
            )
        with open(os.path.join(self.paths.runtime, "openbox", "rc.xml"), "w") as fh:
            fh.write(OPENBOX_RC)
        self._ensure_xauth()
        # 启动即生成 Agent Token，便于外部进程（MCP server / Agent 运行时）读取
        _ = self.token

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

    # ---- 启动 -------------------------------------------------------------
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
            self._xvnc_failed = False
            return True
        return False

    def _find_pids(self, marker: str, extra: str = "") -> List[int]:
        """按 cmdline 查找本屏的 Xvnc / openbox 进程。"""
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
        ob = self._find_pids(
            os.path.join(self.paths.runtime, "openbox", "rc.xml")
        )
        if ob and self._pid_alive(ob[0]):
            self._adopted_openbox = ob[0]
        else:
            # 兼容 xfwm4 窗口管理器接管
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
        # 网关重启后接管的屏：仅在未冻结时补齐桌面壳（冻结态下 X server 被内核暂停，不可连 X）
        if DESKTOP_SHELL and not frozen and not self.desktop.snapshot()["started"]:
            try:
                self.desktop.start(lambda pid: self.cg.reap(self.bot_id, pid))
            except Exception:  # noqa: BLE001
                pass
        # 先按磁盘租约恢复控制权（人类持有 / 文件损坏 → fail-closed），再决定状态
        restored = self.lock.restore_from_disk()
        if self.lock.state is State.HUMAN_TAKEOVER:
            pass  # 人类持有：保持接管态，等 release
        elif self.lock.state in (State.STOPPED, State.STARTING):
            self.lock.mark_active("adopted")
        if frozen:
            self.lock.mark_frozen()
        return True

    async def start(self, apps: Optional[List[List[str]]] = None) -> dict:
        if not self.healthy():
            await asyncio.to_thread(self.attach)
        if self.healthy():
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
            if apps:
                for argv in apps:
                    await asyncio.to_thread(self._spawn_app, argv)
            self.lock.mark_active("ready")
            self._started_at = time.time()
            self._last_error = None
        except Exception as exc:  # noqa: BLE001
            self._last_error = str(exc)
            self.lock.mark_stopped("start failed")
            await self.stop()
            raise
        return self.status()

    def _reap_stale_display(self) -> None:
        """清理上一轮遗留的 :N X server / 推流进程与锁文件，避免 "Server is already active" 或端口占用。"""
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
        # 仅当显式开启 BOTSCREEN_ENABLE_VNC=1 且工具已安装时，才附带启动 x11vnc/websockify
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
            "-geometry",
            f"{SCREEN_WIDTH}x{SCREEN_HEIGHT}",
            "-depth",
            str(SCREEN_DEPTH),
            "-interface",
            "127.0.0.1",
            "-websocketPort",
            str(self.ws_port),
            "-FrameRate",
            str(FRAME_RATE),
            "-DynamicQualityMin",
            "7",
            "-SecurityTypes",
            "None",
            "-DisableBasicAuth=1",
            "-sslOnly",
            "0",
            "-auth",
            SHARED_XAUTHORITY,
        ]
        self._reap_stale_display()
        with open(os.path.join(self.paths.runtime, "xvnc.log"), "ab", buffering=0) as log:
            self._xvnc = subprocess.Popen(
                argv, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
            )
        self.cg.reap(self.bot_id, self._xvnc.pid)

    def _spawn_wm(self) -> None:
        """轻量窗口管理器：支持 none（无 WM 单应用全屏）、openbox（默认 <10MB）、fluxbox、xfwm4。"""
        wm = (WINDOW_MANAGER or "openbox").strip().lower()
        if wm in ("none", "off", "0", "false"):
            return
        if wm == "openbox":
            if shutil.which("openbox"):
                return self._spawn_openbox()
            if shutil.which("fluxbox"):
                wm = "fluxbox"
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
        if wm == "fluxbox":
            if not shutil.which("fluxbox"):
                return
            with open(os.path.join(self.paths.runtime, "fluxbox.log"), "ab", buffering=0) as log:
                self._openbox = subprocess.Popen(
                    ["fluxbox"],
                    env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                )
            self.cg.reap(self.bot_id, self._openbox.pid)
            return
        if not shutil.which("xfwm4"):
            if shutil.which("openbox"):
                return self._spawn_openbox()
            return
        with open(os.path.join(self.paths.runtime, "xfwm4.log"), "ab", buffering=0) as log:
            self._openbox = subprocess.Popen(
                ["xfwm4", "--compositor=off"],
                env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
            )
        self.cg.reap(self.bot_id, self._openbox.pid)

    def _spawn_openbox(self) -> None:
        env = dict(os.environ)
        env.update(
            HOME=self.paths.home,
            XAUTHORITY=SHARED_XAUTHORITY,
            DISPLAY=f":{self.display}",
            XDG_CONFIG_HOME=os.path.join(self.paths.home, ".config"),
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

    def _spawn_app(self, argv: List[str]) -> int:
        env = dict(os.environ)
        env.update(
            HOME=self.paths.home,
            XAUTHORITY=SHARED_XAUTHORITY,
            DISPLAY=f":{self.display}",
        )
        with open(os.path.join(self.paths.runtime, "apps.log"), "ab", buffering=0) as log:
            proc = subprocess.Popen(
                argv, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
            )
        self._apps.append(proc)
        try:
            self.cg.reap(self.bot_id, proc.pid)
        except CgroupError:
            pass
        return proc.pid

    def open_app(self, app: str = "chrome", url: Optional[str] = None) -> dict:
        """在虚拟屏内拉起常用应用（隔离 HOME 与 Chrome Profile）。"""
        kind = (app or "chrome").strip().lower()
        no_wm = (WINDOW_MANAGER or "").strip().lower() in ("none", "off", "0", "false")
        if kind in ("chrome", "browser"):
            exe = next(
                (shutil.which(n) for n in ("google-chrome", "chromium", "chromium-browser") if shutil.which(n)),
                None,
            )
            if not exe:
                raise RuntimeError("未找到 google-chrome / chromium 可执行文件")
            win_w = SCREEN_WIDTH if (no_wm or not DESKTOP_SHELL) else (SCREEN_WIDTH - 40)
            win_h = SCREEN_HEIGHT if (no_wm or not DESKTOP_SHELL) else (SCREEN_HEIGHT - 80)
            argv = [
                exe,
                "--no-sandbox",
                "--disable-gpu",
                "--no-first-run",
                "--disable-dev-shm-usage",
                f"--user-data-dir={os.path.join(self.paths.home, '.config', 'google-chrome')}",
                "--window-position=0,0",
                f"--window-size={win_w},{win_h}",
            ]
            if url:
                argv.append(url)
        elif kind in ("terminal", "xterm", "shell"):
            exe = shutil.which("xterm") or shutil.which("x-terminal-emulator")
            if not exe:
                raise RuntimeError("未找到 xterm 终端可执行文件")
            argv = [exe, "-fa", "Monospace", "-fs", "11", "-geometry", "136x34+0+0"]
        elif kind in ("files", "pcmanfm"):
            exe = shutil.which("pcmanfm")
            if not exe:
                raise RuntimeError("未找到 pcmanfm 文件管理器")
            argv = [exe, self.paths.home]
        else:
            raise ValueError(f"不支持的应用类型: {app}")
        pid = self._spawn_app(argv)
        return {"ok": True, "app": kind, "pid": pid, "url": url}

    async def _wait_ready(self) -> None:
        socket_path = f"/tmp/.X11-unix/X{self.display}"
        deadline = time.time() + BOOT_TIMEOUT
        while time.time() < deadline:
            if not self.healthy():
                raise RuntimeError(
                    f"Xvnc exited early, see {self.paths.runtime}/xvnc.log"
                )
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
            await asyncio.sleep(0.2)
        raise RuntimeError(f"display :{self.display} not ready in {BOOT_TIMEOUT}s")

    # ---- 冻结 / 唤醒 ------------------------------------------------------
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
            # 冻结只暂停进程；换出闲置匿名页才能真省物理内存。
            # 只在“本次真的从运行态转冻结”且驻留内存大于阈值时回收，避免小屏触发内核空转扫描。
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
        if not self.healthy():
            st = await self.start()
            st["resumed_from_long_freeze"] = False
            return st
        st = await self.thaw()
        return st

    # ---- 销毁 -------------------------------------------------------------
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

    async def stop(self) -> dict:
        await self.streamer.shutdown()
        await asyncio.to_thread(self._stop_sync)
        self.lock.mark_stopped("stop")
        return self.status()

    def _stop_sync(self) -> None:
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
        self._openbox = None
        self._xvnc = None
        self._adopted_openbox = None
        self._adopted_xvnc = None
        # 清 X 锁文件，否则下次同 DISPLAY 启动会被拒
        for path in (f"/tmp/.X{self.display}-lock", f"/tmp/.X11-unix/X{self.display}"):
            try:
                os.unlink(path)
            except OSError:
                pass
        try:
            self.cg.freeze(self.bot_id, False)
        except CgroupError:
            pass
        try:
            self.cg.destroy(self.bot_id)
        except CgroupError:
            pass
        self.driver.reset_grabber()

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