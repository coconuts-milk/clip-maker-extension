// 2 段階フロー（2026-08-26 エイジ指示）:
//   ① popup で指定時間のチャット（配信アーカイブのチャットリプレイ）と字幕を吸い出す → ② 別タブに編集画面（editor.html）を出す
//   → ③ 字幕・チャットを修正 → ④ 隠す範囲を四角で覆う → ⑤ 3 ファイル保存 → プロ版 watch/render で焼き付け。
// 「編集せずそのまま保存」も残す（取得時間と字幕は別ファイルで編集可能、の元仕様）。
// 通信は common.js の messageWithInject / assertVer を使う（editor.js と同じ経路・2 箇所に持たない）。

// アクティブタブが YouTube ならそのタブを返す。違えばメッセージ文字列を throw。
async function ytTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(www|m)\.youtube\.com\//.test(tab.url || "")) {
    throw "YouTube の動画ページを開いた状態で使ってください";
  }
  return tab;
}

// ページから吸い出す。失敗はメッセージ文字列を throw（呼び側で表示）。
// withFrames: 編集画面のプレビュー用コマ画像も撮る（時間が数秒余計にかかる）。
async function capture(withFrames) {
  const tab = await ytTab();
  const start = parseTimeStr(document.getElementById("start").value);   // common.js
  if (start === null) throw "開始時間は「1:24:09」か「5049」（秒）の形式で入れてください";
  const end = parseTimeStr(document.getElementById("end").value);
  if (end === null) throw "終了時間は「1:24:25」か「5065」（秒）の形式で入れてください（空欄＝開始+長さ）";
  const len = Number(document.getElementById("length").value) || undefined;
  // end が undefined（空欄）なら content.js が開始+length（未入力なら 15）秒で切る。不正な範囲は content.js が明示エラーを返す
  const r = await messageWithInject(tab.id, { type: "CLIP_CAPTURE", start, end, withFrames, length: len || 15 });
  return assertVer(r);
}

document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;

// 「長さ」と「終了」の相互同期（2026-08-28 エイジ指摘②: 長さ欄を消さない。両方置いて片方を入れたらもう片方を自動計算）
const startEl = document.getElementById("start"), endEl = document.getElementById("end"), lenEl = document.getElementById("length");
function syncFromLength() {
  const start = parseTimeStr(startEl.value), len = Number(lenEl.value);
  if (start !== null && start !== undefined && len > 0) endEl.value = fmtTime(start + len);
}
function syncFromEnd() {
  const start = parseTimeStr(startEl.value), end = parseTimeStr(endEl.value);
  if (start !== null && start !== undefined && end !== null && end !== undefined && end > start) {
    lenEl.value = String(Math.round((end - start) * 10) / 10);
  }
}
lenEl.addEventListener("input", syncFromLength);
endEl.addEventListener("input", syncFromEnd);
startEl.addEventListener("input", () => { if (lenEl.value) syncFromLength(); else syncFromEnd(); });

document.getElementById("nowbtn").addEventListener("click", async () => {
  const msg = document.getElementById("msg");
  try {
    const tab = await ytTab();
    const r = assertVer(await messageWithInject(tab.id, { type: "CLIP_GET_TIME" }));
    document.getElementById("start").value = fmtTime(r.t);
    if (lenEl.value) syncFromLength(); else syncFromEnd();   // 開始が変わったので他欄も追随
    msg.id = "msg"; msg.textContent = "";
  } catch (e) { msg.id = "msg"; msg.textContent = String(e); }
});

document.getElementById("go").addEventListener("click", async () => {
  const msg = document.getElementById("msg");
  msg.textContent = "取得中…"; msg.id = "msg";
  let r;
  try { r = await capture(true); } catch (e) { msg.textContent = String(e); return; }
  // 編集画面はタブを開き直しても続きから編集できるよう storage 経由で渡す
  await chrome.storage.local.set({ draft: { clip: { ...r.clip, masks: [] }, captions: r.captions, chat: r.chat, frames: r.frames } });
  await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
});

document.getElementById("savedirect").addEventListener("click", async () => {
  const msg = document.getElementById("msg");
  msg.textContent = "取得中…"; msg.id = "msg";
  let r;
  try { r = await capture(false); } catch (e) { msg.textContent = String(e); return; }
  const base = await saveClipFiles(r.clip, r.captions.cues, r.chat.messages);
  const warn = (r.captions.error ? `\n字幕: ${r.captions.error}` : `\n字幕: ${r.captions.cues.length} 行（${r.captions.lang}）`) +
               (r.chat.error ? `\nチャット: ${r.chat.error}` : "");
  msg.id = "ok";
  msg.textContent = `保存しました: ${fmtTime(r.clip.start_sec)} 〜 ${fmtTime(r.clip.end_sec)}${warn}\nチャット: ${r.chat.messages.length} 件\n` +
                    `ダウンロード/clip-maker/${base}.* → 自動焼き付けが動いていれば約1分で ${base}.mp4 が出ます`;
});
