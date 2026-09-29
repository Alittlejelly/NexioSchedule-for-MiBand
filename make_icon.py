from PIL import Image, ImageDraw

S = 4
W = 192 * S
im = Image.new("RGBA", (W, W), (0, 0, 0, 0))
draw = ImageDraw.Draw(im)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


c_bl = (255, 107, 53)
c_mid = (214, 78, 170)
c_tr = (124, 58, 237)

radius = 32 * S
grad = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gp = grad.load()
for y in range(W):
    for x in range(W):
        t = (x + (W - 1 - y)) / (2 * (W - 1))
        if t < 0.5:
            col = lerp(c_bl, c_mid, t / 0.5)
        else:
            col = lerp(c_mid, c_tr, (t - 0.5) / 0.5)
        gp[x, y] = (col[0], col[1], col[2], 255)

mask = Image.new("L", (W, W), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, W - 1, W - 1], radius=radius, fill=255)
im.paste(grad, (0, 0), mask)

inset = 18 * S
inner_r = 22 * S
draw.rounded_rectangle(
    [inset, inset, W - 1 - inset, W - 1 - inset],
    radius=inner_r,
    fill=(255, 255, 255, 255),
)

bar_color = (180, 80, 200, 255)
cx, cy = W // 2, W // 2
bar_h = 18 * S
bar_r = bar_h // 2
gap = 16 * S
w1 = 110 * S
w2 = 70 * S
total_h = bar_h * 2 + gap
y1 = cy - total_h // 2
y2 = y1 + bar_h + gap
x1 = cx - w1 // 2
x2 = cx - w2 // 2
draw.rounded_rectangle([x1, y1, x1 + w1, y1 + bar_h], radius=bar_r, fill=bar_color)
draw.rounded_rectangle([x2, y2, x2 + w2, y2 + bar_h], radius=bar_r, fill=bar_color)

out = im.resize((192, 192), Image.LANCZOS)
out.save(r"D:\mimoProject\src\common\icon.png")
print("saved", out.size, out.mode)
