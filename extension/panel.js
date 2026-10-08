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

$("ver").textContent = "v" + BUILD;
if (needsExtensionReload()) showReloadNotice(document.body, "更新するとこのパネルは一度閉じます。もう一度アイコンを押して開いてください。");

let range;
const startTI = createTimeInput($("start"), () => range.onStartInput());
const endTI = createTimeInput($("end"), () => range.onEndInput());
range = setupRangeControl(startTI, endTI, $("length"), () => {
  chrome.storage.local.set({ panelLength: $("length").value });   // 長さだけ覚える（開始は毎回「今の位置」）
  try { range.read(); say("", "ok"); } catch (e) { if (startTI.get() !== null && endTI.get() !== null) say(String(e)); }
});

// 字幕の作り方: YouTube の字幕をそのまま使う / 音声認識で作る（音声の取り込みに切り抜きと同じ時間がかかる）
// 音声認識を選んだ時点で認識モデルのダウンロードを始める（編集画面に入ってから待たされないように）
const subsrc = () => (document.querySelector("input[name=subsrc]:checked") || {}).value || "youtube";
const asrModel = () => (document.querySelector("input[name=asrmodel]:checked") || {}).value || ASR_DEFAULT_MODEL;
function showSubNote() {
  const asr = subsrc() === "asr";
  $("asropts").classList.toggle("hidden", !asr);
  $("subnote").textContent = asr ? "音声の取り込みに切り抜きと同じ時間がかかります。" : "";
}
async function showModelStatus() {
  const device = await asrDevice();
  const { asrModelStatus: st } = await chrome.storage.local.get("asrModelStatus");
  const cached = await asrCached(asrModel(), device);
  let note, pct;
  if (st && st.model === asrModel() && st.state === "loading") { note = st.note; pct = st.pct; }
  else if (cached || (st && st.model === asrModel() && st.device === device && st.state === "ready")) { note = `認識モデルは取得済み（${ASR_MODELS[asrModel()].label}・${device === "webgpu" ? "GPU" : "CPU"} で認識）`; pct = 100; }
  else if (st && st.model === asrModel() && st.state === "error") { note = st.note; pct = 0; }
  else { note = `認識モデルは未取得（${ASR_MODELS[asrModel()].note}）。選ぶとダウンロードが始まります`; pct = 0; }
  $("modelstat").textContent = note;
  $("modelfill").style.width = pct + "%";
}
async function ensureModel() {
  if (subsrc() !== "asr") return;
  if (await asrCached(asrModel(), await asrDevice())) { showModelStatus(); return; }
  try { await chrome.runtime.sendMessage({ type: "ASR_PRELOAD_REQUEST", model: asrModel(), device: await asrDevice() }); } catch (_) { /* background が応答しない */ }
  showModelStatus();
}
document.querySelectorAll("input[name=subsrc]").forEach(el => el.addEventListener("change", () => { chrome.storage.local.set({ panelSubsrc: el.value }); showSubNote(); ensureModel(); }));
document.querySelectorAll("input[name=asrmodel]").forEach(el => el.addEventListener("change", () => { chrome.storage.local.set({ asrModel: el.value }); ensureModel(); }));
chrome.storage.onChanged.addListener(ch => { if (ch.asrModelStatus) showModelStatus(); });

(async () => {
  const { panelLength, panelSubsrc, asrModel: savedModel } = await chrome.storage.local.get(["panelLength", "panelSubsrc", "asrModel"]);
  $("length").value = Number(panelLength) > 0 ? String(panelLength) : String(DEFAULT_LEN_SEC);
  document.querySelector(`input[name=subsrc][value=${panelSubsrc === "asr" ? "asr" : "youtube"}]`).checked = true;
  document.querySelector(`input[name=asrmodel][value=${ASR_MODELS[savedModel] ? savedModel : ASR_DEFAULT_MODEL}]`).checked = true;
  showSubNote();
  ensureModel();
  if (needsExtensionReload()) return;
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
    let audio = null;
    if (subsrc() === "asr") {
      say(`字幕用の音声を取り込み中…（${Math.ceil(r0.len)} 秒。YouTube のタブを表示したまま待ってください）`, "busy");
      const a = assertVer(await messageWithInject(tab.id, { type: "CLIP_CAPTURE_AUDIO", video_id: clip.video_id, start: clip.start_sec, end: clip.end_sec }));
      audio = { rate: a.rate, pcm16: a.pcm16, sec: a.sec };
    }
    // 編集画面はタブを開き直しても続きから編集できるよう storage 経由で渡す
    await chrome.storage.local.set({ draft: { clip, captions: r.captions, chat: r.chat, frames: r.frames, audio, subsrc: subsrc(), asrDone: false } });
    await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
    say("編集画面を開きました。", "ok");
  } catch (e) { say(String(e)); }
  finally { $("go").disabled = false; }
});
