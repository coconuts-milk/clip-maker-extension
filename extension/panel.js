// 拡張アイコンを押すと開くパネル（ブラウザ横のサイドパネル）。
// ふつうのポップアップはページ側をクリックすると閉じてしまい、動画の位置を動かしながら時間を決められない。
// サイドパネルは開いたままなので、動画を操作 →「今時間取得」を繰り返せる。
// 開いた時点の再生位置を「開始」に入れる。

const $ = id => document.getElementById(id);
const say = (text, cls) => { const m = $("msg"); m.className = "msg " + (cls || "bad"); m.textContent = text; };

// パネルのあるウィンドウで前面にある YouTube タブ。違えばメッセージ文字列を throw。
async function ytTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(www|m)\.youtube\.com\//.test(tab.url || "")) throw "YouTube の動画ページを開いた状態で使ってください";
  return tab;
}
async function nowTime() {
  const tab = await ytTab();
  return assertVer(await messageWithInject(tab.id, { type: "CLIP_GET_TIME" }));
}

$("ver").textContent = "v" + chrome.runtime.getManifest().version;

let range;
const startTI = createTimeInput($("start"), () => range.onStartInput());
const endTI = createTimeInput($("end"), () => range.onEndInput());
range = setupRangeControl(startTI, endTI, $("length"), () => {
  chrome.storage.local.set({ panelLength: $("length").value });   // 長さだけ覚える（開始は毎回「今の位置」）
  try { range.read(); say("", "ok"); } catch (e) { if (startTI.get() !== null && endTI.get() !== null) say(String(e)); }
});

(async () => {
  const { panelLength } = await chrome.storage.local.get("panelLength");
  $("length").value = Number(panelLength) > 0 ? String(panelLength) : String(DEFAULT_LEN_SEC);
  try { const r = await nowTime(); range.setStart(r.t); } catch (e) { say(String(e)); }
})();

$("nowstart").addEventListener("click", async () => {
  try { const r = await nowTime(); range.setStart(r.t); } catch (e) { say(String(e)); }
});
$("nowend").addEventListener("click", async () => {
  try { const r = await nowTime(); range.setEnd(r.t); } catch (e) { say(String(e)); }
});

$("go").addEventListener("click", async () => {
  let r0, tab;
  try { r0 = range.read(); tab = await ytTab(); } catch (e) { say(String(e)); return; }
  $("go").disabled = true;
  say("字幕・コメント・プレビュー画像を取得中…（動画が少し動きます）", "busy");
  try {
    const r = assertVer(await messageWithInject(tab.id, { type: "CLIP_CAPTURE", start: r0.start, end: r0.end, withFrames: true }));
    const clip = normalizeClip({ ...r.clip });
    // 編集画面はタブを開き直しても続きから編集できるよう storage 経由で渡す
    await chrome.storage.local.set({ draft: { clip, captions: r.captions, chat: r.chat, frames: r.frames } });
    await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
    say("編集画面を開きました。", "ok");
  } catch (e) { say(String(e)); }
  finally { $("go").disabled = false; }
});
