import json, os, sys, subprocess
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pro"))
from clipmaker import core


def _clip(tmp_path, **kw):
    d = {"video_id": "dQw4w9WgXcQ", "start_sec": 10.0, "end_sec": 25.0}
    d.update(kw)
    p = tmp_path / "a.clip.json"
    p.write_text(json.dumps(d), encoding="utf-8")
    return str(p)


def test_load_clip_ok(tmp_path):
    s = core.load_clip(_clip(tmp_path))
    assert s.video_id == "dQw4w9WgXcQ" and s.length == 15.0


def test_load_clip_end_before_start(tmp_path):
    with pytest.raises(ValueError):
        core.load_clip(_clip(tmp_path, end_sec=5.0))


def test_load_clip_too_long(tmp_path):
    with pytest.raises(ValueError):
        core.load_clip(_clip(tmp_path, end_sec=10.0 + core.PRO_MAX_CLIP_SEC + 1))


def test_load_clip_bad_id(tmp_path):
    with pytest.raises(ValueError):
        core.load_clip(_clip(tmp_path, video_id="bad"))


def test_validate_srt(tmp_path):
    p = tmp_path / "a.srt"
    p.write_text("1\n00:00:00,000 --> 00:00:02,500\nこんにちは\n\n2\n00:00:03,000 --> 00:00:04,000\nさようなら\n", encoding="utf-8")
    assert core.validate_srt(str(p)) == 2
    p.write_text("1\n00:00:00 --> 00:00:02\nx\n", encoding="utf-8")
    with pytest.raises(ValueError, match=":2:"):
        core.validate_srt(str(p))
    p.write_text("", encoding="utf-8")
    assert core.validate_srt(str(p)) == 0


def test_ffmpeg_args(monkeypatch):
    monkeypatch.setattr(core, "_require", lambda c: c)
    spec = core.ClipSpec("dQw4w9WgXcQ", 1.5, 4.0)
    a = core.ffmpeg_args("src.mp4", spec, None, "o.mp4")
    assert a[a.index("-ss") + 1] == "1.500" and a[a.index("-to") + 1] == "4.000" and "-vf" not in a
    a = core.ffmpeg_args("src.mp4", spec, r"C:\x\a.srt", "o.mp4")
    assert a[a.index("-vf") + 1] == "subtitles='C\:/x/a.srt'"


def test_ffmpeg_args_offset(monkeypatch):
    monkeypatch.setattr(core, "_require", lambda c: c)
    spec = core.ClipSpec("dQw4w9WgXcQ", 5049.0, 5065.0)
    a = core.ffmpeg_args("sec.mp4", spec, None, "o.mp4", src_offset=5044.0)
    assert a[a.index("-ss") + 1] == "5.000" and a[a.index("-to") + 1] == "21.000"


def test_ffmpeg_args_masks(monkeypatch):
    monkeypatch.setattr(core, "_require", lambda c: c)
    spec = core.ClipSpec("dQw4w9WgXcQ", 0.0, 10.0,
                         masks=[core.Mask(100, 200, 300, 50, 1.0, 4.0), core.Mask(0, 0, 10, 10)])
    a = core.ffmpeg_args("src.mp4", spec, None, "o.mp4")
    vf = a[a.index("-vf") + 1]
    assert "drawbox=x=100:y=200:w=300:h=50:color=black@1:t=fill:enable='between(t,1.000,4.000)'" in vf
    assert "between(t,0.000,10.000)" in vf   # end=None は切り抜き末尾まで


def test_load_clip_masks(tmp_path):
    p = _clip(tmp_path, masks=[{"x": 10, "y": 20, "w": 30, "h": 40, "start": 1, "end": 3}])
    s = core.load_clip(p)
    assert s.masks == [core.Mask(10, 20, 30, 40, 1.0, 3.0)]
    with pytest.raises(ValueError, match="矩形が不正"):
        core.load_clip(_clip(tmp_path, masks=[{"x": 0, "y": 0, "w": 0, "h": 10}]))
    with pytest.raises(ValueError, match="より後"):
        core.load_clip(_clip(tmp_path, masks=[{"x": 0, "y": 0, "w": 5, "h": 5, "start": 3, "end": 1}]))


