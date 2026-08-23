// 取得結果を 3 ファイルに分けて保存する（仕様: 取得時間と字幕を別ファイルで編集可能）。
//   <id>_<start>.clip.json   … 動画 ID・開始/終了秒（編集して長さを変えられる）
//   <id>_<start>.srt         … 字幕（テキストエディタで編集可能）
//   <id>_<start>.comments.json … 表示中コメント

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

document.getElementById("go").addEventListener("click", async () => {
  const msg = document.getElementById("msg");
  msg.textContent = "取得中…"; msg.id = "msg";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const startRaw = document.getElementById("start").value;
  const req = { type: "CLIP_CAPTURE", start: startRaw === "" ? undefined : Number(startRaw),
                length: Number(document.getElementById("length").value) };
  let r;
  try { r = await chrome.tabs.sendMessage(tab.id, req); }
  catch (e) { msg.textContent = "ページと通信できません。YouTube の動画ページを開いて再読み込みしてください。"; return; }
  if (!r || r.error) { msg.textContent = (r && r.error) || "取得に失敗しました"; return; }

  const base = `${r.clip.video_id}_${Math.floor(r.clip.start_sec)}`;
  await download(`${base}.clip.json`, JSON.stringify(r.clip, null, 2), "application/json");
  await download(`${base}.srt`, toSrt(r.captions.cues), "application/x-subrip");   // text/plain だと Chrome が .txt に改名する（E2E で実測）
  await download(`${base}.comments.json`, JSON.stringify(r.comments, null, 2), "application/json");

  const warn = r.captions.error ? `\n字幕: ${r.captions.error}` : `\n字幕: ${r.captions.cues.length} 行（${r.captions.lang}）`;
  msg.id = "ok";
  msg.textContent = `保存しました: ${r.clip.start_sec}s → ${r.clip.end_sec}s${warn}\nコメント: ${r.comments.length} 件（表示済み分のみ）\n` +
                    `ダウンロード/clip-maker/${base}.*`;
});
