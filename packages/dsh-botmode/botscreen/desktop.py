"""桌面壳：壁纸 + 桌面图标 + 底部 dock（参考图样式）。

每个 bot 的虚拟屏除了窗口管理器，还要有一层"桌面"：
  * 壁纸          —— xfdesktop 绘制（xfconf 里设 last-image）
  * 桌面图标      —— ~/Desktop/*.desktop，xfdesktop 渲染成左侧竖排图标
  * 底部 dock     —— tint2，圆角半透明黑条 + 4 个启动器（浏览器/搜索/终端/文件夹）
  * 合成器        —— picom，dock 的圆角与透明依赖它（X 屏必须是 32 位深度才有 ARGB visual）

踩过的坑（都在这里兜住了）：
  1. 桌面组件必须用 bot 自己的 `HOME`，否则 xfdesktop 读不到 ~/Desktop、tint2 读不到配置；
  2. xfconf 的显示器名是 `monitorVNC-0` 而不是 `monitor0`，壁纸属性要按 xdpyinfo 的实际名字写；
  3. `openbox` 会强制重定位 dock 窗口（并把 tint2 顶到右上角），所以用 `xfwm4` 当 WM；
  4. X 屏 24 位深度没有 ARGB visual，dock 只能是灰块 —— 必须 `-depth 32`。
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
from typing import List, Optional

from .config import SCREEN_DEPTH, SCREEN_HEIGHT, SCREEN_WIDTH, SHARED_XAUTHORITY, BotPaths

ASSETS = ("wallpaper.png", "drive.png", "folder.png", "codex.png",
          "chrome.png", "trash.png", "search.png", "terminal.png")

#: 桌面图标（顺序即文件名字典序，决定左侧竖排顺序）
DESKTOP_ITEMS = [
    ("1-filesystem", "drive.png", "文件系统", "pcmanfm /"),
    ("2-home", "folder.png", "主文件夹", "pcmanfm {home}"),
    ("3-browser", "chrome.png", "浏览器", "{chrome}"),
    # 回收站由 xfdesktop 自带（show-trash=true），不再放 .desktop
]

DOCK_ITEMS = [
    ("01-browser", "chrome.png", "浏览器", "{chrome}"),
    ("02-search", "search.png", "搜索", "{chrome_app} --window-size=900,620 --app=file://{search_html}"),
    ("03-terminal", "terminal.png", "终端", "xterm -fa Monospace -fs 11"),
    ("04-files", "folder.png", "文件夹", "pcmanfm {home}"),
]

TINT2RC = """# Backgrounds
rounded = 16
border_width = 0
background_color = #0b0e13 88
border_color = #2b3540 40

# Panel
panel_monitor = all
panel_position = bottom center horizontal
panel_items = L
panel_size = 268 62
panel_margin = 0 10
panel_padding = 12 8 12
panel_background_id = 1
panel_layer = top
panel_dock = 1
strut_policy = follow_size

# Launcher
launcher_padding = 6 2 6
launcher_background_id = 0
launcher_icon_size = 40
launcher_icon_theme = hicolor
{launchers}

# Taskbar
taskbar_mode = disabled
taskbar_padding = 0 0 0
taskbar_background_id = 0

# Misc
tooltip = 0
mouse_middle = none
mouse_right = none
mouse_scroll_up = none
mouse_scroll_down = none
systray_padding = 0 0 0
font_shadow = 0
"""

TOPBAR_RC = """# 顶部状态栏（任务栏 + 托盘 + 时钟）
rounded = 0
border_width = 0
background_color = #0f1319 96
border_color = #2b3540 60

panel_monitor = all
panel_position = top center horizontal
panel_items = TSC
panel_size = 100% 30
panel_margin = 0 0
panel_padding = 6 0 6
panel_background_id = 1
panel_layer = bottom
panel_dock = 1
strut_policy = follow_size

