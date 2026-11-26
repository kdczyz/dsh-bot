"""执行器：按需 XShm 零拷贝截屏（忽略光标层） + 免 Root X11 XTest 毫秒级键鼠注入。

核心特性
--------
1. **XShm 共享内存抓帧（默认）**：直接调用 `libX11` + `libXext` 的 `XShmGetImage` 读取
   Root Window 像素缓冲，不捕获鼠标光标层，支持 24/32 位（BGRX）与 16 位（BGR;16）色深；
   Attach 后立即标记 `IPC_RMID`，即使进程异常退出也绝不残留共享内存段。若运行环境不支持
   MIT-SHM 则自动回退 `python-xlib` ZPixmap。
2. **空闲自动释放抓屏资源**：提供 `close_capture()`，当无人类观看超过 5 秒时由推流器调用，
   立即卸载共享内存并关闭抓屏 X11 连接，平时常驻 0 抓屏开销。
3. **比例坐标映射 + 免 Root XTest 事件注入**：支持前端传入归一化比例 `(rx, ry)` 自动按当前
   虚拟屏真实分辨率换算，鼠标点击/拖拽/滚轮与 ASCII 键盘按键直走 X11 `XTest` 扩展（<0.5ms），
   中文/Emoji 自动走剪贴板粘贴通道。
"""
from __future__ import annotations

import ctypes
import io
import os
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

from PIL import Image

from .config import SHARED_XAUTHORITY, BotPaths, SCREEN_HEIGHT, SCREEN_WIDTH, THUMB_WIDTH

CAPTURE_BACKEND = os.environ.get("BOTSCREEN_CAPTURE", "xshm").strip().lower()


class DriverError(RuntimeError):
    pass


@dataclass
class RawFrame:
    data: bytes
    width: int
    height: int
    stride: int
    bpp: int

    def to_image(self) -> Image.Image:
        mode = "BGR;16" if self.bpp == 16 else "BGRX"
        img = Image.frombytes("RGB", (self.width, self.height), self.data, "raw", mode, self.stride, 1)
        if img.size != (SCREEN_WIDTH, SCREEN_HEIGHT):
            img = img.crop((0, 0, min(img.width, SCREEN_WIDTH), min(img.height, SCREEN_HEIGHT)))
        return img


@dataclass
class Shot:
    data: bytes
    width: int
    height: int
    mime: str
    thumb: Optional[bytes] = None


# ---- Ctypes MIT-SHM 绑定（懒加载） ------------------------------------------
class _XImage(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("xoffset", ctypes.c_int),
        ("format", ctypes.c_int),
        ("data", ctypes.c_void_p),
        ("byte_order", ctypes.c_int),
        ("bitmap_unit", ctypes.c_int),
        ("bitmap_bit_order", ctypes.c_int),
        ("bitmap_pad", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("bytes_per_line", ctypes.c_int),
        ("bits_per_pixel", ctypes.c_int),
    ]


class _XShmSegmentInfo(ctypes.Structure):
    _fields_ = [
        ("shmseg", ctypes.c_ulong),
        ("shmid", ctypes.c_int),
        ("shmaddr", ctypes.c_void_p),
        ("readOnly", ctypes.c_int),
    ]


_SHM_LIBS = None


def _load_shm_libs():
    global _SHM_LIBS
    if _SHM_LIBS is not None:
        return _SHM_LIBS
    libX11 = ctypes.CDLL("libX11.so.6")
    libXext = ctypes.CDLL("libXext.so.6")
    libc = ctypes.CDLL("libc.so.6")

    libX11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    libX11.XOpenDisplay.restype = ctypes.c_void_p
    libX11.XDefaultScreen.argtypes = [ctypes.c_void_p]
    libX11.XDefaultScreen.restype = ctypes.c_int
    libX11.XRootWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libX11.XRootWindow.restype = ctypes.c_ulong
    libX11.XDefaultVisual.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libX11.XDefaultVisual.restype = ctypes.c_void_p
    libX11.XDefaultDepth.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libX11.XDefaultDepth.restype = ctypes.c_int
    libX11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libX11.XDisplayWidth.restype = ctypes.c_int
    libX11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libX11.XDisplayHeight.restype = ctypes.c_int
    libX11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libX11.XDestroyImage.argtypes = [ctypes.POINTER(_XImage)]
    libX11.XCloseDisplay.argtypes = [ctypes.c_void_p]

    libXext.XShmQueryExtension.argtypes = [ctypes.c_void_p]
    libXext.XShmQueryExtension.restype = ctypes.c_int
    libXext.XShmCreateImage.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_uint,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.POINTER(_XShmSegmentInfo),
        ctypes.c_uint,
        ctypes.c_uint,
    ]
    libXext.XShmCreateImage.restype = ctypes.POINTER(_XImage)
    libXext.XShmAttach.argtypes = [ctypes.c_void_p, ctypes.POINTER(_XShmSegmentInfo)]
    libXext.XShmAttach.restype = ctypes.c_int
    libXext.XShmDetach.argtypes = [ctypes.c_void_p, ctypes.POINTER(_XShmSegmentInfo)]
    libXext.XShmGetImage.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.POINTER(_XImage),
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_ulong,
    ]
    libXext.XShmGetImage.restype = ctypes.c_int

    libc.shmget.argtypes = [ctypes.c_int, ctypes.c_size_t, ctypes.c_int]
    libc.shmget.restype = ctypes.c_int
    libc.shmat.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    libc.shmat.restype = ctypes.c_void_p
    libc.shmdt.argtypes = [ctypes.c_void_p]
    libc.shmctl.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]

    _SHM_LIBS = (libX11, libXext, libc)
    return _SHM_LIBS


