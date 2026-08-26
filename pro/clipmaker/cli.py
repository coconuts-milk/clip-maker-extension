"""clipmaker CLI: `clipmaker render <base>.clip.json [--srt <base>.srt] [--out out/]`
または `clipmaker watch [保存フォルダ]`（拡張の保存を監視して自動で mp4 に焼き付ける）"""
import argparse
import os
import sys

from .core import WATCH_INTERVAL_SEC, render, watch


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="clipmaker", description="clip.json + srt から切り抜き mp4 を作る（PC プロ版）")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("clip_json")
    r.add_argument("--srt", help="字幕ファイル（省略時は clip.json と同名の .srt があれば使う）")
    r.add_argument("--out", default="out")
    w = sub.add_parser("watch", help="保存フォルダを監視し、拡張が保存した clip.json を自動で mp4 に焼き付ける")
    w.add_argument("dir", nargs="?", default=os.path.join(os.path.expanduser("~"), "Downloads", "clip-maker"),
                   help="監視するフォルダ（既定: ダウンロード/clip-maker）")
    w.add_argument("--interval", type=float, default=WATCH_INTERVAL_SEC)
    w.add_argument("--once", action="store_true", help="未処理分だけ焼き付けて終了（常駐しない）")
    a = p.parse_args(argv)
    if a.cmd == "watch":
        try:
            watch(a.dir, interval=a.interval, once=a.once)
        except KeyboardInterrupt:
            return 0
        except (ValueError, RuntimeError) as e:
            print(f"エラー: {e}", file=sys.stderr)
            return 1
        return 0
    srt = a.srt
    if srt is None:
        cand = a.clip_json.replace(".clip.json", ".srt")
        srt = cand if os.path.exists(cand) else None
    try:
        out = render(a.clip_json, srt, a.out)
    except (ValueError, RuntimeError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