taskbar_mode = single_desktop
taskbar_padding = 4 2 4
taskbar_background_id = 0
taskbar_name = 1
taskbar_name_font = sans 8

systray_padding = 4 2 4
systray_icon_size = 0

time1_format = %m-%d %H:%M
time1_font = sans 9
clock_font_color = #d7dee4 100
"""

PICOM_CONF = """backend = "xrender";
shadow = false;
fading = false;
mark-wmwin-focused = true;
"""

PANEL_XML = """<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configdir" type="string" value="{panel_dir}"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=2;x=0;y=0"/>
      <property name="length" type="uint" value="100"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="size" type="uint" value="30"/>
      <property name="background-style" type="uint" value="0"/>
      <property name="disable-struts" type="bool" value="false"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="2"/>
        <value type="int" value="3"/>
        <value type="int" value="4"/>
        <value type="int" value="5"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu"/>
    <property name="plugin-2" type="string" value="tasklist">
      <property name="flat-buttons" type="bool" value="true"/>
      <property name="show-labels" type="bool" value="true"/>
      <property name="show-handle" type="bool" value="false"/>
    </property>
    <property name="plugin-3" type="string" value="separator">
      <property name="expand" type="bool" value="true"/>
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-4" type="string" value="systray">
      <property name="icon-size" type="uint" value="20"/>
    </property>
    <property name="plugin-5" type="string" value="clock">
      <property name="digital-format" type="string" value="%m-%d %H:%M"/>
    </property>
  </property>