class _XShmGrabber:
    """MIT-SHM 零拷贝抓屏器；抓 Root Window 天然忽略光标层。"""

    def __init__(self, display_num: int) -> None:
        os.environ.setdefault("XAUTHORITY", SHARED_XAUTHORITY)
        libX11, libXext, libc = _load_shm_libs()
        self._libX11 = libX11
        self._libXext = libXext
        self._libc = libc
        self._dpy = libX11.XOpenDisplay(f":{display_num}".encode())
        if not self._dpy:
            raise DriverError(f"XOpenDisplay :{display_num} failed")
        self._ximg = None
        self._addr = None
        self._attached = False
        try:
            if not libXext.XShmQueryExtension(self._dpy):
                raise DriverError("MIT-SHM extension unavailable")
            scr = libX11.XDefaultScreen(self._dpy)
            self.width = min(SCREEN_WIDTH, libX11.XDisplayWidth(self._dpy, scr))
            self.height = min(SCREEN_HEIGHT, libX11.XDisplayHeight(self._dpy, scr))
            depth = libX11.XDefaultDepth(self._dpy, scr)
            vis = libX11.XDefaultVisual(self._dpy, scr)
            self._root = libX11.XRootWindow(self._dpy, scr)
            self._shminfo = _XShmSegmentInfo()
            # ZPixmap == 2
            self._ximg = libXext.XShmCreateImage(
                self._dpy, vis, depth, 2, None, ctypes.byref(self._shminfo), self.width, self.height
            )
            if not self._ximg:
                raise DriverError("XShmCreateImage failed")
            self.stride = int(self._ximg.contents.bytes_per_line)
            self.bpp = int(self._ximg.contents.bits_per_pixel)
            self._size = self.stride * self.height
            shmid = libc.shmget(0, self._size, 0o1000 | 0o600)
            if shmid < 0:
                raise DriverError("shmget failed")
            addr = libc.shmat(shmid, None, 0)
            if addr in (None, ctypes.c_void_p(-1).value, 0xFFFFFFFFFFFFFFFF):
                libc.shmctl(shmid, 0, None)
                raise DriverError("shmat failed")
            self._addr = addr
            self._shminfo.shmid = shmid
            self._shminfo.shmaddr = addr
            self._shminfo.readOnly = 0
            self._ximg.contents.data = addr
            if not libXext.XShmAttach(self._dpy, ctypes.byref(self._shminfo)):
                libc.shmctl(shmid, 0, None)
                raise DriverError("XShmAttach failed")
            self._attached = True
            libX11.XSync(self._dpy, 0)
            # 立即标记 IPC_RMID：双方 detach 后内核自动回收，绝不泄漏 shm 段
            libc.shmctl(shmid, 0, None)
        except BaseException:
            self.close()
            raise

    def grab_raw(self) -> RawFrame:
        ok = self._libXext.XShmGetImage(self._dpy, self._root, self._ximg, 0, 0, 0xFFFFFFFF)
        if not ok:
            raise DriverError("XShmGetImage failed")
        raw = ctypes.string_at(self._addr, self._size)
        return RawFrame(raw, self.width, self.height, self.stride, self.bpp)

    def grab(self) -> Image.Image:
        return self.grab_raw().to_image()

    def close(self) -> None:
        try:
            if self._attached and self._dpy:
                self._libXext.XShmDetach(self._dpy, ctypes.byref(self._shminfo))
                self._libX11.XSync(self._dpy, 0)
        except Exception:  # noqa: BLE001
            pass
        self._attached = False
        try:
            if self._ximg:
                self._ximg.contents.data = None
                self._libX11.XDestroyImage(self._ximg)
        except Exception:  # noqa: BLE001
            pass
        self._ximg = None
        try:
            if self._addr:
                self._libc.shmdt(self._addr)
        except Exception:  # noqa: BLE001
            pass
        self._addr = None
        try:
            if self._dpy:
                self._libX11.XCloseDisplay(self._dpy)
        except Exception:  # noqa: BLE001
            pass
        self._dpy = None


