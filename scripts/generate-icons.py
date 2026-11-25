#!/usr/bin/env python3
"""Generate the extension icons without external image libraries."""

from __future__ import annotations

import os
import struct
import zlib
from pathlib import Path

MASTER = 512
SIZES = (16, 32, 48, 128)


def blend(a: tuple[int, int, int, int], b: tuple[int, int, int, int], t: float):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(4))


def rounded_rect_contains(x: float, y: float, left: float, top: float, right: float, bottom: float, radius: float) -> bool:
    if x < left or x >= right or y < top or y >= bottom:
        return False
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def triangle_contains(x: float, y: float, a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> bool:
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign((x, y), a, b)
    d2 = sign((x, y), b, c)
    d3 = sign((x, y), c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def draw_master() -> list[list[tuple[int, int, int, int]]]:
    pixels: list[list[tuple[int, int, int, int]]] = []
    for y in range(MASTER):
        row = []
        for x in range(MASTER):
            # Transparent outside the rounded app tile.
            if not rounded_rect_contains(x + 0.5, y + 0.5, 8, 8, 504, 504, 112):
                row.append((0, 0, 0, 0))
                continue

            t = (y - 8) / 496
            bg = blend((255, 32, 66, 255), (214, 0, 40, 255), max(0.0, min(1.0, t)))

            # White speech bubble with a tail.
            in_bubble = rounded_rect_contains(x + 0.5, y + 0.5, 92, 112, 420, 326, 52)
            in_tail = triangle_contains(x + 0.5, y + 0.5, (148, 286), (148, 412), (244, 322))
            if in_bubble or in_tail:
                color = (255, 255, 255, 255)
            else:
                color = bg

            # Two red arrows inside the bubble: translate / swap.
            if in_bubble:
                top_bar = 168 <= x <= 336 and 174 <= y <= 194
                top_head = triangle_contains(x + 0.5, y + 0.5, (332, 184), (300, 148), (300, 220))
                bottom_bar = 176 <= x <= 344 and 238 <= y <= 258
                bottom_head = triangle_contains(x + 0.5, y + 0.5, (180, 248), (212, 212), (212, 284))
                if top_bar or top_head or bottom_bar or bottom_head:
                    color = (230, 0, 45, 255)

            row.append(color)
        pixels.append(row)
    return pixels


def downsample(src, size: int):
    bins = [[[0, 0, 0, 0, 0] for _ in range(size)] for _ in range(size)]
    for y, row in enumerate(src):
        dest_y = min(size - 1, int((y + 0.5) * size / MASTER))
        for x, (r, g, b, a) in enumerate(row):
            dest_x = min(size - 1, int((x + 0.5) * size / MASTER))
            cell = bins[dest_y][dest_x]
            cell[0] += r * a
            cell[1] += g * a
            cell[2] += b * a
            cell[3] += a
            cell[4] += 1

    out = []
    for row in bins:
        out_row = []
        for r, g, b, a, count in row:
            if a == 0:
                out_row.append((0, 0, 0, 0))
            else:
                out_row.append((round(r / a), round(g / a), round(b / a), round(a / count)))
        out.append(out_row)
    return out


def png_bytes(pixels) -> bytes:
    height = len(pixels)
    width = len(pixels[0])
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for r, g, b, a in row:
            raw.extend((r, g, b, a))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    repo = Path(__file__).resolve().parent.parent
    out_dir = repo / "src" / "icons"
    out_dir.mkdir(parents=True, exist_ok=True)

    master = draw_master()
    for size in SIZES:
        data = png_bytes(downsample(master, size))
        path = out_dir / f"icon{size}.png"
        path.write_bytes(data)
        print(f"wrote {path.relative_to(repo)} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
