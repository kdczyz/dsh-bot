"""统一轻量桌面壳：托管单一 `botscreen.iconlayer`（壁纸 + 桌面图标 + 顶部导航/任务栏）。

所有 Bot 虚拟屏均采用完全一致的桌面壳架构：
  * 不依赖宿主机可选包（tint2 / xfdesktop / xfce4-panel / picom / gvfs），彻底消除不同 Bot
    新建桌面规格不一致、顶部导航栏错位或缺失的问题；
  * 单进程 ~20MB 内存，0.2 秒就绪，支持按需启停与崩溃自愈。
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from typing import List, Optional

from .config import SHARED_XAUTHORITY, BotPaths

ASSETS = (
    "wallpaper.png",
    "drive.png",
    "folder.png",
    "codex.png",
    "chrome.png",
    "trash.png",
    "search.png",
    "terminal.png",
)

SEARCH_HTML = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>搜索</title><style>
html,body{margin:0;height:100%;background:#0d1013;color:#d7dee4;
  font-family:-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;display:flex;
  align-items:center;justify-content:center}
form{width:min(680px,86vw);text-align:center}
h1{font:600 15px ui-monospace;letter-spacing:.16em;color:#46b39d;margin:0 0 26px}
input{width:100%;box-sizing:border-box;font-size:20px;padding:16px 20px;border-radius:12px;
  border:1px solid #2a333d;background:#15191d;color:#e6edf3;outline:none}
input:focus{border-color:#46b39d;box-shadow:0 0 0 3px #46b39d22}
p{margin:18px 0 0;color:#63707a;font-size:12.5px}
</style></head><body><form onsubmit="go(event)">
<h1>SEARCH</h1>
<input id=q placeholder="搜索网页，回车用 Bing" autofocus>
<p>输入后回车 · 也可以直接粘一个 URL</p></form>
<script>
function go(e){e.preventDefault();var q=document.getElementById('q').value.trim();
if(!q)return;location.href=/^(https?:\\/\\/|file:)/.test(q)?q:('https://www.bing.com/search?q='+encodeURIComponent(q));}
</script></body></html>
"""


