#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成回传浮层的白色箭头图标（src/common/xfer_arrow.png）

图形来源：设计稿「画板 1 副本 4.svg」蓝色圆内的白色箭头，由三个圆角矩形组成：
  R1  x 140.17..161.52  y 149.55..219.43  rx 10.68  rotate(45)  translate(174.63,-52.63)
  R2  x 174.48..195.83  y 149.55..219.43  rx 10.68  rotate(-45) translate(-76.22,184.96)
  R3  x 157.32..178.67  y 170.62..253.23  rx 10.68  （竖杆）

手环端 Vela 的 CSS 不支持 transform: rotate，箭头只能出图。这里用纯标准库
（无 PIL）按上述几何解析求覆盖率，4x 超采样后降采样成 99x101，白底透明。

用法：python tools/gen_xfer_arrow.py
"""
import math
import os
import struct
import zlib

SS = 4  # 超采样倍数
OUT_W, OUT_H = 99, 101
# 设计稿里箭头的包围盒（SVG 用户坐标）
X0, Y0 = 118.59, 152.23
BW, BH = 98.82, 101.0
R = 10.68
C, S = math.cos(math.radians(45)), math.sin(math.radians(45))


def in_rrect(x, y, x0, y0, x1, y1, r):
    """点是否落在圆角矩形内（轴对齐，x0<x1, y0<y1）"""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def covered(x, y):
    # R1：先平移回原点，再逆旋转 45°
    dx, dy = x - 174.63, y + 52.63
    lx, ly = C * dx + S * dy, -S * dx + C * dy
    if in_rrect(lx, ly, 140.17, 149.55, 161.52, 219.43, R):
        return True
    # R2：平移回原点后逆旋转 -45°（即正向旋转 45°）
    dx, dy = x + 76.22, y - 184.96
    lx, ly = C * dx - S * dy, S * dx + C * dy
    if in_rrect(lx, ly, 174.48, 149.55, 195.83, 219.43, R):
        return True
    # R3：竖杆，无变换
    return in_rrect(x, y, 157.32, 170.62, 178.67, 253.23, R)


def render():
    w, h = OUT_W * SS, OUT_H * SS
    alpha = bytearray(w * h)
    step_x, step_y = BW / w, BH / h
    for j in range(h):
        y = Y0 + (j + 0.5) * step_y
        base = j * w
        for i in range(w):
            x = X0 + (i + 0.5) * step_x
            alpha[base + i] = 255 if covered(x, y) else 0
    # 4x4 块平均 → 抗锯齿
    out = bytearray(OUT_W * OUT_H)
    for j in range(OUT_H):
        for i in range(OUT_W):
            total = 0
            for sj in range(SS):
                row = (j * SS + sj) * w + i * SS
                for si in range(SS):
                    total += alpha[row + si]
            out[j * OUT_W + i] = total // (SS * SS)
    return out


def write_png(path, alpha):
    raw = bytearray()
    for j in range(OUT_H):
        raw.append(0)  # filter: none
        for i in range(OUT_W):
            a = alpha[j * OUT_W + i]
            raw += bytes((255, 255, 255, a))  # 白色 + alpha，黑底上就是白箭头

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack('>IIBBBBB', OUT_W, OUT_H, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    print('wrote %s (%dx%d, %d bytes)' % (path, OUT_W, OUT_H, len(png)))


if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    write_png(os.path.join(root, 'src', 'common', 'xfer_arrow.png'), render())
