"""clipmaker CLI: `clipmaker render <base>.clip.json [--srt <base>.srt] [--out out/]`"""
import argparse
import os
import sys

from .core import render


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="clipmaker", description="clip.json + srt から切り抜き mp4 を作る（PC プロ版）")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("clip_json")
    r.add_argument("--srt", help="字幕ファイル（省略時は clip.json と同名の .srt があれば使う）")
    r.add_argument("--out", default="out")
    a = p.parse_args(argv)
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
