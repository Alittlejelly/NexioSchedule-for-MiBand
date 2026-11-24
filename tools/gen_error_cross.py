#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成传输失败页的红圈白叉图标（src/common/error_cross.png）

图形来源：设计稿「画板 1 副本 5.svg」红色圆内的白色叉，由两根圆角矩形组成：
  R1  x 156.46..179.54  y 152.38..257.52  rx/ry 11.54  transform="translate(-95.72 178.82) rotate(-45)"
  R2  同上矩形                                          transform="translate(141.87 468.67) rotate(-135)"

两根条的中心都落在圆心上：把圆角矩形的中心点 (168, 204.95) 分别旋转 ±45° 再平移，
结果仍然是 (168, 204.95)，所以它们只是同一根条换个方向、形成 X。

手环端 Vela 的 CSS 不支持 transform: rotate，叉只能出图。这里用纯标准库
（无 PIL）按上述几何解析求覆盖率，4x 超采样后降采样成 91x91（叉的包围盒
= (105.14 + 23.08) / √2 ≈ 90.68），白色 + alpha，黑底上就是白叉。

用法：python tools/gen_error_cross.py
"""
import math
import os
import struct
import zlib

SS = 4  # 超采样倍数
OUT_W, OUT_H = 91, 91
# 设计稿里叉的包围盒（SVG 用户坐标）：中心 (168, 204.95)，边长 90.68
CX, CY = 168.0, 204.95
HALF = (105.14 + 23.08) / 2 / math.sqrt(2)  # 45.34
X0, Y0 = CX - HALF, CY - HALF
BW = BH = HALF * 2
# 单根条：宽 23.08、长 105.14、圆角 11.54
BAR_W, BAR_L, R = 23.08, 105.14, 11.54
BAR_HW = BAR_W / 2.0
C, S = math.cos(math.radians(45)), math.sin(math.radians(45))


def in_rrect(x, y, x0, y0, x1, y1, r):
    """点是否落在圆角矩形内（轴对齐，x0<x1, y0<y1）"""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def covered(x, y):
    """x/y 是 SVG 用户坐标（圆心上方的叉，未旋转坐标系）"""
    # 转成相对圆心的坐标，再逆旋转 ±45° 回到「竖直条」的局部坐标
    dx, dy = x - CX, y - CY
    for sign in (1, -1):
        # 逆旋转 sign*45°
        lx = C * dx + sign * S * dy
        ly = -sign * S * dx + C * dy
        if in_rrect(lx, ly, -BAR_HW, -BAR_L / 2.0, BAR_HW, BAR_L / 2.0, R):
            return True
    return False


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
    # SSxSS 块平均 → 抗锯齿
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
            raw += bytes((255, 255, 255, a))  # 白色 + alpha，红底/黑底上都是白叉

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
    write_png(os.path.join(root, 'src', 'common', 'error_cross.png'), render())
