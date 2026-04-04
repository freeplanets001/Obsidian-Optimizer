#!/usr/bin/env python3
"""
Generate branded app icons for Obsidian Optimizer.

Outputs:
- assets/icon.png  (1024x1024)
- assets/icon.ico  (multi-size ICO)
- assets/icon.icns (via iconutil from iconset)
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_color(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        int(lerp(c1[0], c2[0], t)),
        int(lerp(c1[1], c2[1], t)),
        int(lerp(c1[2], c2[2], t)),
    )


def hex_points(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    pts = []
    for i in range(6):
        ang = math.radians(-90 + i * 60)
        pts.append((cx + math.cos(ang) * r, cy + math.sin(ang) * r))
    return pts


def make_base(size: int = 1024) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img, "RGBA")

    # Rounded background clip.
    radius = int(size * 0.22)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size, size), radius=radius, fill=255)

    # Diagonal gradient background.
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg_px = bg.load()
    c1 = (7, 16, 30)
    c2 = (24, 7, 46)
    for y in range(size):
        for x in range(size):
            t = min(1.0, max(0.0, (x * 0.65 + y * 0.35) / (size - 1)))
            r, g, b = lerp_color(c1, c2, t)
            bg_px[x, y] = (r, g, b, 255)

    # Soft cyan glow behind the mark.
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow, "RGBA")
    cx, cy = size // 2, size // 2
    for i in range(10):
        rr = int(size * (0.30 + i * 0.02))
        alpha = int(36 - i * 3)
        gdraw.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=(35, 201, 232, max(alpha, 0)))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=size * 0.03))

    # Compose background and glow using rounded clip.
    composed = Image.alpha_composite(bg, glow)
    img = Image.composite(composed, img, mask)
    draw = ImageDraw.Draw(img, "RGBA")

    # Main gem shape.
    outer_r = size * 0.255
    inner_r = size * 0.195
    outer_hex = hex_points(cx, cy, outer_r)
    inner_hex = hex_points(cx, cy, inner_r)

    draw.polygon(outer_hex, fill=(36, 24, 67, 255))
    draw.line(outer_hex + [outer_hex[0]], fill=(133, 118, 255, 255), width=int(size * 0.014), joint="curve")

    draw.polygon(inner_hex, fill=(31, 69, 97, 240))
    draw.line(inner_hex + [inner_hex[0]], fill=(82, 224, 204, 235), width=int(size * 0.010), joint="curve")

    # Facets.
    top = inner_hex[0]
    right_top = inner_hex[1]
    right_bottom = inner_hex[2]
    bottom = inner_hex[3]
    left_bottom = inner_hex[4]
    left_top = inner_hex[5]

    facets = [
        ([top, right_top, (cx, cy)], (88, 189, 214, 85)),
        ([top, left_top, (cx, cy)], (94, 145, 242, 78)),
        ([right_top, right_bottom, (cx, cy)], (52, 124, 173, 74)),
        ([left_top, left_bottom, (cx, cy)], (47, 120, 156, 74)),
        ([bottom, right_bottom, (cx, cy)], (30, 90, 128, 82)),
        ([bottom, left_bottom, (cx, cy)], (30, 90, 128, 82)),
    ]
    for pts, fill in facets:
        draw.polygon(pts, fill=fill)

    # Center "O" ring mark.
    ring_r = size * 0.106
    ring_w = int(size * 0.030)
    draw.ellipse((cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r), outline=(242, 245, 250, 245), width=ring_w)

    # Spark accent.
    sx, sy = int(size * 0.73), int(size * 0.31)
    spark = [
        (sx, sy - 30),
        (sx + 10, sy - 10),
        (sx + 30, sy),
        (sx + 10, sy + 10),
        (sx, sy + 30),
        (sx - 10, sy + 10),
        (sx - 30, sy),
        (sx - 10, sy - 10),
    ]
    draw.polygon(spark, fill=(133, 245, 232, 230))

    # Inner shadow for depth.
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow, "RGBA")
    sdraw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, outline=(0, 0, 0, 110), width=int(size * 0.02))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=size * 0.012))
    img = Image.alpha_composite(img, shadow)

    return img


def build_outputs() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    base = make_base(1024)

    # Main PNG used by docs and fallback.
    base.save(ASSETS / "icon.png")

    # Multi-resolution ICO for Windows.
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base.save(ASSETS / "icon.ico", sizes=ico_sizes)

    # ICNS for macOS (generated directly by Pillow).
    icns_sizes = [(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)]
    base.save(ASSETS / "icon.icns", sizes=icns_sizes)


if __name__ == "__main__":
    build_outputs()
    print("Generated assets/icon.png, assets/icon.ico, assets/icon.icns")
