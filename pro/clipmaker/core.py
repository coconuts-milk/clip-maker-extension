"""切り抜きの中核ロジック（ffmpeg / yt-dlp 呼び出しは関数として分離し、テストで差し替え可能）。"""
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, List, Optional

PRO_MAX_CLIP_SEC = 600      # プロ版の上限。無料版の 30 秒に対し 10 分（ffmpeg の処理時間と YouTube 規約上の常識的範囲）
SRT_TIME_PAT = re.compile(r"^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\s*$")


@dataclass
class ClipSpec:
    video_id: str
    start_sec: float
    end_sec: float
    title: str = ""

    @property
    def length(self) -> float:
        return self.end_sec - self.start_sec


def load_clip(path: str) -> ClipSpec:
    """clip.json を読んで検証する。

    Tests:
        - 正常な json から ClipSpec が返る
        - end <= start なら ValueError
        - 長さが PRO_MAX_CLIP_SEC を超えたら ValueError
        - video_id が YouTube の形式でなければ ValueError
    """
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    for key in ("video_id", "start_sec", "end_sec"):
        if key not in d:
            raise ValueError(f"{path}: '{key}' がありません")
    spec = ClipSpec(str(d["video_id"]), float(d["start_sec"]), float(d["end_sec"]), str(d.get("title", "")))
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", spec.video_id):
        raise ValueError(f"video_id が YouTube の形式ではありません: {spec.video_id!r}")
    if spec.end_sec <= spec.start_sec:
        raise ValueError(f"end_sec({spec.end_sec}) は start_sec({spec.start_sec}) より後である必要があります")
    if spec.length > PRO_MAX_CLIP_SEC:
        raise ValueError(f"長さ {spec.length:.1f}s が上限 {PRO_MAX_CLIP_SEC}s を超えています")
    return spec


def validate_srt(path: str) -> int:
    """編集済み srt の書式を検査し、字幕ブロック数を返す。

    Tests:
        - 正常な srt はブロック数が返る
        - 時刻行の書式が壊れていれば ValueError（行番号つき）
        - 空ファイルは 0
    """
    blocks = 0
    with open(path, encoding="utf-8-sig") as f:
        lines = f.read().splitlines()
    i = 0
    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        if not lines[i].strip().isdigit():
            raise ValueError(f"{path}:{i + 1}: 字幕番号ではありません: {lines[i]!r}")
        if i + 1 >= len(lines) or not SRT_TIME_PAT.match(lines[i + 1]):
            raise ValueError(f"{path}:{i + 2}: 時刻行 'HH:MM:SS,mmm --> HH:MM:SS,mmm' ではありません")
        i += 2
        while i < len(lines) and lines[i].strip():
            i += 1
        blocks += 1
    return blocks


def _require(cmd: str) -> str:
    p = shutil.which(cmd)
    if not p:
        raise RuntimeError(f"{cmd} が見つかりません。インストールして PATH に通してください")
    return p


def download_source(video_id: str, out_dir: str, run: Callable = subprocess.run) -> str:
    """yt-dlp（Python モジュール）で元動画を取得し、ファイルパスを返す。

    Tests:
        - yt-dlp の終了コードが 0 以外なら RuntimeError
        - 出力ファイルが無ければ RuntimeError
    """
    out = os.path.join(out_dir, f"{video_id}.source.mp4")
    if os.path.exists(out):
        return out
    try:
        import yt_dlp  # noqa: F401
    except ImportError as e:
        raise RuntimeError("yt-dlp が未インストールです: pip install yt-dlp") from e
    r = run([sys.executable, "-m", "yt_dlp", "-f", "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/b",
             "--merge-output-format", "mp4", "-o", out,
             f"https://www.youtube.com/watch?v={video_id}"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp 失敗 ({r.returncode}): {r.stderr.strip()[-500:]}")
    if not os.path.exists(out):
        raise RuntimeError(f"yt-dlp は成功したが出力が無い: {out}")
    return out


def ffmpeg_args(source: str, spec: ClipSpec, srt: Optional[str], out: str) -> List[str]:
    """ffmpeg の引数を組み立てる（純関数・テスト対象）。

    Tests:
        - -ss/-to が spec の秒になる
        - srt があれば subtitles フィルタが入る・無ければ入らない
        - Windows パスのコロンが subtitles フィルタ用にエスケープされる
    """
    args = [_require("ffmpeg"), "-y", "-ss", f"{spec.start_sec:.3f}", "-to", f"{spec.end_sec:.3f}", "-i", source]
    if srt:
        esc = srt.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        args += ["-vf", f"subtitles='{esc}'"]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", out]
    return args


def render(clip_json: str, srt: Optional[str], out_dir: str, run: Callable = subprocess.run) -> str:
    """clip.json（+srt）から mp4 を作る。戻り値は出力パス。

    Tests:
        - ffmpeg の終了コードが 0 以外なら RuntimeError
        - srt を渡したのに書式不正なら render 前に ValueError
    """
    spec = load_clip(clip_json)
    if srt:
        validate_srt(srt)
    os.makedirs(out_dir, exist_ok=True)
    src = download_source(spec.video_id, out_dir, run=run)
    out = os.path.join(out_dir, f"{spec.video_id}_{int(spec.start_sec)}.mp4")
    r = run(ffmpeg_args(src, spec, srt, out), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg 失敗 ({r.returncode}): {r.stderr.strip()[-500:]}")
    return out
