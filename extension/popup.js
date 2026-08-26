// 2 段階フロー（2026-08-26 エイジ指示）:
//   ① popup で指定時間のチャット（配信アーカイブのチャットリプレイ）と字幕を吸い出す → ② 別タブに編集画面（editor.html）を出す
//   → ③ 字幕・チャットを修正 → ④ 隠す範囲を四角で覆う → ⑤ 3 ファイル保存 → プロ版 watch/render で焼き付け。
// 「編集せずそのまま保存」も残す（取得時間と字幕は別ファイルで編集可能、の元仕様）。

// ページから吸い出す。失敗はメッセージ文字列を throw（呼び側で表示）。
// withFrames: 編集画面のプレビュー用コマ画像も撮る（時間が数秒余計にかかる）。
async function capture(withFrames) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const start = parseTimeStr(document.getElementById("start").value);   // common.js
  if (start === null) throw "開始時間は「1:24:09」か「5049」（秒）の形式で入れてください";
  const req = { type: "CLIP_CAPTURE", start, withFrames,
                length: Number(document.getElementById("length").value) };
  if (!tab || !/^https:\/\/(www|m)\.youtube\.com\//.test(tab.url || "")) {
    throw "YouTube の動画ページを開いた状態で使ってください";
  }
  let r;
  try { r = await chrome.tabs.sendMessage(tab.id, req); }
  catch (e) {
    // 拡張を入れる前から開いていたタブ／拡張リロード直後のタブには生きた content script が無い
    // → その場で注入して 1 回だけ再試行（content.js は common.js に依存するので必ずセットで入れる）
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["inject.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["common.js", "content.js"] });
      r = await chrome.tabs.sendMessage(tab.id, req);
    } catch (e2) { throw "ページと通信できません。YouTube のタブを再読み込み（F5）してからもう一度押してください。"; }
  }
  if (!r || r.error) throw (r && r.error) || "取得に失敗しました";
  if (r.ver !== chrome.runtime.getManifest().version) {
    // 「パッケージ化されていない拡張」はファイルを差し替えても🔄を押すまで YouTube タブ側が旧版のまま動く
    throw `旧バージョンの部品が動いています（ページ側 ${r.ver || "0.2 以前"} / 本体 ${chrome.runtime.getManifest().version}）。\n` +
          "chrome://extensions を開いて Clip Maker の更新（🔄）ボタンを押してから、もう一度このボタンを押してください（YouTube タブの再読み込みは不要）。";
  }
  return r;
}

document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;

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
