// 拡張アイコンを押したらサイドパネル（panel.html）を開く。
// ふつうのポップアップはページ側をクリックすると閉じるため、動画を操作しながら時間を決める用途に合わない。
function enablePanel() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(e => console.error("[clip-maker] サイドパネルを設定できません", e));
}
chrome.runtime.onInstalled.addListener(() => { console.log("[clip-maker] installed"); enablePanel(); });
chrome.runtime.onStartup.addListener(enablePanel);
enablePanel();

// 認識モデルの先行ダウンロード。パネルで「音声認識」を選んだときに頼まれる。
// 画面に出ないページ（offscreen.html）で asr-worker.js を動かす（パネルを閉じても止まらない）。
async function preloadModel(model, device) {
  const has = await chrome.offscreen.hasDocument();
  console.log("[clip-maker] preload", model, device, "offscreen:", has);
  if (!has) {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "音声認識のモデルを先にダウンロードしておく" });
  }
  // 開いた直後は受け手がまだ居ないことがあるので、少し待ちながら送り直す
  for (let i = 0; i < 20; i++) {
    try { const r = await chrome.runtime.sendMessage({ type: "ASR_PRELOAD", model, device }); console.log("[clip-maker] preload accepted", JSON.stringify(r)); return r; }
    catch (e) { console.log("[clip-maker] preload retry", i, e.message); await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error("モデル取得用のページが応答しません");
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ASR_PRELOAD_REQUEST") {
    preloadModel(msg.model, msg.device).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e && e.message ? e.message : String(e) }));
    return true;
  }
  if (msg.type === "ASR_PRELOAD_STATUS") {
    chrome.storage.local.set({ asrModelStatus: msg.status });
    return;
  }
  if (msg.type === "ASR_PRELOAD_DONE") {
    console.log("[clip-maker] preload done");
    chrome.offscreen.closeDocument().catch(() => {});
  }
});
