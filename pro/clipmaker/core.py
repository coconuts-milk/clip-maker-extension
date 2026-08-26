"""切り抜きの中核ロジック（ffmpeg / yt-dlp 呼び出しは関数として分離し、テストで差し替え可能）。"""
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable, List, Optional

PRO_MAX_CLIP_SEC = 600      # プロ版の上限。無料版の 30 秒に対し 10 分（ffmpeg の処理時間と YouTube 規約上の常識的範囲）
SECTION_PAD_SEC = 5.0       # 区間ダウンロードの前後余白。--force-keyframes-at-cuts の切断誤差を吸収する
SRT_TIME_PAT = re.compile(r"^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\s*$")


@dataclass
class Mask:
    """動画の一部を矩形で塗りつぶして隠す（スパチャの名前・リスナー名の隠蔽用）。

    x, y, w, h はピクセル。start / end は切り抜き先頭からの相対秒（end=None は切り抜きの最後まで）。
    """
    x: int
    y: int
    w: int
    h: int
    start: float = 0.0
    end: Optional[float] = None


@dataclass
class ClipSpec:
    video_id: str
    start_sec: float
    end_sec: float
    title: str = ""
    masks: List[Mask] = field(default_factory=list)

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
        - masks の矩形が不正（w/h <= 0、end <= start）なら ValueError
    """
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    for key in ("video_id", "start_sec", "end_sec"):
        if key not in d:
            raise ValueError(f"{path}: '{key}' がありません")
    masks = []
    for i, m in enumerate(d.get("masks", [])):
        for key in ("x", "y", "w", "h"):
            if key not in m:
                raise ValueError(f"{path}: masks[{i}] に '{key}' がありません")
        mask = Mask(int(m["x"]), int(m["y"]), int(m["w"]), int(m["h"]),
                    float(m.get("start", 0.0)), None if m.get("end") is None else float(m["end"]))
        if mask.w <= 0 or mask.h <= 0 or mask.x < 0 or mask.y < 0:
            raise ValueError(f"{path}: masks[{i}] の矩形が不正です: x={mask.x} y={mask.y} w={mask.w} h={mask.h}")
        if mask.end is not None and mask.end <= mask.start:
            raise ValueError(f"{path}: masks[{i}] の end({mask.end}) は start({mask.start}) より後である必要があります")
        masks.append(mask)
    spec = ClipSpec(str(d["video_id"]), float(d["start_sec"]), float(d["end_sec"]), str(d.get("title", "")), masks)
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


def download_source(video_id: str, out_dir: str, run: Callable = subprocess.run,
                    start: Optional[float] = None, end: Optional[float] = None) -> str:
    """yt-dlp（Python モジュール）で元動画を取得し、ファイルパスを返す。

    start/end（動画内の絶対秒）を両方渡すと、その区間の前後 SECTION_PAD_SEC 秒だけを
    ダウンロードする（長時間配信の全編ダウンロード回避）。ファイル先頭は
    max(0, start - SECTION_PAD_SEC) 秒に対応する。

    Tests:
        - yt-dlp の終了コードが 0 以外なら RuntimeError
        - 出力ファイルが無ければ RuntimeError
        - start/end の片方だけ指定は ValueError
        - start/end 指定時は --download-sections が引数に入る
    """
    if (start is None) != (end is None):
        raise ValueError("start と end は両方指定するか両方 None にしてください")
    if start is not None:
        sec_start = max(0.0, start - SECTION_PAD_SEC)
        sec_end = end + SECTION_PAD_SEC
        out = os.path.join(out_dir, f"{video_id}_{int(sec_start)}_{int(sec_end)}.section.mp4")
        section = ["--download-sections", f"*{sec_start:.0f}-{sec_end:.0f}", "--force-keyframes-at-cuts"]
    else:
        out = os.path.join(out_dir, f"{video_id}.source.mp4")
        section = []
    if os.path.exists(out):
        return out
    try:
        import yt_dlp  # noqa: F401
    except ImportError as e:
        raise RuntimeError("yt-dlp が未インストールです: pip install yt-dlp") from e
    r = run([sys.executable, "-m", "yt_dlp", "-f", "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/b",
             "--merge-output-format", "mp4", *section, "-o", out,
             f"https://www.youtube.com/watch?v={video_id}"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp 失敗 ({r.returncode}): {r.stderr.strip()[-500:]}")
    if not os.path.exists(out):
        raise RuntimeError(f"yt-dlp は成功したが出力が無い: {out}")
    return out


def ffmpeg_args(source: str, spec: ClipSpec, srt: Optional[str], out: str, src_offset: float = 0.0) -> List[str]:
    """ffmpeg の引数を組み立てる（純関数・テスト対象）。

    src_offset: source ファイルの先頭が動画内の何秒に対応するか（区間ダウンロード時に非 0）。
    -ss を入力前に置くため出力のタイムスタンプは 0 起点になり、srt（切り抜き先頭からの相対時刻）
    と masks の enable='between(t,...)'（同じく相対秒）がそのまま一致する。

    Tests:
        - -ss/-to が spec の秒になる（src_offset 分ずれる）
        - srt があれば subtitles フィルタが入る・無ければ入らない
        - Windows パスのコロンが subtitles フィルタ用にエスケープされる
        - masks があれば drawbox フィルタが入る（end=None は切り抜き末尾まで）
    """
    args = [_require("ffmpeg"), "-y", "-ss", f"{spec.start_sec - src_offset:.3f}",
            "-to", f"{spec.end_sec - src_offset:.3f}", "-i", source]
    filters = []
    for m in spec.masks:
        m_end = spec.length if m.end is None else m.end
        filters.append(f"drawbox=x={m.x}:y={m.y}:w={m.w}:h={m.h}:color=black@1:t=fill"
                       f":enable='between(t,{m.start:.3f},{m_end:.3f})'")
    if srt:
        esc = srt.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        filters.append(f"subtitles='{esc}'")
    if filters:
        args += ["-vf", ",".join(filters)]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", out]
    return args


def render(clip_json: str, srt: Optional[str], out_dir: str, run: Callable = subprocess.run) -> str:
    """clip.json（+srt）から mp4 を作る。戻り値は出力パス。

    元動画は全編ソース（{id}.source.mp4）が既にあればそれを使い、無ければ
    区間ダウンロード（前後 SECTION_PAD_SEC 秒の余白つき）で取得する。

    Tests:
        - ffmpeg の終了コードが 0 以外なら RuntimeError
        - srt を渡したのに書式不正なら render 前に ValueError
        - 全編ソースが無いときは区間ダウンロードになり -ss が区間相対に補正される
    """
    spec = load_clip(clip_json)
    if srt:
        validate_srt(srt)
    os.makedirs(out_dir, exist_ok=True)
    full = os.path.join(out_dir, f"{spec.video_id}.source.mp4")
    if os.path.exists(full):
        src, offset = full, 0.0
    else:
        src = download_source(spec.video_id, out_dir, run=run, start=spec.start_sec, end=spec.end_sec)
        offset = max(0.0, spec.start_sec - SECTION_PAD_SEC)
    # 同じ開始秒で長さ違いの切り抜きを上書きしないよう end も名前に入れる
    out = os.path.join(out_dir, f"{spec.video_id}_{int(spec.start_sec)}_{int(spec.end_sec)}.mp4")
    r = run(ffmpeg_args(src, spec, srt, out, src_offset=offset), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg 失敗 ({r.returncode}): {r.stderr.strip()[-500:]}")
    return out