class DesktopShell:
    """给一张虚拟屏铺统一轻量桌面。所有进程均交由调用方纳管进 cgroup。"""

    def __init__(self, bot_id: str, paths: BotPaths, assets_pkg: str, display: int) -> None:
        self.bot_id = bot_id
        self.paths = paths
        self.display = display
        self.assets_pkg = assets_pkg
        self.assets_dir = os.path.join(os.path.dirname(paths.root), "_assets")
        self.procs: List[dict] = []
        self._started = False

    def _ensure_assets(self) -> None:
        os.makedirs(self.assets_dir, exist_ok=True)
        for name in ASSETS:
            src = os.path.join(self.assets_pkg, name)
            dst = os.path.join(self.assets_dir, name)
            if os.path.exists(src) and (
                not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst)
            ):
                shutil.copy2(src, dst)
        with open(os.path.join(self.assets_dir, "search.html"), "w", encoding="utf-8") as fh:
            fh.write(SEARCH_HTML)

    def prepare_files(self) -> None:
        self._ensure_assets()
        os.makedirs(os.path.join(self.paths.home, "Desktop"), exist_ok=True)

    def env(self, extra: Optional[dict] = None) -> dict:
        env = dict(os.environ)
        env.update(
            DISPLAY=f":{self.display}",
            XAUTHORITY=SHARED_XAUTHORITY,
            HOME=self.paths.home,
            XDG_CONFIG_HOME=os.path.join(self.paths.home, ".config"),
            XDG_DATA_HOME=os.path.join(self.paths.home, ".local", "share"),
            XDG_CACHE_HOME=os.path.join(self.paths.home, ".cache"),
            XDG_RUNTIME_DIR=self.paths.runtime,
            XDG_SESSION_TYPE="x11",
        )
        for d in (env["XDG_CONFIG_HOME"], env["XDG_DATA_HOME"], env["XDG_CACHE_HOME"], env["XDG_RUNTIME_DIR"]):
            os.makedirs(d, exist_ok=True)
        if extra:
            env.update(extra)
        return env

    def _spawn(
        self,
        argv: List[str],
        log_name: str,
        env: Optional[dict] = None,
        cgroup_hook=None,
        name: Optional[str] = None,
    ) -> Optional[subprocess.Popen]:
        if not shutil.which(argv[0]) and not os.path.exists(argv[0]):
            return None
        log_path = os.path.join(self.paths.runtime, log_name)
        log = open(log_path, "ab", buffering=0)
        proc = subprocess.Popen(
            argv,
            env=env or self.env(),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.procs.append(
            {
                "name": name or os.path.basename(argv[0]),
                "argv": list(argv),
                "log": log_path,
                "env": env,
                "proc": proc,
            }
        )
        if cgroup_hook:
            try:
                cgroup_hook(proc.pid)
            except Exception:  # noqa: BLE001
                pass
        return proc

    def ensure_running(self, cgroup_hook=None) -> List[str]:
        """补齐已退出的桌面组件进程。"""
        if not self._started:
            return []
        revived: List[str] = []
        for item in list(self.procs):
            proc = item["proc"]
            if proc.poll() is None:
                continue
            try:
                log = open(item["log"], "ab", buffering=0)
                new_proc = subprocess.Popen(
                    item["argv"],
                    env=item.get("env") or self.env(),
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                if cgroup_hook:
                    try:
                        cgroup_hook(new_proc.pid)
                    except Exception:  # noqa: BLE001
                        pass
                item["proc"] = new_proc
                revived.append(item["name"])
            except OSError:
                continue
        return revived

    def start(self, cgroup_hook=None) -> bool:
        if self._started:
            return True
        self._kill_stale()
        self.prepare_files()
        disp = f":{self.display}" if not str(self.display).startswith(":") else str(self.display)
        self._spawn(
            [
                sys.executable,
                "-m",
                "botscreen.iconlayer",
                "--display",
                disp,
                "--home",
                self.paths.home,
                "--assets",
                self.assets_dir,
            ],
            "iconlayer.log",
            cgroup_hook=cgroup_hook,
            name="iconlayer",
        )
        time.sleep(0.25)
        self._started = True
        return True

    def _kill_stale(self) -> None:
        """精确清理本 display 上残留的桌面组件进程（包含旧版 xfdesktop/tint2/picom/xfce4-panel/iconlayer）。"""
        targets = {"xfdesktop", "pcmanfm", "tint2", "picom", "xfce4-panel"}
        display_tag = f"DISPLAY=:{self.display}".encode()
        iconlayer_arg = f":{self.display}"
        killed = False
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            if pid == os.getpid():
                continue
            try:
                with open(f"/proc/{pid}/comm", "rb") as fh:
                    comm = fh.read().strip().decode(errors="ignore")
                match = False
                if comm in targets:
                    with open(f"/proc/{pid}/environ", "rb") as fh:
                        if display_tag in fh.read().split(b"\x00"):
                            match = True
                elif "python" in comm:
                    with open(f"/proc/{pid}/cmdline", "rb") as fh:
                        args = [a.decode(errors="ignore") for a in fh.read().split(b"\x00") if a]
                    if "botscreen.iconlayer" in args and iconlayer_arg in args:
                        match = True
                if match:
                    os.kill(pid, signal.SIGTERM)
                    killed = True
            except OSError:
                continue
        if killed:
            time.sleep(0.25)

    def stop(self) -> None:
        for item in reversed(self.procs):
            proc = item["proc"]
            try:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=3)
            except (subprocess.TimeoutExpired, OSError):
                try:
                    proc.kill()
                except OSError:
                    pass
        self.procs.clear()
        self._kill_stale()
        self._started = False

    def snapshot(self) -> dict:
        return {
            "started": self._started,
            "assets": self.assets_dir,
            "procs": [i["proc"].pid for i in self.procs if i["proc"].poll() is None],
            "dead": [i["name"] for i in self.procs if i["proc"].poll() is not None],
        }