class _XlibGrabber:
    """回退方案：python-xlib ZPixmap 读取 Root Window（同样忽略光标层）。"""

    def __init__(self, display_num: int) -> None:
        from Xlib import display as xdisplay

        self.display_num = display_num
        os.environ.setdefault("XAUTHORITY", SHARED_XAUTHORITY)
        self._dpy = xdisplay.Display(f":{display_num}")
        self._screen = self._dpy.screen()
        self.width = min(SCREEN_WIDTH, self._screen.width_in_pixels)
        self.height = min(SCREEN_HEIGHT, self._screen.height_in_pixels)
        self.bpp = 16 if self._screen.root_depth == 16 else 32
        self.stride = self.width * (2 if self.bpp == 16 else 4)

    def grab_raw(self) -> RawFrame:
        from Xlib import X

        raw = self._screen.root.get_image(0, 0, self.width, self.height, X.ZPixmap, 0xFFFFFFFF)
        data = raw.data
        if isinstance(data, str):
            data = data.encode("latin-1")
        return RawFrame(data, self.width, self.height, self.stride, self.bpp)

    def grab(self) -> Image.Image:
        return self.grab_raw().to_image()

    def close(self) -> None:
        try:
            self._dpy.close()
        except Exception:  # noqa: BLE001
            pass


_SPECIAL_KEYSYMS = {
    "enter": "Return",
    "return": "Return",
    "backspace": "BackSpace",
    "tab": "Tab",
    "esc": "Escape",
    "escape": "Escape",
    "space": "space",
    "delete": "Delete",
    "del": "Delete",
    "up": "Up",
    "down": "Down",
    "left": "Left",
    "right": "Right",
    "home": "Home",
    "end": "End",
    "pageup": "Prior",
    "prior": "Prior",
    "pagedown": "Next",
    "next": "Next",
}

_MODIFIER_KEYSYMS = {
    "ctrl": "Control_L",
    "control": "Control_L",
    "alt": "Alt_L",
    "shift": "Shift_L",
    "super": "Super_L",
    "meta": "Super_L",
    "win": "Super_L",
}