def test_download_source_section_args(tmp_path):
    calls = []
    def run(args, **kw):
        calls.append(args)
        # yt-dlp が出力を作ったことにする
        open(os.path.join(str(tmp_path), "dQw4w9WgXcQ_5044_5070.section.mp4"), "wb").close()
        return subprocess.CompletedProcess(args, 0, "", "")
    out = core.download_source("dQw4w9WgXcQ", str(tmp_path), run=run, start=5049.0, end=5065.0)
    assert out.endswith("dQw4w9WgXcQ_5044_5070.section.mp4")
    a = calls[0]
    assert a[a.index("--download-sections") + 1] == "*5044-5070" and "--force-keyframes-at-cuts" in a
    with pytest.raises(ValueError, match="両方"):
        core.download_source("dQw4w9WgXcQ", str(tmp_path), run=run, start=5049.0)


def test_render_ffmpeg_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(core, "_require", lambda c: c)
    src = tmp_path / "dQw4w9WgXcQ.source.mp4"
    src.write_bytes(b"")
    def run(args, **kw):
        return subprocess.CompletedProcess(args, 1, "", "boom")
    with pytest.raises(RuntimeError, match="ffmpeg 失敗"):
        core.render(_clip(tmp_path), None, str(tmp_path), run=run)


def test_render_ok(tmp_path, monkeypatch):
    monkeypatch.setattr(core, "_require", lambda c: c)
    (tmp_path / "dQw4w9WgXcQ.source.mp4").write_bytes(b"")
    calls = []
    def run(args, **kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, "", "")
    out = core.render(_clip(tmp_path), None, str(tmp_path), run=run)
    assert out.endswith("dQw4w9WgXcQ_10_25.mp4") and len(calls) == 1


def test_render_srt_safe_copy(tmp_path, monkeypatch):
    """空白・括弧入りの srt 名（Chrome の「a (1).srt」）でも、安全名にコピーして cwd=out_dir の相対名で焼ける。"""
    monkeypatch.setattr(core, "_require", lambda c: c)
    (tmp_path / "dQw4w9WgXcQ.source.mp4").write_bytes(b"")
    srt = tmp_path / "a (1).srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nx\n", encoding="utf-8")
    calls = []
    def run(args, **kw):
        calls.append((args, kw.get("cwd")))
        return subprocess.CompletedProcess(args, 0, "", "")
    core.render(_clip(tmp_path), str(srt), str(tmp_path), run=run)
    args, cwd = calls[0]
    assert args[args.index("-vf") + 1] == "subtitles='dQw4w9WgXcQ_10_25.burn.srt'"
    assert cwd == str(tmp_path)
    assert (tmp_path / "dQw4w9WgXcQ_10_25.burn.srt").read_text(encoding="utf-8").startswith("1")


def test_render_empty_srt_skips_subtitles(tmp_path, monkeypatch):
    """字幕 0 件の srt は「焼くものが無い」＝subtitles フィルタを入れず字幕なしで焼く（libass は空 srt で落ちる）。"""
    monkeypatch.setattr(core, "_require", lambda c: c)
    (tmp_path / "dQw4w9WgXcQ.source.mp4").write_bytes(b"")
    srt = tmp_path / "empty.srt"
    srt.write_text("", encoding="utf-8")
    calls = []
    def run(args, **kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, "", "")
    core.render(_clip(tmp_path), str(srt), str(tmp_path), run=run)
    assert "-vf" not in calls[0]


def _watch_files(tmp_path, base="a", age=10.0):
    """clip.json + srt を書き、書きかけ判定を避けるため mtime を age 秒前に戻す。"""
    cj = tmp_path / f"{base}.clip.json"
    cj.write_text(json.dumps({"video_id": "dQw4w9WgXcQ", "start_sec": 10.0, "end_sec": 25.0}), encoding="utf-8")
    srt = tmp_path / f"{base}.srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nx\n", encoding="utf-8")
    import time
    old = time.time() - age
    os.utime(cj, (old, old)); os.utime(srt, (old, old))
    return str(cj), str(srt)


