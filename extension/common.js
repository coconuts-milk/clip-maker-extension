// popup / editor / content で共有する定数とユーティリティ（同じロジックを 2 箇所に持たない）。

const MAX_CLIP_SEC = 30;   // 無料版の上限（仕様: 30 秒上限）

function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000),
        s = Math.floor(ms % 60000 / 1000), f = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(f).padStart(3, "0")}`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

function download(name, text, mime) {
  const url = "data:" + mime + ";charset=utf-8," + encodeURIComponent(text);
  return chrome.downloads.download({ url, filename: "clip-maker/" + name, saveAs: false });
}

// 3 ファイル保存（clip.json / srt / comments.json）。呼び側で draft の検証を済ませてから呼ぶ。
async function saveClipFiles(clip, cues, comments) {
  const base = `${clip.video_id}_${Math.floor(clip.start_sec)}`;
  await download(`${base}.clip.json`, JSON.stringify(clip, null, 2), "application/json");
  await download(`${base}.srt`, toSrt(cues), "application/x-subrip");   // text/plain だと Chrome が .txt に改名する（E2E で実測）
  await download(`${base}.comments.json`, JSON.stringify(comments, null, 2), "application/json");
  return base;
}
