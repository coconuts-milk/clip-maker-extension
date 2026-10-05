"""ストア提出用のファイルを作る。
使い方: python store/make_assets.py
出来るもの:
  store/clip-maker-extension-<version>.zip  … extension/ をそのまま zip にしたもの（アップロードする）
  store/screenshots/*.png                   … 1280×800 のスクリーンショット（e2e/shots の画像から作る。無ければ飛ばす）
"""
import json, os, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
STORE = os.path.join(ROOT, "store")

version = json.load(open(os.path.join(EXT, "manifest.json"), encoding="utf-8"))["version"]
build = open(os.path.join(EXT, "common.js"), encoding="utf-8").read().split('const BUILD = "')[1].split('"')[0]
if build != version:
    sys.exit(f"manifest の version ({version}) と common.js の BUILD ({build}) が違います。同じ値にしてから作ってください")

# ---- zip ----
out = os.path.join(STORE, f"clip-maker-extension-{version}.zip")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(EXT):
        for f in files:
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, EXT))
print(f"zip: {out} ({os.path.getsize(out) / 1048576:.1f} MB)")

# ---- screenshots（1280×800）----
try:
    from PIL import Image
except ImportError:
    print("Pillow が無いのでスクリーンショットは作りません（pip install pillow）")
    sys.exit()
shots = os.path.join(ROOT, "e2e", "shots")
dst = os.path.join(STORE, "screenshots")
os.makedirs(dst, exist_ok=True)
W, H = 1280, 800
for name in ["editor_yoko.png", "editor_tate.png", "editor_asr.png", "recording.png", "panel.png"]:
    src = os.path.join(shots, name)
    if not os.path.exists(src):
        continue
    im = Image.open(src).convert("RGB")
    # 幅を 1280 に合わせ、上から 800 を切る（編集画面は上部に主要な操作がある）
    scale = W / im.width
    im = im.resize((W, max(H, round(im.height * scale))), Image.LANCZOS)
    im = im.crop((0, 0, W, H))
    im.save(os.path.join(dst, name))
    print("screenshot:", os.path.join(dst, name))