</channel>
"""

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
    """给一张虚拟屏铺桌面。所有进程都交给调用方放进 cgroup。"""

    def __init__(self, bot_id: str, paths: BotPaths, assets_pkg: str, display: int) -> None:
        self.bot_id = bot_id
        self.paths = paths
        self.display = display
        self.assets_pkg = assets_pkg  # 包内 botscreen/desktop/assets
        self.assets_dir = os.path.join(os.path.dirname(paths.root), "_assets")
        # 记录 (名字, argv, 日志文件, Popen)，用于 watchdog 自愈
        self.procs: List[dict] = []
        self.dbus_address: Optional[str] = None
        self._started = False

    # ---- 文件准备 ---------------------------------------------------------
    def _chrome(self) -> str:
        for name in ("google-chrome", "chromium", "chromium-browser"):
            if shutil.which(name):
                return name
        return "google-chrome"

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
        chrome = self._chrome()
        # 留标题栏高度，并且不指定 position —— 让 xfwm4 正常装饰、可拖拽、可最大化
        chrome_full = (
            f"{chrome} --no-sandbox --disable-gpu --no-first-run "
            f"--disable-dev-shm-usage --window-size={SCREEN_WIDTH - 80},{SCREEN_HEIGHT - 140}"
        )
        home = self.paths.home
        desktop_dir = os.path.join(home, "Desktop")
        os.makedirs(desktop_dir, exist_ok=True)
        # 清掉上一版留下的启动器（文件名改过一次，旧的 4-browser/5-trash 会和新图标并存）
        wanted: set[str] = set()  # 图标改由 iconlayer 自绘，桌面不再需要任何 .desktop
        try:
            for name in os.listdir(desktop_dir):
                if name.endswith(".desktop") and name not in wanted:
                    os.unlink(os.path.join(desktop_dir, name))
        except OSError:
            pass

        # --- 桌面图标：交给自研 iconlayer，不再生成 .desktop ---
        for base, icon, label, command in []:
            path = os.path.join(desktop_dir, f"{base}.desktop")
            exec_line = command.format(
                home=home, chrome=chrome_full, chrome_app=chrome,
                search_html=os.path.join(self.assets_dir, "search.html"),
            )
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(
                    "[Desktop Entry]\n"
                    "Type=Application\nVersion=1.0\n"
                    f"Name={label}\nName[zh_CN]={label}\n"
                    f"Icon={os.path.join(self.assets_dir, icon)}\n"
                    f"Exec={exec_line}\nTerminal=false\n"
                )
            # 桌面图标层用 xfdesktop：它要求 **可执行位 + metadata::trusted** 才直接执行
            # （缺 x 位会弹"未信任的程序启动器…未被标记为安全的/可执行文件"）。
            # 注意这与 pcmanfm/libfm 相反：libfm 见到 x 位反而当"可执行脚本"要求确认。
            os.chmod(path, 0o755)

        # --- dock 启动器 ---
        dock_dir = os.path.join(home, ".config", "tint2")
        os.makedirs(dock_dir, exist_ok=True)
        lines = []
        for base, icon, label, command in DOCK_ITEMS:
            exec_line = command.format(
                home=home, chrome=chrome_full, chrome_app=chrome,
                search_html=os.path.join(self.assets_dir, "search.html"),
            )
            item = os.path.join(dock_dir, f"{base}.desktop")
            with open(item, "w", encoding="utf-8") as fh:
                fh.write(
                    "[Desktop Entry]\nType=Application\n"
                    f"Name={label}\nIcon={os.path.join(self.assets_dir, icon)}\n"
                    f"Exec={exec_line}\nTerminal=false\n"
                )
            lines.append(f"launcher_item_app = {item}")
        with open(os.path.join(dock_dir, "tint2rc"), "w", encoding="utf-8") as fh:
            fh.write(TINT2RC.format(launchers="\n".join(lines)))

        # --- pcmanfm 桌面：关掉它自带的 家目录/回收站/文档 图标，避免与我们的启动器重复 ---
        pm_dir = os.path.join(home, ".config", "pcmanfm", "default")
        os.makedirs(pm_dir, exist_ok=True)
        pm_conf = os.path.join(pm_dir, "pcmanfm.conf")
        existing = ""
        if os.path.exists(pm_conf):
            with open(pm_conf, encoding="utf-8") as fh:
                existing = fh.read()
        if "[Desktop]" in existing:
            head, _, tail = existing.partition("[Desktop]")
            body = tail.split("\n[", 1)
            rest = ("\n[" + body[1]) if len(body) > 1 else ""
        else:
            head, rest = existing, ""
        with open(pm_conf, "w", encoding="utf-8") as fh:
            fh.write(head.rstrip() + "\n\n[Desktop]\nshow_documents=0\nshow_trash=0\nshow_home=0\n" + rest.lstrip("\n"))

        # --- 顶部状态栏（第二个 tint2 实例）---
        with open(os.path.join(dock_dir, "topbar.tint2rc"), "w", encoding="utf-8") as fh:
            fh.write(TOPBAR_RC)

        # --- 合成器 ---
        cfg_dir = os.path.join(home, ".config")
        os.makedirs(cfg_dir, exist_ok=True)
        with open(os.path.join(cfg_dir, "picom.conf"), "w", encoding="utf-8") as fh:
            fh.write(PICOM_CONF)

    # ---- 环境 -------------------------------------------------------------
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
            XDG_CURRENT_DESKTOP="XFCE",
            DESKTOP_SESSION="xfce",
            XDG_SESSION_TYPE="x11",
        )
        for d in (
            env["XDG_DATA_HOME"], env["XDG_CACHE_HOME"], env["XDG_RUNTIME_DIR"],
            os.path.join(self.paths.home, ".local", "share", "plank"),
        ):
            os.makedirs(d, exist_ok=True)
        if self.dbus_address:
            env["DBUS_SESSION_BUS_ADDRESS"] = self.dbus_address
        if extra:
            env.update(extra)
        return env

    @property
    def dbus_file(self) -> str:
        return os.path.join(self.paths.runtime, "dbus.address")

    # ---- 启动 -------------------------------------------------------------
    def _spawn(self, argv: List[str], log_name: str, env: Optional[dict] = None,
               cgroup_hook=None, name: Optional[str] = None) -> Optional[subprocess.Popen]:
        if not shutil.which(argv[0]) and not os.path.exists(argv[0]):
            return None
        log_path = os.path.join(self.paths.runtime, log_name)
        log = open(log_path, "ab", buffering=0)
        proc = subprocess.Popen(
            argv, env=env or self.env(), stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.procs.append({
            "name": name or os.path.basename(argv[0]),
            "argv": list(argv),
            "log": log_path,
            "env": env,
            "proc": proc,
        })
        if cgroup_hook:
            try:
                cgroup_hook(proc.pid)
            except Exception:  # noqa: BLE001
                pass
        return proc

    def ensure_running(self, cgroup_hook=None) -> List[str]:
        """补齐已退出的桌面进程（X 断连、崩溃都会让它们静默消失）。

        这是"刷新后桌面变黑、图标变蓝方块"的直接修复：xfdesktop/picom/iconlayer
        死掉后没有任何东西会重拉它们，只能靠这里。
        """
        if not self._started:
            return []
        revived: List[str] = []
        for item in list(self.procs):
            proc = item["proc"]
            if proc.poll() is None:
                continue
            try:
                item["proc"] = self._relaunch(item, cgroup_hook)
                revived.append(item["name"])
            except OSError:
                continue
        return revived

    def _relaunch(self, item: dict, cgroup_hook=None) -> subprocess.Popen:
        log = open(item["log"], "ab", buffering=0)
        proc = subprocess.Popen(
            item["argv"], env=item.get("env") or self.env(),
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        if cgroup_hook:
            try:
                cgroup_hook(proc.pid)
            except Exception:  # noqa: BLE001
                pass
        return proc

    def _start_dbus(self) -> None:
        """一个 bot 一个 session bus；地址落盘，重启后复用。"""
        try:
            with open(self.dbus_file) as fh:
                addr = fh.read().strip()
            if addr and self._bus_alive(addr):
                self.dbus_address = addr
                return
        except OSError:
            pass
        try:
            out = subprocess.run(
                ["dbus-launch", "--sh-syntax"], env=self.env(),
                capture_output=True, text=True, timeout=10, check=False,
            ).stdout
            addr = ""
            for line in out.splitlines():
                if "DBUS_SESSION_BUS_ADDRESS=" in line:
                    addr = line.split("=", 1)[1].strip().strip("'\"；;")
            if addr:
                self.dbus_address = addr
                with open(self.dbus_file, "w") as fh:
                    fh.write(addr)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def _bus_alive(self, addr: str) -> bool:
        try:
            return subprocess.run(
                ["dbus-send", "--bus=" + addr, "--dest=org.freedesktop.DBus",
                 "--type=method_call", "/", "org.freedesktop.DBus.Peer.Ping"],
                env=self.env(), capture_output=True, timeout=5, check=False,
            ).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    def _mark_trusted(self, attempts: int = 3) -> int:
        """把桌面启动器标为可信（libfm 的 `metadata::trusted`）。

        gvfsd-metadata 刚起来时 gio set 会静默失败，所以这里读回校验并重试；
        返回最终成功的文件数。
        """
        desktop_dir = os.path.join(self.paths.home, "Desktop")
        try:
            names = [f for f in os.listdir(desktop_dir) if f.endswith(".desktop")]
        except OSError:
            return 0
        env = self.env()
        ok = 0
        for name in names:
            path = os.path.join(desktop_dir, name)
            trusted = False
            for _ in range(attempts):
                try:
                    subprocess.run(["gio", "set", path, "metadata::trusted", "true"],
                                   env=env, capture_output=True, timeout=5, check=False)
                    probe = subprocess.run(
                        ["gio", "info", "-a", "metadata::trusted", path],
                        env=env, capture_output=True, text=True, timeout=5, check=False,
                    ).stdout
                    if "metadata::trusted: true" in probe:
                        trusted = True
                        break
                except (OSError, subprocess.TimeoutExpired):
                    pass
                try:
                    import time as _t
                    _t.sleep(0.6)
                except Exception:  # noqa: BLE001
                    pass
            ok += 1 if trusted else 0
        return ok

    def _apply_wallpaper(self, attempts: int = 2) -> str:
        """壁纸 + 桌面图标开关走 xfconf。

        显示器名必须**动态探测**：KasmVNC 下是 `monitorVNC-0`，Xvfb 下是 `monitorscreen`，
        写死任何一个都会"设了但没效果"。这里直接读 xfconf 里已经存在的 backdrop 路径。
        """
        env = self.env()
        target = ""
        for _ in range(attempts):
            try:
                listing = subprocess.run(
                    ["xfconf-query", "-c", "xfce4-desktop", "-l"],
                    env=env, capture_output=True, text=True, timeout=4, check=False,
                ).stdout
            except (OSError, subprocess.TimeoutExpired):
                listing = ""
            for line in listing.splitlines():
                if line.endswith("/last-image"):
                    target = line
                    break
            if target:
                break
            # xfdesktop 还没建属性：催它一次
            try:
                subprocess.run(["xfdesktop", "--reload"], env=env,
                               capture_output=True, timeout=3, check=False)
            except (OSError, subprocess.TimeoutExpired):
                pass
            try:
                import time as _t
                _t.sleep(0.6)
            except Exception:  # noqa: BLE001
                pass
        if not target:
            return ""
        base = target[: -len("/last-image")]
        wall = os.path.join(self.assets_dir, "wallpaper.png")
        for key, typ, val in (
            ("last-image", "string", wall),
            ("image-style", "int", "5"),   # 5 = 缩放填充（铺满）
        ):
            try:
                subprocess.run(
                    ["xfconf-query", "-c", "xfce4-desktop", "-p", f"{base}/{key}",
                     "-n", "-t", typ, "-s", str(val)],
                    env=env, capture_output=True, timeout=4, check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
        for key, typ, val in (
            ("/desktop-icons/icon-size", "int", "48"),
            ("/desktop-icons/file-icons/show-filesystem", "bool", "false"),
            ("/desktop-icons/file-icons/show-home", "bool", "false"),
            ("/desktop-icons/file-icons/show-trash", "bool", "false"),
            ("/desktop-icons/file-icons/show-removable", "bool", "false"),
        ):
            try:
                subprocess.run(
                    ["xfconf-query", "-c", "xfce4-desktop", "-p", key,
                     "-n", "-t", typ, "-s", val],
                    env=env, capture_output=True, timeout=4, check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
        try:
            subprocess.run(["xfdesktop", "--reload"], env=env,
                           capture_output=True, timeout=3, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
        return wall

    def _place_dock(self) -> None:
        """把底部 dock 钉到底边居中。

        tint2 在"顶部 panel 已占 strut"的布局下会把 dock 算到屏幕外（实测 Y=952 on 720）。
        这里按窗口高度识别出 dock（62），直接 windowmove，xfwm4 不会像 openbox 那样反弹。
        """
        env = self.env()
        try:
            ids = subprocess.run(["xdotool", "search", "--class", "tint2"], env=env,
                                 capture_output=True, text=True, timeout=6, check=False).stdout.split()
        except (OSError, subprocess.TimeoutExpired):
            return
        for wid in ids:
            try:
                geom = subprocess.run(["xdotool", "getwindowgeometry", "--shell", wid], env=env,
                                      capture_output=True, text=True, timeout=6, check=False).stdout
            except (OSError, subprocess.TimeoutExpired):
                continue
            fields = dict(line.split("=", 1) for line in geom.splitlines() if "=" in line)
            try:
                if int(fields.get("HEIGHT", 0)) != 62:
                    continue
            except ValueError:
                continue
            x = (SCREEN_WIDTH - 268) // 2
            y = SCREEN_HEIGHT - 62 - 10
            subprocess.run(["xdotool", "windowmove", wid, str(x), str(y)], env=env,
                           capture_output=True, timeout=6, check=False)

    def start(self, cgroup_hook=None) -> bool:
        if self._started:
            return True
        self._kill_stale()
        self.prepare_files()
        self._start_dbus()
        # 顺序：compositor → 桌面图标层 → dock。dock 必须在 WM 之后，否则会被重定位。
        if SCREEN_DEPTH >= 32 and shutil.which("picom"):
            self._spawn(["picom", "--config", os.path.join(self.paths.home, ".config", "picom.conf")],
                        "picom.log", cgroup_hook=cgroup_hook, name="picom")
        # gvfs 的 metadata 服务：xfdesktop 只有在 .desktop 被标记 trusted 时才肯执行
        if shutil.which("gvfsd-metadata"):
            self._spawn(["gvfsd-metadata"], "gvfsd-metadata.log", cgroup_hook=cgroup_hook, name="gvfsd-metadata")
            try:
                import time as _t
                _t.sleep(0.25)
            except Exception:  # noqa: BLE001
                pass
        # 桌面图标层用 xfdesktop：走自己的启动器执行路径，不受 libfm 的"可执行脚本"拦截
        # 壁纸已由 iconlayer 的全屏合成图承担；xfdesktop 只留桌面右键菜单，
        # 且图标层在它之上（iconlayer 后映射），避免两者同为 DESKTOP 层互相覆盖
        if shutil.which("xfdesktop"):
            self._spawn(["xfdesktop"], "xfdesktop.log", cgroup_hook=cgroup_hook, name="xfdesktop")
            try:
                import time as _t
                _t.sleep(0.8)
            except Exception:  # noqa: BLE001
                pass
            self._apply_wallpaper()
        if shutil.which("tint2"):
            self._spawn(["tint2", "-c", os.path.join(self.paths.home, ".config", "tint2", "topbar.tint2rc")],
                        "tint2-top.log", cgroup_hook=cgroup_hook, name="tint2-top")
            self._spawn(["tint2", "-c", os.path.join(self.paths.home, ".config", "tint2", "tint2rc")],
                        "tint2.log", cgroup_hook=cgroup_hook, name="tint2-dock")
            try:
                import time as _t
                _t.sleep(0.6)
            except Exception:  # noqa: BLE001
                pass
        # 自研图标层：双击直接执行，绕开 xfdesktop/libfm 的信任机制
        self._spawn(
            [sys.executable, "-m", "botscreen.iconlayer",
             "--display", f":{self.display}" if not str(self.display).startswith(":") else str(self.display),
             "--home", self.paths.home,
             "--assets", self.assets_dir],
            "iconlayer.log", cgroup_hook=cgroup_hook, name="iconlayer",
        )
        self._place_dock()
        self._started = True
        return True

    def _kill_stale(self) -> None:
        """精确清理本 display 上残留的桌面组件（按 /proc/<pid>/environ 的 DISPLAY 过滤，避免误杀其他屏）。"""
        targets = {"xfdesktop", "pcmanfm", "tint2", "picom", "xfce4-panel"}
        display_tag = f"DISPLAY=:{self.display}".encode()
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
                if comm not in targets:
                    continue
                with open(f"/proc/{pid}/environ", "rb") as fh:
                    envs = fh.read().split(b"\x00")
                if display_tag not in envs:
                    continue
                os.kill(pid, signal.SIGTERM)
                killed = True
            except OSError:
                continue
        if killed:
            try:
                import time as _t
                _t.sleep(0.4)
            except Exception:  # noqa: BLE001
                pass

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
            "dbus": bool(self.dbus_address),
            "procs": [i["proc"].pid for i in self.procs if i["proc"].poll() is None],
            "dead": [i["name"] for i in self.procs if i["proc"].poll() is not None],
        }