def test_watch_targets(tmp_path):
    cj, srt = _watch_files(tmp_path)
    t = core.watch_targets(str(tmp_path))
    assert t == [(cj, srt, os.path.join(str(tmp_path), "a.mp4"), os.path.join(str(tmp_path), "a.render_error.txt"))]
    # 処理済み（json より新しい mp4）は返らない
    (tmp_path / "a.mp4").write_bytes(b"x")
    assert core.watch_targets(str(tmp_path)) == []
    # 書きかけ（mtime が新しすぎる）は返らない
    os.remove(tmp_path / "a.mp4")
    import time
    os.utime(cj, None)
    assert core.watch_targets(str(tmp_path), now=time.time()) == []


def test_watch_targets_chrome_rename(tmp_path):
    """Chrome の重複リネーム「a.clip (1).json」が「a (1).srt」「a (1).mp4」に対応づく。"""
    cj = tmp_path / "a.clip (1).json"
    cj.write_text("{}", encoding="utf-8")
    srt = tmp_path / "a (1).srt"
    srt.write_text("", encoding="utf-8")
    old = __import__("time").time() - 10
    os.utime(cj, (old, old))
    t = core.watch_targets(str(tmp_path))
    assert t == [(str(cj), str(srt), os.path.join(str(tmp_path), "a (1).mp4"),
                  os.path.join(str(tmp_path), "a (1).render_error.txt"))]


def test_watch_targets_failed_marker(tmp_path):
    """json より新しいエラーファイルがあれば再挑戦しない（保存し直すと mtime が進んで再挑戦）。"""
    _watch_files(tmp_path)
    (tmp_path / "a.render_error.txt").write_text("x", encoding="utf-8")
    assert core.watch_targets(str(tmp_path)) == []


def test_watch_once_ok_and_error(tmp_path):
    _watch_files(tmp_path, "ok")
    _watch_files(tmp_path, "bad")
    (tmp_path / "ok.render_error.txt").write_text("古い失敗", encoding="utf-8")
    old = __import__("time").time() - 20   # json（10 秒前）より古い＝前回保存分の失敗 → 今回の json は未処理扱い
    os.utime(tmp_path / "ok.render_error.txt", (old, old))
    cache = tmp_path / ".cache"; cache.mkdir()
    def fake_render(clip_json, srt, out_dir, run=None):
        if "bad" in clip_json:
            raise RuntimeError("わざと失敗")
        p = os.path.join(out_dir, "rendered.mp4")
        open(p, "wb").close()
        return p
    done = core.watch_once(str(tmp_path), str(cache), do_render=fake_render)
    assert done == [os.path.join(str(tmp_path), "ok.mp4")]
    assert os.path.exists(tmp_path / "ok.mp4")
    assert not os.path.exists(tmp_path / "ok.render_error.txt")   # 成功したら古いエラーは消す
    assert "わざと失敗" in (tmp_path / "bad.render_error.txt").read_text(encoding="utf-8")


def test_render_section_when_no_full_source(tmp_path):
    """全編ソースが無ければ区間ダウンロード + -ss の区間相対補正になる。"""
    calls = []
    def run(args, **kw):
        calls.append(args)
        open(os.path.join(str(tmp_path), "dQw4w9WgXcQ_5_30.section.mp4"), "wb").close()
        return subprocess.CompletedProcess(args, 0, "", "")
    import unittest.mock as mock
    with mock.patch.object(core, "_require", lambda c: c):
        core.render(_clip(tmp_path), None, str(tmp_path), run=run)
    ydl, ff = calls  # 呼び出し順: yt-dlp → ffmpeg
    assert ydl[ydl.index("--download-sections") + 1] == "*5-30"
    assert ff[ff.index("-ss") + 1] == "5.000" and ff[ff.index("-to") + 1] == "20.000"
