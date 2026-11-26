"""Agent 操控执行器：零视频流截屏 + 键鼠注入 + 中文粘贴通道（方案四.3）。

截屏实现说明
------------
方案原定 mss（X11 MIT-SHM），但 KasmVNC 的 X server 在同一个 depth=24 上暴露了
两组 depth 块，而 mss 的校验只取第一个匹配 depth 的块，于是报
"drawable's visual not found in screen's supported visuals"。
这里改用 python-xlib 的 ZPixmap 直接抓 root window：同样是零视频流、走 X 协议
共享内存路径，实测 5~8 ms（比 SHM 版 mss 还快），并且能正确处理 24/32 位屏。
mss 作为可选后端保留，环境变量 BOTSCREEN_CAPTURE=mss 可切回。
"""
from __future__ import annotations

import io
import os
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Optional, Tuple

from PIL import Image

from .config import SHARED_XAUTHORITY, BotPaths, SCREEN_HEIGHT, SCREEN_WIDTH, THUMB_WIDTH

CAPTURE_BACKEND = os.environ.get("BOTSCREEN_CAPTURE", "xlib")


class DriverError(RuntimeError):
    pass


@dataclass
class Shot:
    data: bytes
    width: int
    height: int
    mime: str
    thumb: Optional[bytes] = None


class _XlibGrabber:
    """每屏一个长连接；抓图只做 ZPixmap 读取，不涉及 VNC 编码器。"""

    def __init__(self, display_num: int) -> None:
        from Xlib import display as xdisplay

        self.display_num = display_num
        os.environ.setdefault("XAUTHORITY", SHARED_XAUTHORITY)
        self._dpy = xdisplay.Display(f":{display_num}")
        self._screen = self._dpy.screen()
        self.width = self._screen.width_in_pixels
        self.height = self._screen.height_in_pixels

    def grab(self) -> Image.Image:
        from Xlib import X

        raw = self._screen.root.get_image(0, 0, self.width, self.height, X.ZPixmap, 0xFFFFFFFF)
        data = raw.data
        if isinstance(data, str):  # python-xlib 在某些版本返回 str
            data = data.encode("latin-1")
        return Image.frombytes("RGB", (self.width, self.height), data, "raw", "BGRX")

    def close(self) -> None:
        try:
            self._dpy.close()
        except Exception:  # noqa: BLE001
            pass


