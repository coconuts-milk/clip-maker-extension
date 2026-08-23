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
    assert out.endswith("dQw4w9WgXcQ_10.mp4") and len(calls) == 1
