"""拡張のアイコンを描く（16 / 48 / 128 と、ストア用の小さなプロモ画像 440×280）。
使い方: python store/make_icons.py
絵: 青い角丸の四角の中に、切り抜く範囲を表す白い [ ] と、再生の三角。
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = (29, 95, 163)      # ui.css の --accent
FG = (255, 255, 255)
ACCENT = (255, 212, 0)  # 囲み枠の黄色


def draw_icon(size):
    s = 8  # きれいに縮むよう大きく描いてから縮小
    S = size * s
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = S * 0.22
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=r, fill=BG)
    # 左右の [ ]（切り抜く範囲）
    t = S * 0.085           # 線の太さ
    m = S * 0.18            # 外側の余白
    h = S * 0.30            # 角の横棒の長さ
    top, bot = S * 0.24, S * 0.76
    for x0, x1, dirn in ((m, m + h, 1), (S - m, S - m - h, -1)):
        d.rectangle((min(x0, x0 + dirn * t), top, max(x0, x0 + dirn * t), bot), fill=FG)
        d.rectangle((min(x0, x1), top, max(x0, x1), top + t), fill=FG)
        d.rectangle((min(x0, x1), bot - t, max(x0, x1), bot), fill=FG)
    # 再生の三角（黄色）
    cx, cy = S * 0.52, S * 0.50
    w, hh = S * 0.13, S * 0.16   # 左右の [ ] の間に収まる大きさ
    d.polygon([(cx - w, cy - hh), (cx - w, cy + hh), (cx + w, cy)], fill=ACCENT)
    return im.resize((size, size), Image.LANCZOS)


for n in (16, 48, 128):
    draw_icon(n).save(os.path.join(ROOT, "extension", "icons", f"{n}.png"))
    print("icon", n)

# ストア用のプロモ画像（任意。440×280）
tile = Image.new("RGB", (440, 280), (243, 243, 241))
icon = draw_icon(160)
tile.paste(icon, (40, 60), icon)
d = ImageDraw.Draw(tile)
try:
    from PIL import ImageFont
    f1 = ImageFont.truetype("C:/Windows/Fonts/meiryob.ttc", 34)
    f2 = ImageFont.truetype("C:/Windows/Fonts/meiryo.ttc", 20)
except Exception:
    f1 = f2 = None
d.text((220, 92), "Clip Maker", fill=(28, 28, 28), font=f1)
d.text((225, 150), "YouTube の場面を\n切り抜き動画に", fill=(85, 85, 85), font=f2)
os.makedirs(os.path.join(ROOT, "store", "screenshots"), exist_ok=True)
tile.save(os.path.join(ROOT, "store", "screenshots", "promo_440x280.png"))
print("promo tile")
