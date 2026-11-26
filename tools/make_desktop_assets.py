"""生成 BotScreen 桌面视觉资源：壁纸 + 图标（256px PNG，风格对齐参考图）。

输出到 botscreen/desktop/assets/，随代码一起分发；运行时不依赖绘图库。
用法: python3 tools/make_desktop_assets.py
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "botscreen", "desktop", "assets")
S = 4  # 超采样倍数，画完再缩小，边缘更干净


def canvas(size: int = 256) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (size * S, size * S), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def finish(img: Image.Image, name: str, size: int = 256) -> None:
    out = img.resize((size, size), Image.LANCZOS)
    path = os.path.join(OUT, name)
    out.save(path, optimize=True)
    print(f"  {name} {os.path.getsize(path)} B")


# ---------------------------------------------------------------- 壁纸 ------
def wallpaper(w: int = 1280, h: int = 720, name: str = "wallpaper.png") -> None:
    """参考图那种蓝底 + 斜向几何光斑。"""
    base_top = (22, 92, 138)
    base_bot = (16, 68, 106)
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        r = int(base_top[0] + (base_bot[0] - base_top[0]) * t)
        g = int(base_top[1] + (base_bot[1] - base_top[1]) * t)
        b = int(base_top[2] + (base_bot[2] - base_top[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)

    # 斜向方块图案（半透明，制造参考图那种"瓦片"感）
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    tile = 190
    for row in range(-2, h // tile + 3):
        for col in range(-2, w // tile + 3):
            x0 = col * tile + (row % 2) * tile // 2
            y0 = row * int(tile * 0.62)
            skew = 34
            pts = [(x0 + skew, y0), (x0 + tile, y0), (x0 + tile - skew, y0 + int(tile * 0.62)),
                   (x0, y0 + int(tile * 0.62))]
            d.polygon(pts, fill=(255, 255, 255, 7), outline=(255, 255, 255, 10))
    img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")

    # 左上角柔和高光
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-w * 0.35, -h * 0.6, w * 0.9, h * 0.9], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    white = Image.new("RGB", (w, h), (255, 255, 255))
    img = Image.composite(white, img, glow.point(lambda v: int(v * 0.35)))

    path = os.path.join(OUT, name)
    img.save(path, optimize=True)
    print(f"  {name} {os.path.getsize(path)} B")


# ---------------------------------------------------------------- 图标 ------
def icon_folder(name: str = "folder.png") -> None:
    img, d = canvas()
    w = 256 * S
    body = (66, 133, 244)
    body_dark = (43, 108, 214)
    # 底部主体
    d.rounded_rectangle([28 * S, 76 * S, 228 * S, 208 * S], radius=26 * S,
                        fill=body, outline=body_dark, width=6 * S)
    # 顶部标签
    d.rounded_rectangle([28 * S, 58 * S, 118 * S, 106 * S], radius=18 * S, fill=body)
    d.rectangle([28 * S, 86 * S, 118 * S, 106 * S], fill=body)
    # 高光
    d.rounded_rectangle([40 * S, 92 * S, 216 * S, 196 * S], radius=20 * S, fill=(120, 172, 250))
    d.rounded_rectangle([40 * S, 92 * S, 216 * S, 150 * S], radius=18 * S, fill=(96, 156, 246))
    finish(img, name)


def icon_disk(name: str = "drive.png") -> None:
    img, d = canvas()
    d.rounded_rectangle([36 * S, 46 * S, 220 * S, 210 * S], radius=22 * S,
                        fill=(238, 241, 245), outline=(198, 205, 214), width=5 * S)
    d.rounded_rectangle([36 * S, 46 * S, 220 * S, 96 * S], radius=20 * S, fill=(250, 251, 253))
    d.rectangle([36 * S, 88 * S, 220 * S, 96 * S], fill=(250, 251, 253))
    for i in range(3):
        y = 120 * S + i * 26 * S
        d.rounded_rectangle([58 * S, y, 198 * S, y + 12 * S], radius=6 * S, fill=(214, 220, 228))
    d.ellipse([172 * S, 56 * S, 200 * S, 84 * S], fill=(120, 200, 140))
    finish(img, name)


def icon_trash(name: str = "trash.png") -> None:
    img, d = canvas()
    d.rounded_rectangle([74 * S, 66 * S, 182 * S, 212 * S], radius=16 * S,
                        fill=(226, 231, 237), outline=(180, 188, 198), width=5 * S)
    d.rounded_rectangle([82 * S, 78 * S, 174 * S, 200 * S], radius=12 * S, fill=(245, 247, 250))
    for i, x in enumerate((108, 128, 148)):
        d.rounded_rectangle([x * S, 96 * S, (x + 8) * S, 182 * S], radius=4 * S, fill=(198, 206, 216))
    d.rounded_rectangle([60 * S, 50 * S, 196 * S, 74 * S], radius=10 * S,
                        fill=(209, 216, 224), outline=(176, 184, 194), width=4 * S)
    d.rounded_rectangle([110 * S, 34 * S, 146 * S, 52 * S], radius=8 * S, fill=(209, 216, 224))
    finish(img, name)


def icon_chrome(name: str = "chrome.png") -> None:
    """简化 Chrome 圆环：三段彩色 + 蓝心。"""
    img, d = canvas()
    cx = cy = 128 * S
    r = 96 * S
    width = 46 * S
    colors = [(219, 68, 55), (251, 188, 5), (52, 168, 83)]  # 红 黄 绿
    for i, color in enumerate(colors):
        start = -90 + i * 120
        d.arc([cx - r, cy - r, cx + r, cy + r], start, start + 120, fill=color, width=width)
    # 内圈留白
    d.ellipse([cx - r + width, cy - r + width, cx + r - width, cy + r - width], fill=(250, 250, 252))
    # 蓝色核心
    ir = 40 * S
    d.ellipse([cx - ir, cy - ir, cx + ir, cy + ir], fill=(66, 133, 244))
    d.ellipse([cx - ir, cy - ir, cx + ir, cy + ir], outline=(255, 255, 255), width=5 * S)
    finish(img, name)


def icon_search(name: str = "search.png") -> None:
    img, d = canvas()
    d.ellipse([56 * S, 56 * S, 176 * S, 176 * S], outline=(240, 244, 248), width=18 * S)
    d.line([168 * S, 168 * S, 212 * S, 212 * S], fill=(240, 244, 248), width=20 * S)
    d.ellipse([56 * S, 56 * S, 176 * S, 176 * S], outline=(225, 232, 240), width=6 * S)
    finish(img, name)


def icon_terminal(name: str = "terminal.png") -> None:
    img, d = canvas()
    d.rounded_rectangle([26 * S, 46 * S, 230 * S, 210 * S], radius=22 * S,
                        fill=(28, 32, 38), outline=(60, 68, 78), width=5 * S)
    d.rounded_rectangle([26 * S, 46 * S, 230 * S, 88 * S], radius=20 * S, fill=(42, 48, 56))
    d.rectangle([26 * S, 78 * S, 230 * S, 88 * S], fill=(42, 48, 56))
    for i, x in enumerate((50, 70, 90)):
        d.ellipse([x * S, 60 * S, (x + 12) * S, 72 * S],
                  fill=[(237, 106, 94), (245, 191, 79), (98, 197, 84)][i])
    # >_
    d.line([62 * S, 122 * S, 96 * S, 146 * S], fill=(120, 220, 160), width=12 * S)
    d.line([62 * S, 170 * S, 96 * S, 146 * S], fill=(120, 220, 160), width=12 * S)
    d.rounded_rectangle([106 * S, 166 * S, 150 * S, 178 * S], radius=4 * S, fill=(120, 220, 160))
    finish(img, name)


def icon_codex(name: str = "codex.png") -> None:
    """参考图里 Codex 是白底圆角方块 + 黑色螺旋；这里画近似三段弧。"""
    img, d = canvas()
    d.rounded_rectangle([18 * S, 18 * S, 238 * S, 238 * S], radius=46 * S, fill=(252, 252, 253))
    d.rounded_rectangle([18 * S, 18 * S, 238 * S, 238 * S], radius=46 * S,
                        outline=(226, 230, 235), width=4 * S)
    cx = cy = 128 * S
    r = 52 * S
    for i in range(3):
        start = -70 + i * 120
        d.arc([cx - r, cy - r, cx + r, cy + r], start, start + 96, fill=(24, 24, 26), width=15 * S)
    # 内部小三角指向，模拟螺旋收束
    d.polygon([(cx + 10 * S, cy - 30 * S), (cx + 46 * S, cy - 6 * S), (cx + 8 * S, cy + 6 * S)],
              fill=(24, 24, 26))
    finish(img, name)


def icon_text_placeholder(name: str, glyph: str, bg, fg, font_path: str) -> None:
    img, d = canvas()
    d.rounded_rectangle([16 * S, 16 * S, 240 * S, 240 * S], radius=44 * S, fill=bg)
    try:
        font = ImageFont.truetype(font_path, 120 * S)
        bbox = d.textbbox((0, 0), glyph, font=font)
        d.text(((256 * S - (bbox[2] - bbox[0])) / 2 - bbox[0],
                (256 * S - (bbox[3] - bbox[1])) / 2 - bbox[1]), glyph, font=font, fill=fg)
    except OSError:
        pass
    finish(img, name)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    print("壁纸:")
    wallpaper()
    print("图标:")
    icon_disk()
    icon_folder()
    icon_codex()
    icon_chrome()
    icon_trash()
    icon_search()
    icon_terminal()
    # dock 用的稍小尺寸版本由 tint2 缩放，不需要单独出


if __name__ == "__main__":
    main()