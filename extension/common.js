// popup / editor / content で共有する定数とユーティリティ（同じロジックを 2 箇所に持たない）。

const MAX_CLIP_SEC = 30;   // 無料版の上限（仕様: 30 秒上限）

// "5049" / "5049.5" / "1:24:09" / "24:09" を秒に変換。不正なら null、空なら undefined。
function parseTimeStr(raw) {
  const s = String(raw).trim();
  if (s === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  return (Number(m[1] || 0)) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// 秒 → "1:24:09" / "0:05" 表示（0.1 秒単位で端数があるときだけ小数を付ける）
function fmtTime(sec) {
  const t = Math.round(sec * 10) / 10;
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), r = +(t - h * 3600 - m * 60).toFixed(1);
  const rs = (r < 10 ? "0" : "") + (Number.isInteger(r) ? String(r) : r.toFixed(1));
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + rs;
}

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

// 3 ファイル保存（clip.json / srt / chat.json）。呼び側で draft の検証を済ませてから呼ぶ。
async function saveClipFiles(clip, cues, chat) {
  const base = `${clip.video_id}_${Math.floor(clip.start_sec)}`;
  await download(`${base}.clip.json`, JSON.stringify(clip, null, 2), "application/json");
  await download(`${base}.srt`, toSrt(cues), "application/x-subrip");   // text/plain だと Chrome が .txt に改名する（E2E で実測）
  await download(`${base}.chat.json`, JSON.stringify(chat, null, 2), "application/json");
  return base;
}
