"""统一轻量虚拟桌面壳：壁纸 + 桌面图标 + 顶部固定导航/任务栏。

设计目标
--------
1. **所有 Bot 100% 统一规格与样式**：完全不依赖外部 `tint2` / `xfce4-panel` / `xfdesktop` /
   `picom` / `gvfs`（不同宿主机缺包或竞态会导致导航栏错位、壁纸黑屏、图标重复）。
2. **双窗口架构（纯 python-xlib + Pillow，单进程 ~20MB 内存，0.2s 秒启）**：
   * `botscreen-desktop`（`_NET_WM_WINDOW_TYPE_DESKTOP`，1280×720 固定在 (0,0)）：
     壁纸 + 左侧竖排桌面图标，双击直接拉起对应应用（无未信任弹窗）。
   * `botscreen-topbar`（`_NET_WM_WINDOW_TYPE_DOCK`，1280×34 固定在 (0,0)，带 `_NET_WM_STRUT_PARTIAL`）：
     - 左侧：快捷启动按钮（浏览器 / 终端 / 文件）
     - 中间：实时 EWMH 窗口任务栏（点击切换/恢复最小化窗口，点击当前活动窗口可最小化）
     - 右侧：时钟（MM-DD HH:MM）
3. **零空转 CPU**：事件循环基于 `select.select` 监听 X11 socket + `PropertyNotify`，
   仅在窗口列表或分钟变化时重绘顶部栏。
"""
from __future__ import annotations

import argparse
import os
import select
import shutil
import signal
import subprocess
import sys
import time
from typing import Dict, List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont
from Xlib import X, Xatom, display as xdisplay, protocol

from .config import SCREEN_HEIGHT, SCREEN_WIDTH, TOPBAR_HEIGHT

TILE_W, TILE_H = 100, 96
ICON_PX = 48
ICON_TOP = 6
TEXT_BASELINE = 58
COL_GAP = 18
ROW_GAP = 18
ORIGIN = (22, TOPBAR_HEIGHT + 20)  # 始终位于顶部导航栏下方

FONT_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)

SKIP_TASKBAR_CLASSES = {"botscreen-desktop", "botscreen-topbar", "xfdesktop", "tint2", "xfce4-panel"}
SKIP_TASKBAR_TYPES = {
    "_NET_WM_WINDOW_TYPE_DESKTOP",
    "_NET_WM_WINDOW_TYPE_DOCK",
    "_NET_WM_WINDOW_TYPE_SPLASH",
    "_NET_WM_WINDOW_TYPE_NOTIFICATION",
    "_NET_WM_WINDOW_TYPE_TOOLTIP",
}

_FONT_CACHE: Dict[int, ImageFont.ImageFont] = {}


def _font(size: int = 13) -> ImageFont.ImageFont:
    cached = _FONT_CACHE.get(size)
    if cached is not None:
        return cached
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                f = ImageFont.truetype(path, size)
                _FONT_CACHE[size] = f
                return f
            except OSError:
                continue
    f = ImageFont.load_default()
    _FONT_CACHE[size] = f
    return f


def _chrome_bin() -> str:
    for name in ("google-chrome", "chromium", "chromium-browser"):
        if shutil.which(name):
            return name
    return "google-chrome"


def _terminal_cmd() -> str:
    if shutil.which("xfce4-terminal"):
        return "xfce4-terminal --geometry=110x28"
    if shutil.which("xterm"):
        return "xterm -fa Monospace -fs 11 -geometry 110x28+60+56"
    return "x-terminal-emulator"


def _filemgr_cmd(target: str) -> str:
    for name in ("pcmanfm", "thunar", "nautilus", "nemo"):
        if shutil.which(name):
            return f"{name} {target}"
    return f"xdg-open {target}"


