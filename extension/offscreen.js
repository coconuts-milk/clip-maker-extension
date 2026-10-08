// 認識モデルの先行ダウンロード（画面に出ないページ）。background.js から ASR_PRELOAD を受けて asr-worker.js に読み込ませる。
// パネルを閉じてもダウンロードが途中で止まらないよう、パネルではなくこのページで行う。
// 進み具合は background.js に送り、background が chrome.storage.local の asrModelStatus に書く
// （このページは chrome.runtime 以外の拡張 API を使えない。chrome.storage を直接呼ぶと止まる＝2026-10-09 実測）。
let running = null;
console.log("[clip-maker offscreen] loaded");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "ASR_PRELOAD") return;
  console.log("[clip-maker offscreen] request", JSON.stringify(msg));
  if (running) { sendResponse({ ok: true, already: true }); return; }
  running = (async () => {
    const device = msg.device || "wasm";   // GPU の有無はパネル側で判定して渡す
    const status = s => chrome.runtime.sendMessage({ type: "ASR_PRELOAD_STATUS", status: { model: msg.model, device, at: Date.now(), ...s } }).catch(() => {});
    try {
      const cached = await asrCached(msg.model, device);
      await status({ state: "loading", pct: 0, note: cached ? "保存済みの認識モデルを確かめています…" : "認識モデルをダウンロード中…" });
      const r = await preloadAsr(msg.model, device, m => status({ state: "loading", pct: m.pct, note: m.note }));
      await status({ state: "ready", pct: 100, note: `認識モデルは取得済み（${ASR_MODELS[msg.model].label}）`, elapsed_s: r.elapsed_s });
    } catch (e) {
      await status({ state: "error", pct: 0, note: `認識モデルを取得できませんでした: ${e && e.message ? e.message : e}` });
    } finally {
      running = null;
      chrome.runtime.sendMessage({ type: "ASR_PRELOAD_DONE" }).catch(() => {});
    }
  })();
  sendResponse({ ok: true });
});