class ScreenDriver:
    def __init__(self, bot_id: str, display: int, paths: BotPaths) -> None:
        self.bot_id = bot_id
        self.display = display
        self.paths = paths
        self._grabber: Optional[object] = None
        self._lock = threading.Lock()

    # ---- 环境 -------------------------------------------------------------
    @property
    def env(self) -> dict:
        env = dict(os.environ)
        env["DISPLAY"] = f":{self.display}"
        env["XAUTHORITY"] = SHARED_XAUTHORITY
        env["HOME"] = self.paths.home
        env.pop("WAYLAND_DISPLAY", None)
        return env

    def _xdo(self, *args: str, timeout: float = 5.0) -> str:
        try:
            proc = subprocess.run(
                ["xdotool", *args],
                env=self.env,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise DriverError(f"xdotool {' '.join(args)} timed out after {timeout}s") from exc
        if proc.returncode != 0:
            raise DriverError(
                f"xdotool {' '.join(args)} rc={proc.returncode}: {proc.stderr.strip()[:200]}"
            )
        return proc.stdout

    # ---- 截屏 -------------------------------------------------------------
    def _backend(self):
        if self._grabber is None:
            if CAPTURE_BACKEND == "mss":
                import mss

                self._grabber = mss.mss(display=f":{self.display}")
            else:
                self._grabber = _XlibGrabber(self.display)
        return self._grabber

    def reset_grabber(self) -> None:
        with self._lock:
            if self._grabber is not None:
                try:
                    self._grabber.close()
                except Exception:  # noqa: BLE001
                    pass
            self._grabber = None

    def capture(self) -> Image.Image:
        with self._lock:
            grabber = self._backend()
            if CAPTURE_BACKEND == "mss":
                raw = grabber.grab(grabber.monitors[0])
                return Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
            img = grabber.grab()
        if img.size != (SCREEN_WIDTH, SCREEN_HEIGHT):
            img = img.crop(
                (0, 0, min(img.width, SCREEN_WIDTH), min(img.height, SCREEN_HEIGHT))
            )
        return img

    def screenshot(
        self,
        fmt: str = "jpeg",
        quality: int = 82,
        with_thumb: bool = False,
    ) -> Shot:
        img = self.capture()
        buf = io.BytesIO()
        if fmt == "png":
            img.save(buf, format="PNG", compress_level=1)
            mime = "image/png"
        elif fmt == "webp":
            # WebP 编码约 55ms，仅在需要更小体积时使用
            img.save(buf, format="WEBP", quality=quality, method=2)
            mime = "image/webp"
        else:
            img.save(buf, format="JPEG", quality=quality, optimize=False, subsampling=1)
            mime = "image/jpeg"
        thumb = None
        if with_thumb:
            h = max(1, int(THUMB_WIDTH * img.height / img.width))
            tb = io.BytesIO()
            img.resize((THUMB_WIDTH, h), Image.BILINEAR).save(
                tb, format="JPEG", quality=50, optimize=False
            )
            thumb = tb.getvalue()
        return Shot(buf.getvalue(), img.width, img.height, mime, thumb)

    # ---- 键鼠 -------------------------------------------------------------
    def move(self, x: int, y: int) -> None:
        """移动指针。

        不用 `xdotool mousemove --sync`：指针已在目标坐标时 X 不会再发 motion
        事件，--sync 会一直等（实测 5s 超时）。改为非阻塞移动 + 坐标校验。
        """
        try:
            self._xdo("mousemove", str(x), str(y), timeout=3)
            out = self._xdo("getmouselocation", "--shell", timeout=3)
            pos = dict(item.split("=", 1) for item in out.split() if "=" in item)
            if (int(pos.get("X", -1)), int(pos.get("Y", -1))) != (x, y):
                self._xdo("mousemove", str(x), str(y), timeout=3)
        except subprocess.TimeoutExpired as exc:
            raise DriverError(f"mousemove {x},{y} timed out") from exc

    def click(self, x: int, y: int, button: int = 1, double: bool = False) -> None:
        self.move(x, y)
        btn = str(max(1, min(9, button)))
        if double:
            self._xdo("click", "--repeat", "2", "--delay", "80", btn)
        else:
            self._xdo("click", btn)

    def scroll(self, x: int, y: int, clicks: int) -> None:
        """clicks>0 向下滚动，<0 向上。"""
        self.move(x, y)
        btn = "5" if clicks > 0 else "4"
        self._xdo("click", "--repeat", str(abs(clicks)), "--delay", "40", btn)

    def drag(self, x1: int, y1: int, x2: int, y2: int, button: int = 1) -> None:
        self.move(x1, y1)
        self._xdo("mousedown", str(button))
        self.move(x2, y2)
        self._xdo("mouseup", str(button))

    def key(self, combo: str) -> None:
        self._xdo("key", "--clearmodifiers", combo)

    def type_text(
        self,
        text: str,
        press_enter: bool = False,
        paste_key: str = "ctrl+v",
        also_primary: bool = True,
    ) -> None:
        """中文/emoji 稳定输入：常驻 xclip 持有 selection + 粘贴快捷键。

        必须用常驻 holder（-loops 0）：`-loops 1` 的 xclip 会在粘贴请求到达前就
        退出，目标应用拿到的是空剪贴板。这里显式管理 holder 生命周期，
        粘贴完成后再回收。
        """
        if not text:
            if press_enter:
                self.key("Return")
            return

        selections = ["clipboard"] + (["primary"] if also_primary else [])
        holders: list[subprocess.Popen] = []
        try:
            for selection in selections:
                holder = subprocess.Popen(
                    ["xclip", "-selection", selection, "-i", "-loops", "0"],
                    env=self.env,
                    stdin=subprocess.PIPE,
                    text=True,
                )
                holders.append(holder)
                assert holder.stdin is not None
                holder.stdin.write(text)
                holder.stdin.flush()
                holder.stdin.close()
            # 等 selection 真正被 X 记录，再按键；否则目标应用读到空数据
            time.sleep(0.09)
            self.key(paste_key)
            time.sleep(0.12)
            if press_enter:
                self.key("Return")
        finally:
            for holder in holders:
                try:
                    holder.terminate()
                    holder.wait(timeout=1)
                except Exception:  # noqa: BLE001
                    try:
                        holder.kill()
                    except Exception:  # noqa: BLE001
                        pass

    def focused_window(self) -> dict:
        """取焦点窗口。用 xdotool 链式命令（窗口 id 在命令间传递），
        两次进程调用代替三次,单次约 3ms。"""
        try:
            title = self._xdo("getactivewindow", "getwindowname", timeout=3).strip()
            geom = self._xdo("getactivewindow", "getwindowgeometry", "--shell", timeout=3).strip()
            wid = ""
            for line in geom.splitlines():
                if line.startswith("WINDOW="):
                    wid = line.split("=", 1)[1]
            return {"window_id": wid or None, "title": title,
                    "x": dict(l.split("=", 1) for l in geom.splitlines() if "=" in l) if geom else {}}
        except (DriverError, ValueError):
            return {"window_id": None, "title": None}

    def list_windows(self) -> list[dict]:
        """列出当前虚拟屏内可见窗口。"""
        try:
            raw = self._xdo("search", "--onlyvisible", "--name", "", timeout=3)
        except DriverError:
            return []
        windows = []
        for wid in raw.split():
            wid = wid.strip()
            if not wid:
                continue
            try:
                title = self._xdo("getwindowname", wid, timeout=2).strip()
            except DriverError:
                title = ""
            if title:
                windows.append({"window_id": wid, "title": title})
        return windows[:30]

    def focus_window(self, window_id: str) -> None:
        self._xdo("windowactivate", "--sync", str(window_id), timeout=3)

    # ---- 前端等比缩放的坐标换算 -------------------------------------------
    @staticmethod
    def map_coords(
        x: float,
        y: float,
        from_size: Tuple[int, int],
        to_size: Tuple[int, int] = (SCREEN_WIDTH, SCREEN_HEIGHT),
    ) -> Tuple[int, int]:
        fw, fh = from_size
        tw, th = to_size
        if fw <= 0 or fh <= 0:
            return int(x), int(y)
        return int(round(x * tw / fw)), int(round(y * th / fh))