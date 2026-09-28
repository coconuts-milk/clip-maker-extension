// 2 段階フロー（2026-08-26 エイジ指示）:
//   ① popup で指定時間のチャット（配信アーカイブのチャットリプレイ）と字幕を吸い出す → ② 別タブに編集画面（editor.html）を出す
//   → ③ 字幕・チャットを修正 → ④ 隠す範囲を四角で覆う → ⑤ 3 ファイル保存 → プロ版 watch/render で焼き付け。
// 「編集せずそのまま保存」も残す（取得時間と字幕は別ファイルで編集可能、の元仕様）。
// 通信は common.js の messageWithInject / assertVer を使う（editor.js と同じ経路・2 箇所に持たない）。
// 2026-09-28: 開始・終了・長さの 3 欄連動と「▶ 今の位置」を開始・終了の両方に（common.js setupRangeControl）。

const $ = id => document.getElementById(id);

// アクティブタブが YouTube ならそのタブを返す。違えばメッセージ文字列を throw。
async function ytTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(www|m)\.youtube\.com\//.test(tab.url || "")) {
    throw "YouTube の動画ページを開いた状態で使ってください";
  }
  return tab;
}

$("ver").textContent = "v" + chrome.runtime.getManifest().version;

const range = setupRangeControl($("start"), $("end"), $("length"), showRange);

// 3 欄の下に「1:24:09 〜 1:24:25（16.0 秒）」を常時表示（②: 開始と終了が見える）
function showRange() {
  const v = $("rangeview");
  try {
    const r = range.read();
    v.className = ""; v.textContent = `${fmtTime(r.start)} 〜 ${fmtTime(r.end)}（${r.len.toFixed(1)} 秒）`;
  } catch (e) {
    v.className = "bad"; v.textContent = $("start").value ? String(e) : "";
  }
}

// 前回の入力を復元（popup は閉じるたびに消えるため）
chrome.storage.local.get("popupRange").then(async ({ popupRange }) => {
  if (popupRange) {
    $("start").value = popupRange.start || ""; $("end").value = popupRange.end || ""; $("length").value = popupRange.length || "15";
  }
  // 開始が空なら、開いた時点の再生位置（停止中ならその時刻）を開始に入れておく（旧版の「空欄＝今の位置」と同じ手軽さ）
  if (!$("start").value) {
    try { const r = await nowTime(); range.setStart(r.t); } catch (_) { /* YouTube 以外のタブ等。go を押したときに案内が出る */ }
  }
  showRange();
});
function remember() {
  chrome.storage.local.set({ popupRange: { start: $("start").value, end: $("end").value, length: $("length").value } });
}
for (const id of ["start", "end", "length"]) $(id).addEventListener("input", remember);

// ページから吸い出す。失敗はメッセージ文字列を throw（呼び側で表示）。
// withFrames: 編集画面のプレビュー用コマ画像も撮る（時間が数秒余計にかかる）。
async function capture(withFrames) {
  const tab = await ytTab();
  const r0 = range.read();
  const r = await messageWithInject(tab.id, { type: "CLIP_CAPTURE", start: r0.start, end: r0.end, withFrames });
  return assertVer(r);
}

async function nowTime() {
  const tab = await ytTab();
  return assertVer(await messageWithInject(tab.id, { type: "CLIP_GET_TIME" }));
}

$("nowstart").addEventListener("click", async () => {
  const msg = $("msg");
  try { const r = await nowTime(); range.setStart(r.t); remember(); msg.id = "msg"; msg.textContent = ""; }
  catch (e) { msg.id = "msg"; msg.textContent = String(e); }
});
$("nowend").addEventListener("click", async () => {
  const msg = $("msg");
  try { const r = await nowTime(); range.setEnd(r.t); remember(); msg.id = "msg"; msg.textContent = ""; }
  catch (e) { msg.id = "msg"; msg.textContent = String(e); }
});

$("go").addEventListener("click", async () => {
  const msg = $("msg");
  msg.textContent = "取得中…（長い区間ほどプレビュー撮影に時間がかかります）"; msg.id = "msg";
  let r;
  try { r = await capture(true); } catch (e) { msg.textContent = String(e); return; }
  // 編集画面はタブを開き直しても続きから編集できるよう storage 経由で渡す
  const clip = { ...r.clip, masks: [], frame: defaultFrame("landscape"), chat_overlay: { ...DEFAULT_CHAT_OVERLAY } };
  await chrome.storage.local.set({ draft: { clip, captions: r.captions, chat: r.chat, frames: r.frames } });
  await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
});

$("savedirect").addEventListener("click", async () => {
  const msg = $("msg");
  msg.textContent = "取得中…"; msg.id = "msg";
  let r;
  try { r = await capture(false); } catch (e) { msg.textContent = String(e); return; }
  const clip = { ...r.clip, masks: [], frame: defaultFrame("landscape"), chat_overlay: { ...DEFAULT_CHAT_OVERLAY } };
  const base = await saveClipFiles(clip, r.captions.cues, r.chat.messages);
  const warn = (r.captions.error ? `\n字幕: ${r.captions.error}` : `\n字幕: ${r.captions.cues.length} 行（${r.captions.lang}）`) +
               (r.chat.error ? `\nチャット: ${r.chat.error}` : "");
  msg.id = "ok";
  msg.textContent = `保存しました: ${fmtTime(r.clip.start_sec)} 〜 ${fmtTime(r.clip.end_sec)}${warn}\nチャット: ${r.chat.messages.length} 件\n` +
                    `ダウンロード/clip-maker/${base}.* → 自動焼き付けが動いていれば約1分で ${base}.mp4 が出ます`;
});