def _chrome_cmd(home: str) -> str:
    chrome = _chrome_bin()
    profile = os.path.join(home, ".config", "google-chrome")
    win_w = max(800, SCREEN_WIDTH - 80)
    win_h = max(480, SCREEN_HEIGHT - TOPBAR_HEIGHT - 36)
    return (
        f"{chrome} --no-sandbox --disable-gpu --no-first-run --disable-dev-shm-usage "
        f"--user-data-dir={profile} --window-position=40,{TOPBAR_HEIGHT + 14} "
        f"--window-size={win_w},{win_h}"
    )


def desktop_items(home: str) -> List[dict]:
    return [
        {"label": "浏览器", "icon": "chrome.png", "cmd": _chrome_cmd(home)},
        {"label": "终端", "icon": "terminal.png", "cmd": _terminal_cmd()},
        {"label": "主文件夹", "icon": "folder.png", "cmd": _filemgr_cmd(home)},
        {"label": "文件系统", "icon": "drive.png", "cmd": _filemgr_cmd("/")},
    ]


def topbar_launchers(home: str) -> List[dict]:
    return [
        {"id": "browser", "label": "浏览器", "icon": "chrome.png", "cmd": _chrome_cmd(home)},
        {"id": "terminal", "label": "终端", "icon": "terminal.png", "cmd": _terminal_cmd()},
        {"id": "files", "label": "文件", "icon": "folder.png", "cmd": _filemgr_cmd(home)},
    ]


def _fallback_wallpaper(sw: int, sh: int) -> Image.Image:
    """无壁纸资源时生成统一的深蓝灰渐变背景。"""
    img = Image.new("RGB", (sw, sh), (15, 22, 32))
    draw = ImageDraw.Draw(img)
    for y in range(sh):
        t = y / max(1, sh - 1)
        r = int(16 + 10 * t)
        g = int(24 + 14 * t)
        b = int(36 + 18 * t)
        draw.line([(0, y), (sw, y)], fill=(r, g, b))
    return img


def render_tile(wall: Image.Image, x: int, y: int, icon_path: str, label: str) -> Image.Image:
    """裁壁纸做底 + 叠加图标和带阴影文字，保证与桌面无缝融合。"""
    tile = wall.crop((x, y, x + TILE_W, y + TILE_H)).convert("RGB")
    if os.path.exists(icon_path):
        try:
            icon = Image.open(icon_path).convert("RGBA").resize((ICON_PX, ICON_PX), Image.LANCZOS)
            tile.paste(icon, ((TILE_W - ICON_PX) // 2, ICON_TOP), icon)
        except OSError:
            pass
    draw = ImageDraw.Draw(tile)
    font = _font(13)
    width = draw.textlength(label, font=font)
    tx = (TILE_W - width) / 2
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1)):
        draw.text((tx + dx, TEXT_BASELINE + dy), label, font=font, fill=(0, 0, 0))
    draw.text((tx, TEXT_BASELINE), label, font=font, fill=(245, 248, 250))
    return tile


def _truncate_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_w: float) -> str:
    if draw.textlength(text, font=font) <= max_w:
        return text
    ell = "…"
    out = text
    while len(out) > 1 and draw.textlength(out + ell, font=font) > max_w:
        out = out[:-1]
    return out + ell


