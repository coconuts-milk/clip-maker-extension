"""出来た動画の「なめらかさ」を数値で出す。
使い方: python e2e/check_smooth.py <動画ファイル> [...]
- コマ数・平均 fps
- コマの間隔のばらつき（最大の間隔。ここが大きいと「引っかかり」に見える）
- 同じ絵が続いたコマの数（前のコマと絵が変わっていない＝実質コマ落ち）
"""
import glob, os, re, shutil, subprocess, sys


def tool(name):
    p = shutil.which(name)
    if p:
        return p
    c = glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\bin\%s.exe" % name), recursive=True)
    if not c:
        raise SystemExit(f"{name} が見つかりません")
    return c[0]


def measure(path):
    out = subprocess.run([tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    pts = [float(x.strip().strip(",")) for x in out.splitlines() if x.strip().strip(",")]
    gaps = [b - a for a, b in zip(pts, pts[1:])]
    dur = pts[-1] - pts[0]
    # mpdecimate: 前のコマとほぼ同じ絵のコマを落とす。落とされた数 = 絵が動いていないコマ
    err = subprocess.run([tool("ffmpeg"), "-hide_banner", "-i", path, "-vf", "mpdecimate=hi=64*8:lo=64*3:frac=0.1", "-an", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    kept = [int(m) for m in re.findall(r"frame=\s*(\d+)", err)]
    kept = kept[-1] if kept else len(pts)
    gs = sorted(gaps)
    kinds = subprocess.run([tool("ffprobe"), "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "csv=p=0", path],
                           capture_output=True, text=True).stdout.split()
    return {
        "streams": kinds,
        "frames": len(pts), "fps": round((len(pts) - 1) / dur, 2),
        "gap_ms_median": round(gs[len(gs) // 2] * 1000, 1), "gap_ms_p99": round(gs[int(len(gs) * 0.99)] * 1000, 1), "gap_ms_max": round(gs[-1] * 1000, 1),
        "long_gaps(>50ms)": sum(1 for g in gaps if g > 0.050),
        "same_picture_frames": len(pts) - kept,
    }


for f in sys.argv[1:]:
    print(os.path.basename(f), measure(f))