class ScreenDriver:
    def __init__(self, bot_id: str, display: int, paths: BotPaths) -> None:
        self.bot_id = bot_id
        self.display = display
        self.paths = paths
        self._grabber: Optional[object] = None
        self._input_dpy: Optional[object] = None
        self._lock = threading.Lock()
        self._input_lock = threading.Lock()
        self._last_capture_at: float = 0.0

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

    # ---- 截屏（按需分配，空闲可立即销毁） ----------------------------------
    def _backend(self):
        if self._grabber is None:
            if CAPTURE_BACKEND != "xlib":
                try:
                    self._grabber = _XShmGrabber(self.display)
                    return self._grabber
                except Exception:  # noqa: BLE001
                    self._grabber = None
            self._grabber = _XlibGrabber(self.display)
        return self._grabber

    def close_capture(self) -> None:
        """销毁抓屏连接与 XShm 缓冲区（空闲休眠时调用）。"""
        with self._lock:
            if self._grabber is not None:
                try:
                    self._grabber.close()
                except Exception:  # noqa: BLE001
                    pass
                self._grabber = None

    def reset_grabber(self) -> None:
        self.close_capture()
        with self._input_lock:
            if self._input_dpy is not None:
                try:
                    self._input_dpy.close()
                except Exception:  # noqa: BLE001
                    pass
                self._input_dpy = None

    def grab_raw(self) -> RawFrame:
        with self._lock:
            for attempt in range(2):
                try:
                    frame = self._backend().grab_raw()
                    self._last_capture_at = time.time()
                    return frame
                except Exception:
                    if self._grabber is not None:
                        try:
                            self._grabber.close()
                        except Exception:  # noqa: BLE001
                            pass
                        self._grabber = None
                    if attempt == 1:
                        raise
        raise DriverError("unreachable")

    def capture(self) -> Image.Image:
        return self.grab_raw().to_image()

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
            img.save(buf, format="WEBP", quality=quality, method=0)
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

    # ---- 比例坐标换算 + XTest 注入 -----------------------------------------
    @staticmethod
    def _clamp_xy(x: int, y: int, w: int = SCREEN_WIDTH, h: int = SCREEN_HEIGHT) -> Tuple[int, int]:
        return (
            max(0, min(max(1, w) - 1, int(x))),
            max(0, min(max(1, h) - 1, int(y))),
        )

    def resolve_xy(
        self,
        x: int = 0,
        y: int = 0,
        rx: Optional[float] = None,
        ry: Optional[float] = None,
    ) -> Tuple[int, int]:
        """支持前端传入归一化比例 (rx, ry in [0,1])，直接乘以虚拟屏分辨率。"""
        w, h = SCREEN_WIDTH, SCREEN_HEIGHT
        if rx is not None and ry is not None:
            crx = max(0.0, min(1.0, float(rx)))
            cry = max(0.0, min(1.0, float(ry)))
            return (
                int(round(crx * max(0, w - 1))),
                int(round(cry * max(0, h - 1))),
            )
        return self._clamp_xy(x, y, w, h)

    def _xtest_display(self):
        from Xlib import display as xdisplay

        if self._input_dpy is None:
            os.environ.setdefault("XAUTHORITY", SHARED_XAUTHORITY)
            dpy = xdisplay.Display(f":{self.display}")
            if not dpy.has_extension("XTEST"):
                dpy.close()
                return None, None
            self._input_dpy = dpy
        return self._input_dpy, self._input_dpy.screen().root

    def _with_xtest(self, fn) -> bool:
        with self._input_lock:
            for attempt in range(2):
                try:
                    dpy, root = self._xtest_display()
                    if dpy is None:
                        return False
                    if fn(dpy, root) is False:
                        return False
                    dpy.sync()
                    return True
                except Exception:  # noqa: BLE001
                    if self._input_dpy is not None:
                        try:
                            self._input_dpy.close()
                        except Exception:  # noqa: BLE001
                            pass
                        self._input_dpy = None
                    if attempt == 1:
                        return False
        return False

    def _xdo_move(self, x: int, y: int) -> None:
        try:
            self._xdo("mousemove", str(x), str(y), timeout=3)
            out = self._xdo("getmouselocation", "--shell", timeout=3)
            pos = dict(item.split("=", 1) for item in out.split() if "=" in item)
            if (int(pos.get("X", -1)), int(pos.get("Y", -1))) != (x, y):
                self._xdo("mousemove", str(x), str(y), timeout=3)
        except subprocess.TimeoutExpired as exc:
            raise DriverError(f"mousemove {x},{y} timed out") from exc

    def move(self, x: int, y: int) -> None:
        cx, cy = self._clamp_xy(x, y)
        from Xlib import X
        from Xlib.ext import xtest

        if self._with_xtest(lambda d, r: xtest.fake_input(d, X.MotionNotify, detail=0, root=r, x=cx, y=cy)):
            return
        with self._input_lock:
            self._xdo_move(cx, cy)

    def move_path(self, points: Sequence[Sequence[float]], normalized: bool = False) -> None:
        cleaned = []
        for p in points:
            if len(p) >= 2:
                if normalized:
                    cleaned.append(self.resolve_xy(rx=p[0], ry=p[1]))
                else:
                    cleaned.append(self._clamp_xy(int(p[0]), int(p[1])))
        if not cleaned:
            return
        from Xlib import X
        from Xlib.ext import xtest

        def _send(dpy, root) -> None:
            for cx, cy in cleaned:
                xtest.fake_input(dpy, X.MotionNotify, detail=0, root=root, x=cx, y=cy)

        if self._with_xtest(_send):
            return
        with self._input_lock:
            self._xdo_move(*cleaned[-1])

    def mousedown(self, x: int, y: int, button: int = 1) -> None:
        cx, cy = self._clamp_xy(x, y)
        btn = max(1, min(9, int(button)))
        from Xlib import X
        from Xlib.ext import xtest

        def _send(dpy, root) -> None:
            xtest.fake_input(dpy, X.MotionNotify, detail=0, root=root, x=cx, y=cy)
            xtest.fake_input(dpy, X.ButtonPress, detail=btn)

        if self._with_xtest(_send):
            return
        with self._input_lock:
            self._xdo_move(cx, cy)
            self._xdo("mousedown", str(btn))

    def mouseup(self, x: int, y: int, button: int = 1) -> None:
        cx, cy = self._clamp_xy(x, y)
        btn = max(1, min(9, int(button)))
        from Xlib import X
        from Xlib.ext import xtest

        def _send(dpy, root) -> None:
            xtest.fake_input(dpy, X.MotionNotify, detail=0, root=root, x=cx, y=cy)
            xtest.fake_input(dpy, X.ButtonRelease, detail=btn)

        if self._with_xtest(_send):
            return
        with self._input_lock:
            self._xdo_move(cx, cy)
            self._xdo("mouseup", str(btn))

    def click(self, x: int, y: int, button: int = 1, double: bool = False) -> None:
        cx, cy = self._clamp_xy(x, y)
        btn = max(1, min(9, int(button)))
        from Xlib import X
        from Xlib.ext import xtest

        def _send(dpy, root) -> None:
            xtest.fake_input(dpy, X.MotionNotify, detail=0, root=root, x=cx, y=cy)
            xtest.fake_input(dpy, X.ButtonPress, detail=btn)
            xtest.fake_input(dpy, X.ButtonRelease, detail=btn)
            if double:
                dpy.sync()
                time.sleep(0.06)
                xtest.fake_input(dpy, X.ButtonPress, detail=btn)
                xtest.fake_input(dpy, X.ButtonRelease, detail=btn)

        if self._with_xtest(_send):
            return
        with self._input_lock:
            self._xdo_move(cx, cy)
            if double:
                self._xdo("click", "--repeat", "2", "--delay", "80", str(btn))
            else:
                self._xdo("click", str(btn))

    def scroll(self, x: int, y: int, clicks: int) -> None:
        if clicks == 0:
            return
        cx, cy = self._clamp_xy(x, y)
        btn = 5 if clicks > 0 else 4
        repeat = min(50, abs(int(clicks)))
        from Xlib import X
        from Xlib.ext import xtest

        def _send(dpy, root) -> None:
            xtest.fake_input(dpy, X.MotionNotify, detail=0, root=root, x=cx, y=cy)
            for _ in range(repeat):
                xtest.fake_input(dpy, X.ButtonPress, detail=btn)
                xtest.fake_input(dpy, X.ButtonRelease, detail=btn)

        if self._with_xtest(_send):
            return
        with self._input_lock:
            self._xdo_move(cx, cy)
            self._xdo("click", "--repeat", str(repeat), "--delay", "40", str(btn))

    def drag(self, x1: int, y1: int, x2: int, y2: int, button: int = 1) -> None:
        sx, sy = self._clamp_xy(x1, y1)
        ex, ey = self._clamp_xy(x2, y2)
        btn = max(1, min(9, int(button)))
        steps = max(1, min(20, max(abs(ex - sx), abs(ey - sy)) // 16))
        pts = [
            (
                int(round(sx + (ex - sx) * i / steps)),
                int(round(sy + (ey - sy) * i / steps)),
            )
            for i in range(1, steps + 1)
        ]
        from Xlib import X
        from Xlib.ext import xtest

        def _send(dpy, root) -> None:
            xtest.fake_input(dpy, X.MotionNotify, detail=0, root=root, x=sx, y=sy)
            xtest.fake_input(dpy, X.ButtonPress, detail=btn)
            for px, py in pts:
                xtest.fake_input(dpy, X.MotionNotify, detail=0, root=root, x=px, y=py)
            xtest.fake_input(dpy, X.ButtonRelease, detail=btn)

        if self._with_xtest(_send):
            return
        with self._input_lock:
            self._xdo_move(sx, sy)
            self._xdo("mousedown", str(btn))
            for px, py in pts:
                self._xdo_move(px, py)
            self._xdo("mouseup", str(btn))

    @staticmethod
    def _resolve_keycode(dpy, token: str) -> Tuple[int, bool]:
        from Xlib import XK

        sym_name = _SPECIAL_KEYSYMS.get(token.lower(), token)
        keysym = XK.string_to_keysym(sym_name)
        if not keysym and len(token) == 1 and 0x20 <= ord(token) <= 0x7E:
            keysym = ord(token)
        if not keysym:
            return 0, False
        kc = dpy.keysym_to_keycode(keysym)
        if not kc:
            return 0, False
        need_shift = (
            dpy.keycode_to_keysym(kc, 0) != keysym
            and dpy.keycode_to_keysym(kc, 1) == keysym
        )
        return int(kc), need_shift

    def key(self, combo: str) -> None:
        parts = [p.strip() for p in combo.split("+") if p.strip()]
        if not parts:
            return
        from Xlib import X, XK
        from Xlib.ext import xtest

        def _send(dpy, _root) -> bool:
            mod_kcs: list[int] = []
            for mod in parts[:-1]:
                mod_sym_name = _MODIFIER_KEYSYMS.get(mod.lower())
                if not mod_sym_name:
                    return False
                mkc = dpy.keysym_to_keycode(XK.string_to_keysym(mod_sym_name))
                if not mkc:
                    return False
                mod_kcs.append(int(mkc))
            kc, need_shift = self._resolve_keycode(dpy, parts[-1])
            if not kc:
                return False
            if need_shift:
                skc = dpy.keysym_to_keycode(XK.string_to_keysym("Shift_L"))
                if skc and int(skc) not in mod_kcs:
                    mod_kcs.append(int(skc))
            for mkc in mod_kcs:
                xtest.fake_input(dpy, X.KeyPress, detail=mkc)
            xtest.fake_input(dpy, X.KeyPress, detail=kc)
            xtest.fake_input(dpy, X.KeyRelease, detail=kc)
            for mkc in reversed(mod_kcs):
                xtest.fake_input(dpy, X.KeyRelease, detail=mkc)
            return True

        if self._with_xtest(_send):
            return
        with self._input_lock:
            self._xdo("key", "--clearmodifiers", combo)

    def _type_ascii_xtest(self, text: str, press_enter: bool) -> bool:
        from Xlib import X, XK
        from Xlib.ext import xtest

        def _send(dpy, _root) -> bool:
            shift_kc = int(dpy.keysym_to_keycode(XK.string_to_keysym("Shift_L")) or 0)
            ops: list[Tuple[int, bool]] = []
            for ch in text:
                if ch == "\n":
                    kc, sh = self._resolve_keycode(dpy, "Return")
                elif ch == "\t":
                    kc, sh = self._resolve_keycode(dpy, "Tab")
                else:
                    kc, sh = self._resolve_keycode(dpy, ch)
                if not kc or (sh and not shift_kc):
                    return False
                ops.append((kc, sh))
            if press_enter:
                rkc, _ = self._resolve_keycode(dpy, "Return")
                if not rkc:
                    return False
                ops.append((rkc, False))
            for kc, sh in ops:
                if sh:
                    xtest.fake_input(dpy, X.KeyPress, detail=shift_kc)
                xtest.fake_input(dpy, X.KeyPress, detail=kc)
                xtest.fake_input(dpy, X.KeyRelease, detail=kc)
                if sh:
                    xtest.fake_input(dpy, X.KeyRelease, detail=shift_kc)
            return True

        return self._with_xtest(_send)

    def type_text(
        self,
        text: str,
        press_enter: bool = False,
        paste_key: str = "ctrl+v",
        also_primary: bool = True,
    ) -> None:
        """短纯 ASCII 直接走 XTest 扫描码注入；中文/Emoji/长文本走剪贴板粘贴通道。"""
        if not text:
            if press_enter:
                self.key("Return")
            return

        if text.isascii() and len(text) <= 64 and self._type_ascii_xtest(text, press_enter):
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
        try:
            title = self._xdo("getactivewindow", "getwindowname", timeout=3).strip()
            geom = self._xdo("getactivewindow", "getwindowgeometry", "--shell", timeout=3).strip()
            wid = ""
            for line in geom.splitlines():
                if line.startswith("WINDOW="):
                    wid = line.split("=", 1)[1]
            return {
                "window_id": wid or None,
                "title": title,
                "x": dict(l.split("=", 1) for l in geom.splitlines() if "=" in l) if geom else {},
            }
        except (DriverError, ValueError):
            return {"window_id": None, "title": None}

    def list_windows(self) -> list[dict]:
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