def _load_small_icon(path: str, size: int = 16) -> Optional[Image.Image]:
    if not os.path.exists(path):
        return None
    try:
        return Image.open(path).convert("RGBA").resize((size, size), Image.LANCZOS)
    except OSError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--display", default=os.environ.get("DISPLAY", ":0"))
    ap.add_argument("--home", required=True)
    ap.add_argument("--assets", required=True)
    ap.add_argument("--double-click-ms", type=int, default=450)
    args = ap.parse_args()

    dpy = xdisplay.Display(args.display)
    screen = dpy.screen()
    root = screen.root
    depth = screen.root_depth
    sw, sh = screen.width_in_pixels, screen.height_in_pixels

    def _atom(name: str):
        try:
            return dpy.get_atom(name)
        except Exception:  # noqa: BLE001
            from Xlib.Xatom import Atom as _A

            return _A(dpy.intern_atom(name))

    a_wm_type = _atom("_NET_WM_WINDOW_TYPE")
    a_desktop = _atom("_NET_WM_WINDOW_TYPE_DESKTOP")
    a_dock = _atom("_NET_WM_WINDOW_TYPE_DOCK")
    a_strut = _atom("_NET_WM_STRUT")
    a_strut_partial = _atom("_NET_WM_STRUT_PARTIAL")
    a_wm_state = _atom("_NET_WM_STATE")
    a_state_above = _atom("_NET_WM_STATE_ABOVE")
    a_state_below = _atom("_NET_WM_STATE_BELOW")
    a_state_sticky = _atom("_NET_WM_STATE_STICKY")
    a_state_skip_tb = _atom("_NET_WM_STATE_SKIP_TASKBAR")
    a_state_skip_pg = _atom("_NET_WM_STATE_SKIP_PAGER")
    a_state_hidden = _atom("_NET_WM_STATE_HIDDEN")
    a_client_list = _atom("_NET_CLIENT_LIST")
    a_active_win = _atom("_NET_ACTIVE_WINDOW")
    a_net_wm_name = _atom("_NET_WM_NAME")
    a_change_state = _atom("WM_CHANGE_STATE")

    wall_path = os.path.join(args.assets, "wallpaper.png")
    try:
        wall = Image.open(wall_path).convert("RGB").resize((sw, sh), Image.LANCZOS)
    except OSError:
        wall = _fallback_wallpaper(sw, sh)

    gc = root.create_gc()

    # ---- 1. 桌面背景 + 图标窗口 (1280×720) --------------------------------
    composite = wall.copy()
    desktop_hits: List[dict] = []
    for idx, item in enumerate(desktop_items(args.home)):
        x = ORIGIN[0] + (idx // 5) * (TILE_W + COL_GAP)
        y = ORIGIN[1] + (idx % 5) * (TILE_H + ROW_GAP)
        tile = render_tile(wall, x, y, os.path.join(args.assets, item["icon"]), item["label"])
        composite.paste(tile, (x, y))
        desktop_hits.append({"x": x, "y": y, "w": TILE_W, "h": TILE_H, "item": item})

    desktop_win = root.create_window(
        0, 0, sw, sh, 0, depth, X.InputOutput, X.CopyFromParent,
        background_pixel=screen.black_pixel,
        event_mask=X.ExposureMask | X.ButtonPressMask,
    )
    desktop_win.set_wm_class("botscreen-desktop", "BotScreen")
    desktop_win.set_wm_name("BotScreen Desktop")
    desktop_win.change_property(a_wm_type, Xatom.ATOM, 32, [a_desktop])
    desktop_win.change_property(a_wm_state, Xatom.ATOM, 32, [a_state_below, a_state_sticky, a_state_skip_tb, a_state_skip_pg])
    desktop_win.map()

    # ---- 2. 顶部固定导航栏 + 任务栏窗口 (1280×34 固定在 (0,0)) --------------
    bar_h = TOPBAR_HEIGHT
    topbar_win = root.create_window(
        0, 0, sw, bar_h, 0, depth, X.InputOutput, X.CopyFromParent,
        background_pixel=screen.black_pixel,
        event_mask=X.ExposureMask | X.ButtonPressMask,
    )
    topbar_win.set_wm_class("botscreen-topbar", "BotScreen")
    topbar_win.set_wm_name("BotScreen Topbar")
    topbar_win.change_property(a_wm_type, Xatom.ATOM, 32, [a_dock])
    topbar_win.change_property(a_wm_state, Xatom.ATOM, 32, [a_state_above, a_state_sticky, a_state_skip_tb, a_state_skip_pg])
    topbar_win.change_property(a_strut, Xatom.CARDINAL, 32, [0, 0, bar_h, 0])
    topbar_win.change_property(
        a_strut_partial, Xatom.CARDINAL, 32,
        [0, 0, bar_h, 0, 0, 0, 0, 0, 0, sw - 1, 0, 0],
    )
    topbar_win.map()
    # 确保顶部栏坐标与层级始终锁定在 (0, 0) 顶层
    topbar_win.configure(x=0, y=0, width=sw, height=bar_h, stack_mode=X.Above)

    # 监听根窗口属性变更（窗口打开/关闭/焦点切换实时同步顶部任务栏）
    try:
        root.change_attributes(event_mask=X.PropertyChangeMask)
    except Exception:  # noqa: BLE001
        pass
    dpy.sync()

    # 条带分批绘制（避免 X11 PutImage 单包超限）
    BAND = 8
    desktop_bands = [
        (y, composite.crop((0, y, sw, min(y + BAND, sh))).tobytes("raw", "BGRX"), min(BAND, sh - y))
        for y in range(0, sh, BAND)
    ]

    def paint_desktop() -> None:
        for y, raw, h_band in desktop_bands:
            desktop_win.put_image(gc, 0, y, sw, h_band, X.ZPixmap, depth, 0, raw)
        dpy.sync()

    launchers = topbar_launchers(args.home)
    launcher_icons = {
        item["id"]: _load_small_icon(os.path.join(args.assets, item["icon"]), 16)
        for item in launchers
    }

    def query_tasks() -> Tuple[List[dict], int]:
        tasks: List[dict] = []
        active_id = 0
        try:
            act_prop = root.get_full_property(a_active_win, 0)
            if act_prop and act_prop.value:
                active_id = int(act_prop.value[0])
            prop = root.get_full_property(a_client_list, 0)
            wids = list(prop.value) if (prop and prop.value) else []
        except Exception:  # noqa: BLE001
            return tasks, active_id

        for wid in wids:
            if int(wid) in (desktop_win.id, topbar_win.id):
                continue
            try:
                w = dpy.create_resource_object("window", int(wid))
                t_prop = w.get_full_property(a_wm_type, 0)
                if t_prop and t_prop.value:
                    tnames = {dpy.get_atom_name(int(a)) for a in t_prop.value}
                    if tnames & SKIP_TASKBAR_TYPES:
                        continue
                cls_raw = w.get_wm_class()
                cls_lower = [str(c).lower() for c in cls_raw] if cls_raw else []
                if any(c in SKIP_TASKBAR_CLASSES for c in cls_lower):
                    continue
                s_prop = w.get_full_property(a_wm_state, 0)
                states = set(int(a) for a in (s_prop.value if (s_prop and s_prop.value) else []))
                if int(a_state_skip_tb) in states:
                    continue
                minimized = int(a_state_hidden) in states
                title = ""
                np = w.get_full_property(a_net_wm_name, 0)
                if np and np.value:
                    title = np.value.decode("utf-8", errors="ignore").strip() if isinstance(np.value, bytes) else str(np.value).strip()
                if not title:
                    raw_n = w.get_wm_name()
                    if isinstance(raw_n, bytes):
                        title = raw_n.decode("utf-8", errors="ignore").strip()
                    elif raw_n:
                        title = str(raw_n).strip()
                if not title:
                    title = cls_raw[1] if (cls_raw and len(cls_raw) > 1) else "Window"
                tasks.append({
                    "wid": int(wid),
                    "title": title[:60],
                    "active": int(wid) == active_id and not minimized,
                    "minimized": minimized,
                })
            except Exception:  # noqa: BLE001
                continue
        return tasks, active_id

    topbar_hits: List[dict] = []
    last_bar_sig = None

    def paint_topbar(force: bool = False) -> None:
        nonlocal topbar_hits, last_bar_sig
        tasks, active_id = query_tasks()
        clock_str = time.strftime("%m-%d %H:%M")
        sig = (clock_str, active_id, tuple((t["wid"], t["title"], t["active"], t["minimized"]) for t in tasks))
        if not force and sig == last_bar_sig:
            return
        last_bar_sig = sig

        img = Image.new("RGB", (sw, bar_h), (16, 21, 29))
        draw = ImageDraw.Draw(img)
        # 底部分隔线
        draw.line([(0, bar_h - 1), (sw, bar_h - 1)], fill=(38, 48, 61))

        f_btn = _font(12)
        f_clk = _font(12)
        hits: List[dict] = []

        # 左侧快捷启动按钮
        cx = 10
        for item in launchers:
            label = item["label"]
            tw = int(draw.textlength(label, font=f_btn))
            has_ic = launcher_icons.get(item["id"]) is not None
            bw = tw + (34 if has_ic else 20)
            by0, by1 = 5, bar_h - 6
            draw.rounded_rectangle([cx, by0, cx + bw, by1], radius=6, fill=(28, 36, 48), outline=(49, 62, 78))
            tx = cx + 10
            if has_ic:
                ic = launcher_icons[item["id"]]
                assert ic is not None
                img.paste(ic, (cx + 7, (bar_h - 16) // 2), ic)
                tx = cx + 27
            draw.text((tx, (bar_h - 15) // 2), label, font=f_btn, fill=(224, 232, 240))
            hits.append({"kind": "launch", "x0": cx, "x1": cx + bw, "cmd": item["cmd"], "label": label})
            cx += bw + 6

        # 分隔竖线
        cx += 4
        draw.line([(cx, 8), (cx, bar_h - 9)], fill=(45, 56, 70))
        cx += 10

        # 右侧时钟区域预留
        clk_w = int(draw.textlength(clock_str, font=f_clk)) + 20
        right_limit = sw - clk_w - 8

        # 中间任务栏（当前所有打开/最小化的窗口）
        if tasks and right_limit > cx + 60:
            avail = right_limit - cx
            max_tabs = min(len(tasks), 8)
            tab_w = max(84, min(180, (avail - (max_tabs - 1) * 6) // max_tabs))
            for task in tasks[:max_tabs]:
                if cx + tab_w > right_limit:
                    break
                by0, by1 = 5, bar_h - 6
                if task["active"]:
                    fill = (35, 55, 76)
                    outline = (70, 179, 157)
                    fg = (242, 247, 252)
                elif task["minimized"]:
                    fill = (21, 27, 36)
                    outline = (42, 52, 66)
                    fg = (130, 146, 164)
                else:
                    fill = (26, 33, 44)
                    outline = (48, 60, 76)
                    fg = (202, 214, 226)
                draw.rounded_rectangle([cx, by0, cx + tab_w, by1], radius=6, fill=fill, outline=outline)
                if task["active"]:
                    draw.rectangle([cx + 8, by1 - 2, cx + tab_w - 8, by1], fill=(70, 179, 157))
                dot_c = (70, 179, 157) if task["active"] else ((100, 116, 139) if task["minimized"] else (96, 165, 250))
                draw.ellipse([cx + 8, (bar_h - 6) // 2, cx + 14, (bar_h + 6) // 2], fill=dot_c)
                txt = _truncate_text(draw, task["title"], f_btn, tab_w - 26)
                draw.text((cx + 20, (bar_h - 15) // 2), txt, font=f_btn, fill=fg)
                hits.append({
                    "kind": "window",
                    "x0": cx,
                    "x1": cx + tab_w,
                    "wid": task["wid"],
                    "active": task["active"],
                })
                cx += tab_w + 6

        # 右侧时钟
        draw.text((sw - clk_w + 8, (bar_h - 15) // 2), clock_str, font=f_clk, fill=(203, 213, 225))
        topbar_hits = hits

        raw = img.tobytes("raw", "BGRX")
        topbar_win.put_image(gc, 0, 0, sw, bar_h, X.ZPixmap, depth, 0, raw)
        dpy.sync()

    def focus_or_toggle_window(wid: int, is_active: bool) -> None:
        try:
            target = dpy.create_resource_object("window", int(wid))
            if is_active:
                ev = protocol.event.ClientMessage(
                    window=target,
                    client_type=a_change_state,
                    data=(32, [3, 0, 0, 0, 0]),  # IconicState -> 最小化
                )
            else:
                ev = protocol.event.ClientMessage(
                    window=target,
                    client_type=a_active_win,
                    data=(32, [2, X.CurrentTime, 0, 0, 0]),
                )
            root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
            dpy.flush()
            dpy.sync()
        except Exception:  # noqa: BLE001
            pass

    env = dict(os.environ)
    env["DISPLAY"] = args.display
    env["HOME"] = args.home

    def launch_cmd(cmd: str, label: str) -> None:
        try:
            subprocess.Popen(
                cmd, shell=True, env=env, cwd=args.home,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            print(f"iconlayer: launch {label} -> {cmd}", flush=True)
        except OSError as exc:
            print(f"iconlayer: launch failed {exc}", file=sys.stderr, flush=True)

    paint_desktop()
    paint_topbar(force=True)

    last_click: Dict[str, float] = {}
    running = {"ok": True}

    def _stop(*_a) -> None:
        running["ok"] = False

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    print(f"iconlayer: unified desktop ({len(desktop_hits)} icons + {bar_h}px topbar) on {args.display} ({sw}x{sh})", flush=True)

    fd = dpy.fileno()
    last_poll = time.monotonic()

    while running["ok"]:
        try:
            if dpy.pending_events() == 0:
                readable, _, _ = select.select([fd], [], [], 0.6)
                now_m = time.monotonic()
                if not readable:
                    if now_m - last_poll >= 1.0:
                        last_poll = now_m
                        paint_topbar(force=False)
                    continue
            while dpy.pending_events() > 0 and running["ok"]:
                ev = dpy.next_event()
                if ev.type == X.Expose:
                    if ev.window.id == desktop_win.id and ev.count == 0:
                        paint_desktop()
                    elif ev.window.id == topbar_win.id and ev.count == 0:
                        paint_topbar(force=True)
                elif ev.type == X.PropertyNotify:
                    if ev.atom in (a_client_list, a_active_win):
                        paint_topbar(force=False)
                elif ev.type == X.ButtonPress and ev.detail == 1:
                    if ev.window.id == topbar_win.id:
                        px = ev.event_x
                        for hit in topbar_hits:
                            if hit["x0"] <= px <= hit["x1"]:
                                if hit["kind"] == "launch":
                                    launch_cmd(hit["cmd"], hit["label"])
                                elif hit["kind"] == "window":
                                    focus_or_toggle_window(hit["wid"], hit["active"])
                                break
                    elif ev.window.id == desktop_win.id:
                        px, py = ev.event_x, ev.event_y
                        for hit in desktop_hits:
                            if hit["x"] <= px < hit["x"] + hit["w"] and hit["y"] <= py < hit["y"] + hit["h"]:
                                key = hit["item"]["label"]
                                now_ms = time.time() * 1000.0
                                prev_ms = last_click.get(key, 0.0)
                                last_click[key] = now_ms
                                if now_ms - prev_ms <= args.double_click_ms:
                                    last_click[key] = 0.0
                                    launch_cmd(hit["item"]["cmd"], key)
                                break
            now_m = time.monotonic()
            if now_m - last_poll >= 1.0:
                last_poll = now_m
                paint_topbar(force=False)
        except Exception:  # noqa: BLE001
            break

    for w in (topbar_win, desktop_win):
        try:
            w.destroy()
        except Exception:  # noqa: BLE001
            pass
    try:
        dpy.close()
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
