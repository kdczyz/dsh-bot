"""自研桌面图标层：不经过任何“可信启动器”机制，双击即执行。

为什么要自己写
--------------
xfdesktop 和 pcmanfm/libfm 对 `.desktop` 的信任判断互相矛盾，而且都依赖 gvfs 的
`metadata::trusted`——在容器里这个标记和它们读到的那份不是同一个来源，所以无论
`chmod 755` 还是 `644`，首次双击总要弹一次确认。

这里的做法：图标是**自己画**的，点击是**自己处理**的，`.desktop` 和它的信任链完全不参与。

实现要点
--------
* 每个图标一个独立小窗口（宽 100 × 高 96），窗口类型 `_NET_WM_WINDOW_TYPE_DESKTOP`，
  xfwm4 会把它放在桌面层：不会被应用窗口挡住，也不会被当成普通窗口管理。
* 窗口里画的是“壁纸对应区域 + 图标 + 文字”，所以与壁纸**无缝**——不依赖 ARGB visual
  （Xvfb 只有 24 位深度，做不了真透明，这个办法绕开了）。
* 双击间隔 < 450ms 触发 `Exec`；用 `Popen(shell=True)` 在本屏环境里启动。
* 壁纸若替换，重新执行即可（每次启动都按当前壁纸重新裁背景）。

用法：python -m botscreen.iconlayer --display :101 --home /path/home --assets /path/assets
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time

from PIL import Image, ImageDraw, ImageFont
from Xlib import X, Xatom, display as xdisplay

TILE_W, TILE_H = 100, 96
ICON_PX = 48
ICON_TOP = 6
TEXT_BASELINE = 56
COL_GAP = 18
ROW_GAP = 22
ORIGIN = (22, 34)  # 第一列起点

FONT_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def _font(size: int = 13) -> ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _chrome() -> str:
    for name in ("google-chrome", "chromium", "chromium-browser"):
        from shutil import which

        if which(name):
            return name
    return "google-chrome"


def items(home: str, assets: str) -> list[dict]:
    chrome = _chrome()
    # 顺序即左侧竖排顺序：回收站 / 浏览器 / 文件系统 / 主文件夹
    return [
        {"label": "回收站", "icon": "trash.png", "cmd": "pcmanfm trash:///"},
        {"label": "浏览器", "icon": "chrome.png",
         "cmd": f"{chrome} --no-sandbox --disable-gpu --no-first-run "
                f"--disable-dev-shm-usage --window-size=1200,580"},
        {"label": "文件系统", "icon": "drive.png", "cmd": "pcmanfm /"},
        {"label": "主文件夹", "icon": "folder.png", "cmd": f"pcmanfm {home}"},
    ]


def render_tile(wall: Image.Image, x: int, y: int, icon_path: str, label: str) -> Image.Image:
    """裁壁纸做底 + 叠加图标和文字，保证与桌面无缝。"""
    tile = wall.crop((x, y, x + TILE_W, y + TILE_H)).convert("RGB")
    if os.path.exists(icon_path):
        try:
            icon = Image.open(icon_path).convert("RGBA").resize((ICON_PX, ICON_PX), Image.LANCZOS)
            tile.paste(icon, ((TILE_W - ICON_PX) // 2, ICON_TOP), icon)
        except OSError:
            pass
    draw = ImageDraw.Draw(tile)
    font = _font()
    width = draw.textlength(label, font=font)
    tx = (TILE_W - width) / 2
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1)):
        draw.text((tx + dx, TEXT_BASELINE + dy), label, font=font, fill=(0, 0, 0))
    draw.text((tx, TEXT_BASELINE), label, font=font, fill=(245, 248, 250))
    return tile


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--display", default=os.environ.get("DISPLAY", ":0"))
    ap.add_argument("--home", required=True)
    ap.add_argument("--assets", required=True)
    ap.add_argument("--double-click-ms", type=int, default=450)
    args = ap.parse_args()

    wall_path = os.path.join(args.assets, "wallpaper.png")
    try:
        wall = Image.open(wall_path).convert("RGB")
    except OSError:
        print(f"iconlayer: 缺少壁纸 {wall_path}", file=sys.stderr)
        return 2

    dpy = xdisplay.Display(args.display)
    screen = dpy.screen()
    root = screen.root
    depth = screen.root_depth

    # change_property 需要 Atom/str，传 intern_atom 的 int 会炸（TypeError: len() of int）
    def _atom(name: str):
        """返回 Atom 对象（change_property 不接受裸 int）。"""
        try:
            return dpy.get_atom(name)
        except Exception:  # noqa: BLE001
            from Xlib.Xatom import Atom as _A

            return _A(dpy.intern_atom(name))

    wm_type_atom = _atom("_NET_WM_WINDOW_TYPE")
    desktop_atom = _atom("_NET_WM_WINDOW_TYPE_DESKTOP")

    gc = root.create_gc()

    # 单窗口方案：壁纸 + 所有图标合成到一张全屏图。
    # 之前每个图标一个窗口，与 xfdesktop 同为 DESKTOP 类型会互相覆盖（刷新后图标被壁纸窗盖住）。
    sw, sh = screen.width_in_pixels, screen.height_in_pixels
    composite = wall.resize((sw, sh), Image.LANCZOS).convert("RGB")
    hits = []
    for idx, item in enumerate(items(args.home, args.assets)):
        x = ORIGIN[0] + (idx // 6) * (TILE_W + COL_GAP)
        y = ORIGIN[1] + (idx % 6) * (TILE_H + ROW_GAP)
        tile = render_tile(wall, x, y, os.path.join(args.assets, item["icon"]), item["label"])
        composite.paste(tile, (x, y))
        hits.append({"x": x, "y": y, "w": TILE_W, "h": TILE_H, "item": item})

    win = root.create_window(
        0, 0, sw, sh, 0, depth, X.InputOutput, X.CopyFromParent,
        background_pixel=screen.black_pixel,
        event_mask=X.ExposureMask | X.ButtonPressMask,
    )
    win.change_property(wm_type_atom, Xatom.ATOM, 32, [desktop_atom])
    win.map()
    dpy.sync()

    # X 协议的 PutImage 请求长度是 CARD16（4 字节为单位），单次最多 256 KB；
    # py-xlib 更保守（struct 'H'）。整屏 1280x720x4B = 3.6 MB，必须按条带分批。
    BAND = 8  # 行数/批 → 1280*8*4 = 40 KB
    _bands = [
        (y, composite.crop((0, y, sw, min(y + BAND, sh))))
        for y in range(0, sh, BAND)
    ]

    def paint() -> None:
        for y, band in _bands:
            win.put_image(gc, 0, y, band.width, band.height, X.ZPixmap, depth, 0,
                          band.tobytes("raw", "BGRX"))
        dpy.sync()

    paint()

    last: dict[str, float] = {}
    running = {"ok": True}

    def _stop(*_a) -> None:
        running["ok"] = False

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    env = dict(os.environ)
    env.setdefault("DISPLAY", args.display)


    print(f"iconlayer: {len(hits)} 图标已就位 on {args.display} ({sw}x{sh})", flush=True)

    while running["ok"]:
        try:
            ev = dpy.next_event()
        except Exception:  # noqa: BLE001  display 关闭
            break
        if ev.type == X.Expose:
            if ev.window.id == win.id and ev.count == 0:
                paint()
        elif ev.type == X.ButtonPress:
            if ev.detail != 1 or ev.window.id != win.id:
                continue
            px, py = ev.event_x, ev.event_y
            hit = None
            for h in hits:
                if h["x"] <= px < h["x"] + h["w"] and h["y"] <= py < h["y"] + h["h"]:
                    hit = h
                    break
            if hit is None:
                continue
            key = hit["item"]["label"]
            now = time.time() * 1000
            prev = last.get(key, 0.0)
            last[key] = now
            if now - prev <= args.double_click_ms:
                last[key] = 0.0
                cmd = hit["item"]["cmd"]
                try:
                    subprocess.Popen(
                        cmd, shell=True, env=env, cwd=args.home,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                    print(f"iconlayer: launch {hit['item']['label']} -> {cmd}", flush=True)
                except OSError as exc:
                    print(f"iconlayer: launch failed {exc}", file=sys.stderr, flush=True)
    try:
        win.destroy()
    except Exception:  # noqa: BLE001
        pass
    dpy.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())