"""切り抜きの中核ロジック（ffmpeg / yt-dlp 呼び出しは関数として分離し、テストで差し替え可能）。"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

PRO_MAX_CLIP_SEC = 600      # プロ版の上限。無料版の 30 秒に対し 10 分（ffmpeg の処理時間と YouTube 規約上の常識的範囲）
SECTION_PAD_SEC = 5.0       # 区間ダウンロードの前後余白。--force-keyframes-at-cuts の切断誤差を吸収する
SRT_TIME_PAT = re.compile(r"^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\s*$")
# Chrome は同名ファイルを「name.clip (1).json」にリネームする。srt / mp4 も同じ連番で対応づける
CLIP_JSON_PAT = re.compile(r"^(?P<stem>.+)\.clip(?P<dup> \(\d+\))?\.json$")
WATCH_STABLE_SEC = 1.5      # 保存直後の書きかけファイルを掴まないための猶予（Chrome の .crdownload → リネーム対策）
WATCH_INTERVAL_SEC = 2.0    # 監視の巡回間隔。保存操作の粒度（数秒〜）に対して十分速く、CPU 負荷は無視できる

# 出力レイアウト（拡張 common.js の VIDEO_W/H・PORTRAIT_W/H と同じ値。座標系の基準）
SRC_W, SRC_H = 1920, 1080               # マスク・crop 座標の基準。元動画は先に必ずこの解像度へ scale する
PORTRAIT_W, PORTRAIT_H = 1080, 1920     # Shorts 用 9:16
FRAME_MODES = ("landscape", "portrait")

# チャット焼き込みの既定（拡張 DEFAULT_CHAT_OVERLAY と同じ。clip.json に無い古い形式は enabled=False で焼く）
DEFAULT_CHAT_OVERLAY = {"enabled": False, "max": 5, "show_sec": 8.0, "x_pct": 62.0, "y_pct": 6.0, "w_pct": 36.0, "font_pct": 3.2}


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
class Crop:
    """縦（portrait）出力で元画面（SRC_W×SRC_H 基準）から切り出す矩形。"""
    x: int
    y: int
    w: int
    h: int


@dataclass
class ClipSpec:
    video_id: str
    start_sec: float
    end_sec: float
    title: str = ""
    masks: List[Mask] = field(default_factory=list)
    mode: str = "landscape"                     # FRAME_MODES
    crop: Optional[Crop] = None                 # portrait のとき必須
    chat_overlay: Dict = field(default_factory=lambda: dict(DEFAULT_CHAT_OVERLAY))

    @property
    def length(self) -> float:
        return self.end_sec - self.start_sec

    @property
    def out_size(self) -> tuple:
        return (PORTRAIT_W, PORTRAIT_H) if self.mode == "portrait" else (SRC_W, SRC_H)


def load_clip(path: str) -> ClipSpec:
    """clip.json を読んで検証する。

    Tests:
        - 正常な json から ClipSpec が返る
        - end <= start なら ValueError
        - 長さが PRO_MAX_CLIP_SEC を超えたら ValueError
        - video_id が YouTube の形式でなければ ValueError
        - masks の矩形が不正（w/h <= 0、end <= start）なら ValueError
        - frame.mode=portrait で crop が無い／はみ出していれば ValueError
        - frame が無い古い clip.json は landscape・チャット焼き込みなし
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
    frame = d.get("frame") or {"mode": "landscape"}
    mode = str(frame.get("mode", "landscape"))
    if mode not in FRAME_MODES:
        raise ValueError(f"{path}: frame.mode が不正です: {mode!r}（{' / '.join(FRAME_MODES)}）")
    crop = None
    if mode == "portrait":
        c = frame.get("crop")
        if not c or any(k not in c for k in ("x", "y", "w", "h")):
            raise ValueError(f"{path}: frame.mode=portrait には frame.crop {{x,y,w,h}} が必要です")
        crop = Crop(int(c["x"]), int(c["y"]), int(c["w"]), int(c["h"]))
        if crop.w <= 0 or crop.h <= 0 or crop.x < 0 or crop.y < 0 or crop.x + crop.w > SRC_W or crop.y + crop.h > SRC_H:
            raise ValueError(f"{path}: frame.crop が {SRC_W}×{SRC_H} からはみ出しています: {crop}")
    ov = dict(DEFAULT_CHAT_OVERLAY)
    ov.update(d.get("chat_overlay") or {})
    ov["enabled"] = bool(ov["enabled"])
    for k in ("max", "show_sec", "x_pct", "y_pct", "w_pct", "font_pct"):
        try:
            ov[k] = float(ov[k])
        except (TypeError, ValueError):
            raise ValueError(f"{path}: chat_overlay.{k} が数値ではありません: {ov[k]!r}")
    ov["max"] = int(ov["max"])
    if ov["enabled"] and (ov["max"] < 1 or ov["w_pct"] <= 0 or ov["font_pct"] <= 0):
        raise ValueError(f"{path}: chat_overlay の max / w_pct / font_pct は正の数にしてください")
    spec = ClipSpec(str(d["video_id"]), float(d["start_sec"]), float(d["end_sec"]), str(d.get("title", "")), masks,
                    mode, crop, ov)
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
    fmt = "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/b"
    if start is not None:
        sec_start = max(0.0, start - SECTION_PAD_SEC)
        sec_end = end + SECTION_PAD_SEC
        out = os.path.join(out_dir, f"{video_id}_{int(sec_start)}_{int(sec_end)}.section.mp4")
        section = ["--download-sections", f"*{sec_start:.0f}-{sec_end:.0f}", "--force-keyframes-at-cuts"]
        # 区間ダウンロードは HLS(m3u8) を優先する。https 形式だと yt-dlp が ffmpeg 直結で
        # ダウンロードし YouTube に速度を絞られて実測 70 分以上かかる（HLS は同じ 26 秒区間が約 1 分）。
        # HLS が無い動画だけ通常形式に落ちる（フォーマット選好であり P-03 のフォールバックではない）。
        fmt = f"bv*[ext=mp4][height<=1080][protocol^=m3u8]+ba[protocol^=m3u8]/{fmt}"
    else:
        out = os.path.join(out_dir, f"{video_id}.source.mp4")
        section = []
    if os.path.exists(out):
        return out
    try:
        import yt_dlp  # noqa: F401
    except ImportError as e:
        raise RuntimeError("yt-dlp が未インストールです: pip install yt-dlp") from e
    r = run([sys.executable, "-m", "yt_dlp", "-f", fmt,
             "--merge-output-format", "mp4", *section, "-o", out,
             f"https://www.youtube.com/watch?v={video_id}"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp 失敗 ({r.returncode}): {r.stderr.strip()[-500:]}")
    if not os.path.exists(out):
        raise RuntimeError(f"yt-dlp は成功したが出力が無い: {out}")
    return out


# 焼き付け字幕の見た目。白文字+黒縁太字は背景の明暗に依存せず読める（放送字幕の定石）。
# 2026-09-28: SRT+force_style から ASS 生成に変更（チャット焼き込みと縦出力で位置・大きさを出力解像度に合わせるため）。
# 文字の大きさは「出力の短辺」に対する % で持つ（横 1080 高＝縦 1080 幅で同じ px になり、縦でも字幕が画面幅に収まる）。
# 拡張 editor.js のプレビューも同じ比率（min(幅,高) × %）。
# 行の折り返しは自前で行う（libass は libunibreak 無しビルドだと空白の無い日本語を折り返さない＝2026-09-28 gyan ffmpeg 9.0 で実測）。
SUBTITLE_FONT = "Meiryo"        # Windows 標準の和文ゴシック（可読性重視）
CAPTION_FONT_PCT = 6.9          # 字幕の文字高 = 短辺の 6.9%（旧 FontSize 20 / PlayResY 288）
CAPTION_OUTLINE_PCT = 0.7       # 黒縁 = 短辺の 0.7%（旧 Outline 2 / 288）
CAPTION_MARGIN_V_PCT = 7.0      # 下端からの余白（出力高に対する %。プレーヤーの UI と重ねない）
CAPTION_MARGIN_H_PCT = 4.0      # 左右の余白（出力幅に対する %）
CHAT_OUTLINE_PCT = 0.35         # チャットは字幕より細い縁（小さい文字が潰れない）
ASCII_CHAR_EM = 0.55            # 折り返し幅の見積り: 半角 1 文字 ≒ 0.55em、全角 1 文字 ≒ 1em（Meiryo 太字の実測に近い値）
CHAT_AMOUNT_COLOR = "&H0000D4FF"  # スパチャ金額の色（ASS は BGR。= #FFD400 黄）
CHAT_LINE_GAP = 0.3             # チャット行間（文字高に対する比）


def parse_srt(path: str) -> List[dict]:
    """srt（拡張が保存したもの・手で編集したもの）を [{start, end, text}] にする。秒は 0 起点。

    validate_srt を通してから呼ぶ（書式不正はそちらで行番号つきエラーになる）。
    Tests:
        - 2 ブロックの srt が 2 要素になり、時刻が秒に変換される
        - 複数行の本文は改行で連結される
    """
    validate_srt(path)
    with open(path, encoding="utf-8-sig") as f:
        lines = f.read().splitlines()
    cues, i = [], 0
    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        m = SRT_TIME_PAT.match(lines[i + 1])
        g = [int(x) for x in m.groups()]
        start = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
        end = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
        i += 2
        text = []
        while i < len(lines) and lines[i].strip():
            text.append(lines[i])
            i += 1
        if "\n".join(text).strip():
            cues.append({"start": start, "end": end, "text": "\n".join(text)})
    return cues


def load_chat(path: str) -> List[dict]:
    """chat.json（拡張が保存した [{t, author, text, amount?, type?}]）を読む。t は切り抜き先頭からの秒。

    Tests:
        - リストでなければ ValueError／t の無い要素は ValueError
    """
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    if not isinstance(d, list):
        raise ValueError(f"{path}: チャットはリストである必要があります")
    out = []
    for i, m in enumerate(d):
        if not isinstance(m, dict) or "t" not in m:
            raise ValueError(f"{path}: [{i}] に 't'（秒）がありません")
        out.append({"t": float(m["t"]), "text": str(m.get("text", "")), "amount": m.get("amount")})
    return out


def visible_chat(chat: List[dict], t: float, ov: Dict) -> List[dict]:
    """時刻 t に画面に出ているチャット（拡張 editor.js の visibleChat と同じ規則: t 以前・show_sec 未満・新しい順に max 件。t+show_sec ちょうどで消える）。"""
    show = float(ov["show_sec"])
    vis = [m for m in chat if m["t"] <= t and (show <= 0 or t - m["t"] < show)]
    vis.sort(key=lambda m: -m["t"])
    return vis[: int(ov["max"])]


def _ass_time(sec: float) -> str:
    cs = int(round(max(0.0, sec) * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _ass_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")


def _char_em(ch: str) -> float:
    return ASCII_CHAR_EM if ord(ch) < 0x3000 else 1.0   # 0x3000 未満 = ASCII・ラテン・記号（半角扱い）


def wrap_text(text: str, max_px: float, font_px: float) -> str:
    """幅 max_px に収まるよう改行を入れる（純関数・テスト対象）。空白の無い日本語もどこでも折り返す。

    Tests:
        - 全角 10 文字・幅 5 文字分 → 2 行
        - 元の改行は保持し、各行を個別に折り返す
        - 収まる行はそのまま
    """
    out = []
    for line in text.split("\n"):
        cur, width = "", 0.0
        for ch in line:
            w = _char_em(ch) * font_px
            if cur and width + w > max_px:
                out.append(cur)
                cur, width = "", 0.0
            cur += ch
            width += w
        out.append(cur)
    return "\n".join(out)


def build_ass(cues: List[dict], chat: List[dict], spec: ClipSpec) -> str:
    """字幕（下中央）とチャット（指定枠・新しい順に積む）を 1 つの ASS にする（純関数・テスト対象）。

    チャットは「見えている組が変わる時刻」（各チャットの t と t+show_sec）で区切り、区間ごとに
    1 つの Dialogue（複数行）を出す。枠は MarginL/R/V + Alignment 7（左上）で表し、libass が枠幅で折り返す。
    Tests:
        - PlayRes が出力解像度（横 1920×1080 / 縦 1080×1920）になる
        - 字幕 1 件が Caption スタイルの Dialogue になり時刻が ASS 形式
        - チャット 2 件（show_sec=8）で表示の組が変わる区間ごとに Dialogue が出る／enabled=False なら出ない
        - 金額付きは黄色（CHAT_AMOUNT_COLOR）で始まる
    """
    w, h = spec.out_size
    short = min(w, h)
    ov = spec.chat_overlay
    cap_size = round(short * CAPTION_FONT_PCT / 100)
    cap_outline = max(1, round(short * CAPTION_OUTLINE_PCT / 100))
    cap_margin = round(h * CAPTION_MARGIN_V_PCT / 100)
    cap_margin_h = round(w * CAPTION_MARGIN_H_PCT / 100)
    chat_size = max(1, round(short * float(ov["font_pct"]) / 100))
    chat_outline = max(1, round(short * CHAT_OUTLINE_PCT / 100))
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {w}",
        f"PlayResY: {h}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Caption,{SUBTITLE_FONT},{cap_size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{cap_outline},0,2,"
        f"{cap_margin_h},{cap_margin_h},{cap_margin},1",
        f"Style: Chat,{SUBTITLE_FONT},{chat_size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{chat_outline},0,7,0,0,0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for c in cues:
        if not c["text"].strip() or c["end"] <= c["start"]:
            continue
        text = wrap_text(c["text"], w - 2 * cap_margin_h, cap_size)
        lines.append(f"Dialogue: 0,{_ass_time(c['start'])},{_ass_time(c['end'])},Caption,,0,0,0,,{_ass_escape(text)}")
    if ov.get("enabled") and chat:
        show = float(ov["show_sec"])
        ml = round(w * float(ov["x_pct"]) / 100)
        mr = max(0, round(w - w * (float(ov["x_pct"]) + float(ov["w_pct"])) / 100))
        mv = round(h * float(ov["y_pct"]) / 100)
        gap = round(chat_size * CHAT_LINE_GAP)
        pts = {0.0, spec.length}
        for m in chat:
            pts.add(m["t"])
            if show > 0:
                pts.add(m["t"] + show)
        pts = sorted(p for p in pts if 0.0 <= p <= spec.length)
        for t0, t1 in zip(pts, pts[1:]):
            if t1 - t0 < 0.005:
                continue
            vis = visible_chat(chat, t0, ov)
            if not vis:
                continue
            rows = []
            box_w = w - ml - mr
            for m in vis:
                if m.get("amount"):
                    # 金額（黄）+ 本文。折り返しは金額込みの 1 行として計算してから色を付ける
                    amt = str(m["amount"])
                    wrapped = wrap_text(f"{amt} {m['text']}", box_w, chat_size)
                    txt = f"{{\\c{CHAT_AMOUNT_COLOR}}}{_ass_escape(amt)}{{\\c&H00FFFFFF}}{_ass_escape(wrapped[len(amt):])}"
                else:
                    txt = _ass_escape(wrap_text(m["text"], box_w, chat_size))
                rows.append(txt)
            # 行間: 空行だと libass が潰すので小さいフォントの空白行を挟む
            body = f"\\N{{\\fs{gap}}} {{\\r}}\\N".join(rows) if gap > 0 else "\\N".join(rows)
            lines.append(f"Dialogue: 1,{_ass_time(t0)},{_ass_time(t1)},Chat,,{ml},{mr},{mv},,{body}")
    return "\n".join(lines) + "\n"


def video_filters(spec: ClipSpec, ass: Optional[str]) -> List[str]:
    """-vf のフィルタ列（純関数・テスト対象）。順番: 基準解像度へ scale → マスク（元画面座標）→ 縦なら crop+scale → 字幕/チャット。

    Tests:
        - 横: scale=1920:1080 が先頭、drawbox が続く、ass があれば subtitles が末尾
        - 縦: crop=w:h:x:y と scale=1080:1920 が drawbox の後・subtitles の前
    """
    filters = [f"scale={SRC_W}:{SRC_H}"]
    for m in spec.masks:
        m_end = spec.length if m.end is None else m.end
        filters.append(f"drawbox=x={m.x}:y={m.y}:w={m.w}:h={m.h}:color=black@1:t=fill"
                       f":enable='between(t,{m.start:.3f},{m_end:.3f})'")
    if spec.mode == "portrait":
        c = spec.crop
        filters.append(f"crop={c.w}:{c.h}:{c.x}:{c.y}")
        filters.append(f"scale={PORTRAIT_W}:{PORTRAIT_H}")
    if ass:
        esc = ass.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        filters.append(f"subtitles='{esc}'")
    return filters


def ffmpeg_args(source: str, spec: ClipSpec, ass: Optional[str], out: str, src_offset: float = 0.0) -> List[str]:
    """ffmpeg の引数を組み立てる（純関数・テスト対象）。

    src_offset: source ファイルの先頭が動画内の何秒に対応するか（区間ダウンロード時に非 0）。
    -ss を入力前に置くため出力のタイムスタンプは 0 起点になり、ass（切り抜き先頭からの相対時刻）
    と masks の enable='between(t,...)'（同じく相対秒）がそのまま一致する。

    Tests:
        - -ss/-to が spec の秒になる（src_offset 分ずれる）
        - ass があれば subtitles フィルタが入る・無ければ入らない
        - Windows パスのコロンが subtitles フィルタ用にエスケープされる
        - masks があれば drawbox フィルタが入る（end=None は切り抜き末尾まで）
    """
    args = [_require("ffmpeg"), "-y", "-ss", f"{spec.start_sec - src_offset:.3f}",
            "-to", f"{spec.end_sec - src_offset:.3f}", "-i", source]
    args += ["-vf", ",".join(video_filters(spec, ass))]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", out]
    return args


def render(clip_json: str, srt: Optional[str], out_dir: str, run: Callable = subprocess.run,
           chat_json: Optional[str] = None) -> str:
    """clip.json（+srt +chat.json）から mp4 を作る。戻り値は出力パス。

    元動画は全編ソース（{id}.source.mp4）が既にあればそれを使い、無ければ
    区間ダウンロード（前後 SECTION_PAD_SEC 秒の余白つき）で取得する。
    字幕とチャットは 1 つの .ass（<id>_<start>_<end>.burn.ass）にまとめて焼く。
    chat_overlay.enabled なのに chat.json が無ければ黙って字幕だけにせず RuntimeError。

    Tests:
        - ffmpeg の終了コードが 0 以外なら RuntimeError
        - srt を渡したのに書式不正なら render 前に ValueError
        - 全編ソースが無いときは区間ダウンロードになり -ss が区間相対に補正される
        - 字幕 0 件・チャットなしなら subtitles フィルタを入れない
        - chat_overlay.enabled で chat.json が無ければ RuntimeError
    """
    spec = load_clip(clip_json)
    out_dir = os.path.abspath(out_dir)   # ffmpeg を cwd=out_dir で起動するため、相対 --out でも src/out が迷子にならないようにする
    os.makedirs(out_dir, exist_ok=True)
    cues = parse_srt(srt) if srt else []
    chat: List[dict] = []
    if spec.chat_overlay.get("enabled"):
        if not chat_json or not os.path.exists(chat_json):
            raise RuntimeError("clip.json でチャット焼き込みが ON ですが chat.json が見つかりません（拡張の保存で 3 ファイル揃えてください）")
        chat = load_chat(chat_json)
    ass_name = None
    if cues or (spec.chat_overlay.get("enabled") and chat):
        # パス中の空白・記号で subtitles フィルタのエスケープ事故を起こさないよう、安全な名前で out_dir に書き cwd=out_dir の相対名で渡す
        ass_name = f"{spec.video_id}_{int(spec.start_sec)}_{int(spec.end_sec)}.burn.ass"
        with open(os.path.join(out_dir, ass_name), "w", encoding="utf-8-sig") as f:
            f.write(build_ass(cues, chat, spec))
    full = os.path.join(out_dir, f"{spec.video_id}.source.mp4")
    if os.path.exists(full):
        src, offset = full, 0.0
    else:
        src = download_source(spec.video_id, out_dir, run=run, start=spec.start_sec, end=spec.end_sec)
        offset = max(0.0, spec.start_sec - SECTION_PAD_SEC)
    # 同じ開始秒で長さ違いの切り抜きを上書きしないよう end も名前に入れる
    out = os.path.join(out_dir, f"{spec.video_id}_{int(spec.start_sec)}_{int(spec.end_sec)}.mp4")
    # cwd=out_dir: subtitles フィルタに相対名を渡すため（src / out は絶対パスなので影響なし）
    r = run(ffmpeg_args(src, spec, ass_name, out, src_offset=offset), capture_output=True, text=True, cwd=out_dir)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg 失敗 ({r.returncode}): {r.stderr.strip()[-500:]}")
    return out


# ---- フォルダ監視（拡張の「保存」だけで mp4 まで出す自動焼き付け） ----

def watch_targets(watch_dir: str, now: Optional[float] = None) -> List[tuple]:
    """watch_dir 直下で焼き付けが必要な clip.json を探す。

    返り値: (clip_json, srt または None, 出力 mp4, エラーファイル, chat.json または None) のリスト。
    スキップ条件: 書き込み後 WATCH_STABLE_SEC 未満（書きかけ）／json より新しい mp4 が
    既にある（処理済み）／json より新しいエラーファイルがある（失敗済み。json を
    保存し直すと mtime が進んで再挑戦になる）。

    Tests:
        - 未処理の clip.json が srt とペアで返る
        - Chrome の「name.clip (1).json」も同じ連番の srt / mp4 に対応づく
        - 処理済み（新しい mp4 あり）と書きかけ（mtime が新しすぎる）は返らない
        - 失敗済み（新しいエラーファイルあり）は返らない
    """
    now = time.time() if now is None else now
    targets = []
    for name in sorted(os.listdir(watch_dir)):
        m = CLIP_JSON_PAT.match(name)
        if not m:
            continue
        clip_json = os.path.join(watch_dir, name)
        mtime = os.stat(clip_json).st_mtime
        if now - mtime < WATCH_STABLE_SEC:
            continue
        base = m.group("stem") + (m.group("dup") or "")
        out = os.path.join(watch_dir, base + ".mp4")
        err = os.path.join(watch_dir, base + ".render_error.txt")
        if os.path.exists(out) and os.stat(out).st_mtime >= mtime:
            continue
        if os.path.exists(err) and os.stat(err).st_mtime >= mtime:
            continue
        srt = os.path.join(watch_dir, base + ".srt")
        chat = os.path.join(watch_dir, base + ".chat.json")
        targets.append((clip_json, srt if os.path.exists(srt) else None, out, err, chat if os.path.exists(chat) else None))
    return targets


def watch_once(watch_dir: str, cache_dir: str, run: Callable = subprocess.run,
               do_render: Optional[Callable] = None) -> List[str]:
    """未処理の clip.json を全部焼き付ける。返り値は出来上がった mp4 のリスト。

    失敗は握りつぶさず、ユーザーが見る保存フォルダに <base>.render_error.txt を
    書いて次へ進む（監視自体は止めない。原因と再実行方法をファイルに明記する）。

    Tests:
        - render 成功で mp4 が watch_dir に置かれ、古いエラーファイルは消える
        - render 失敗でエラーファイルが書かれ、他の json の処理は続く
    """
    do_render = render if do_render is None else do_render
    done = []
    for clip_json, srt, out, err, chat in watch_targets(watch_dir):
        print(f"焼き付け開始: {os.path.basename(clip_json)}", flush=True)
        try:
            tmp = do_render(clip_json, srt, cache_dir, run=run, chat_json=chat)
            os.replace(tmp, out)
            if os.path.exists(err):
                os.remove(err)
            done.append(out)
            print(f"焼き付け完了: {out}", flush=True)
        except (ValueError, RuntimeError) as e:
            with open(err, "w", encoding="utf-8") as f:
                f.write(f"{os.path.basename(clip_json)} の焼き付けに失敗しました:\n{e}\n\n"
                        f"内容を直して {os.path.basename(clip_json)} を保存し直すと自動で再実行されます。\n")
            print(f"エラー: {e} → {os.path.basename(err)}", file=sys.stderr, flush=True)
    return done


def watch(watch_dir: str, cache_dir: Optional[str] = None,
          interval: float = WATCH_INTERVAL_SEC, once: bool = False,
          run: Callable = subprocess.run) -> None:
    """watch_dir を監視し、拡張が保存した clip.json を自動で mp4 に焼き付け続ける。

    once=True は未処理分だけ処理して戻る（テスト・手動一括用）。
    元動画のキャッシュ（.section.mp4 / .source.mp4）は cache_dir（既定 watch_dir/.cache）に
    残し、ユーザーが見るフォルダには mp4 と3ファイルだけを置く。
    """
    os.makedirs(watch_dir, exist_ok=True)
    cache_dir = cache_dir or os.path.join(watch_dir, ".cache")
    os.makedirs(cache_dir, exist_ok=True)
    print(f"監視中: {watch_dir}\n拡張の「保存」だけで、このフォルダに自動で mp4 が出ます（終了は Ctrl+C）", flush=True)
    while True:
        watch_once(watch_dir, cache_dir, run=run)
        if once:
            return
        time.sleep(interval)
