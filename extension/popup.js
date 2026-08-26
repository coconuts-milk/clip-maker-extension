// 2 段階フロー（2026-08-26 エイジ指示）:
//   ① popup で指定時間のコメントと字幕を吸い出す → ② 別タブに編集画面（editor.html）を出す
//   → ③ 字幕・コメントを修正 → ④ 隠す範囲を四角で覆う → ⑤ 3 ファイル保存 → プロ版 render で焼き付け。
// 「編集せずそのまま保存」も残す（取得時間と字幕は別ファイルで編集可能、の元仕様）。

function parseStart(raw) {
  // "5049" / "5049.5" / "1:24:09" / "24:09" を秒に変換。不正なら null。
  const s = raw.trim();
  if (s === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  return (Number(m[1] || 0)) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ページから吸い出す。失敗はメッセージ文字列を throw（呼び側で表示）。
async function capture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const start = parseStart(document.getElementById("start").value);
  if (start === null) throw "開始時間は「5049」か「1:24:09」の形式で入れてください";
  const req = { type: "CLIP_CAPTURE", start,
                length: Number(document.getElementById("length").value) };
  if (!tab || !/^https:\/\/(www|m)\.youtube\.com\//.test(tab.url || "")) {
    throw "YouTube の動画ページを開いた状態で使ってください";
  }
  let r;
  try { r = await chrome.tabs.sendMessage(tab.id, req); }
  catch (e) {
    // 拡張を入れる前から開いていたタブには content script が入っていない → その場で注入して 1 回だけ再試行
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["inject.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      r = await chrome.tabs.sendMessage(tab.id, req);
    } catch (e2) { throw "ページと通信できません。YouTube のタブを再読み込み（F5）してからもう一度押してください。"; }
  }
  if (!r || r.error) throw (r && r.error) || "取得に失敗しました";
  return r;
}

document.getElementById("go").addEventListener("click", async () => {
  const msg = document.getElementById("msg");
  msg.textContent = "取得中…"; msg.id = "msg";
  let r;
  try { r = await capture(); } catch (e) { msg.textContent = String(e); return; }
  // 編集画面はタブを開き直しても続きから編集できるよう storage 経由で渡す
  await chrome.storage.local.set({ draft: { clip: { ...r.clip, masks: [] }, captions: r.captions, comments: r.comments } });
  await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
});

document.getElementById("savedirect").addEventListener("click", async () => {
  const msg = document.getElementById("msg");
  msg.textContent = "取得中…"; msg.id = "msg";
  let r;
  try { r = await capture(); } catch (e) { msg.textContent = String(e); return; }
  const base = await saveClipFiles(r.clip, r.captions.cues, r.comments);
  const warn = r.captions.error ? `\n字幕: ${r.captions.error}` : `\n字幕: ${r.captions.cues.length} 行（${r.captions.lang}）`;
  msg.id = "ok";
  msg.textContent = `保存しました: ${r.clip.start_sec}s → ${r.clip.end_sec}s${warn}\nコメント: ${r.comments.length} 件（表示済み分のみ）\n` +
                    `ダウンロード/clip-maker/${base}.*`;
});
