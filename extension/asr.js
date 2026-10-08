// 音声認識（編集画面側）。asr-worker.js を Worker として動かし、結果を字幕の行にする。
// 認識は Whisper をブラウザ内で動かす（PC 側に何も入れない）。GPU（WebGPU）が使えれば GPU、無ければ CPU。

// asr-worker.js の MODELS と同じ内容（dtype はファイル名の判定に使う）
const ASR_MODELS = {
  small: { label: "標準", note: "約 400MB", id: "onnx-community/whisper-small", webgpu: { encoder_model: "fp16", decoder_model_merged: "q4" }, wasm: { encoder_model: "q8", decoder_model_merged: "q8" } },
  turbo: { label: "高精度", note: "約 560MB", id: "onnx-community/whisper-large-v3-turbo", webgpu: { encoder_model: "q4f16", decoder_model_merged: "q4f16" }, wasm: { encoder_model: "q4", decoder_model_merged: "q4" } },
};
const DTYPE_SUFFIX = { fp32: "", fp16: "_fp16", q8: "_quantized", int8: "_int8", uint8: "_uint8", q4: "_q4", bnb4: "_bnb4", q4f16: "_q4f16" };
const ASR_CACHE_NAME = "transformers-cache";   // transformers.js がモデルを保存する Cache API の名前

// そのモデル（その device 向けのファイル）がブラウザに保存済みか
async function asrCached(model, device) {
  const m = ASR_MODELS[model];
  if (!m || !("caches" in self)) return false;
  try {
    const cache = await caches.open(ASR_CACHE_NAME);
    const keys = (await cache.keys()).map(r => r.url);
    const dt = m[device];
    // 保存名の例: https://huggingface.co/onnx-community/whisper-small/resolve/main/onnx/encoder_model_fp16.onnx
    const need = [`/onnx/encoder_model${DTYPE_SUFFIX[dt.encoder_model]}.onnx`, `/onnx/decoder_model_merged${DTYPE_SUFFIX[dt.decoder_model_merged]}.onnx`, `/config.json`, `/tokenizer.json`];
    return need.every(n => keys.some(k => k.includes(`/${m.id}/`) && k.endsWith(n)));
  } catch (_) { return false; }
}

// 認識モデルを読み込むだけ（先行ダウンロード）。onProgress は runAsr と同じ
function preloadAsr(model, device, onProgress) {
  return workerCall({ type: "preload", model, device }, onProgress);
}
const ASR_DEFAULT_MODEL = "small";
const ASR_MAX_CUE_CHARS = 22;   // 1 行の字幕がこれより長ければ句読点で分ける（出来上がりで 2 行に収まる長さ）

// GPU が使えるか。使えれば "webgpu"、無ければ "wasm"（CPU）
async function asrDevice() {
  try {
    const { asrForceDevice } = await chrome.storage.local.get("asrForceDevice");   // 確認用: "wasm" を入れると CPU で動かす
    if (asrForceDevice === "wasm" || asrForceDevice === "webgpu") return asrForceDevice;
  } catch (_) { /* 設定なし */ }
  try {
    if (navigator.gpu && await navigator.gpu.requestAdapter()) return "webgpu";
  } catch (_) { /* WebGPU なし */ }
  return "wasm";
}

// base64 の 16bit PCM → Float32Array
function pcm16ToFloat(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  return f;
}

let asrWorker = null;
function workerCall(req, onProgress, transfer) {
  return new Promise(async (resolve, reject) => {
    if (!asrWorker) asrWorker = new Worker(chrome.runtime.getURL("asr-worker.js"), { type: "module" });
    const w = asrWorker;
    const cached = await asrCached(req.model, req.device);
    const onMsg = ev => {
      const m = ev.data;
      if (m.type === "progress") onProgress(m);
      else if (m.type === "done") { cleanup(); resolve({ ...m, device: req.device, cached }); }
      else if (m.type === "error") { cleanup(); reject(new Error(m.message)); }
    };
    const onErr = e => { cleanup(); reject(new Error(e.message || "認識の処理が止まりました")); };
    const cleanup = () => { w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    w.postMessage({ ...req, cached }, transfer || []);
  });
}

// 認識を実行する。onProgress({stage, pct, note}) を随時呼ぶ。返り値 {chunks: [{start, end, text}], elapsed_s, device}
function runAsr(audioB64, model, device, onProgress) {
  const audio = pcm16ToFloat(audioB64);
  return workerCall({ type: "run", audio, model, device }, onProgress, [audio.buffer]);
}

// 認識結果 → 字幕の行 [{start, end, text}]（時刻は切り抜き開始からの秒）。長い文は句読点で分け、時間は文字数で按分する
function asrToCues(chunks, dur) {
  const cues = [];
  for (const c of chunks) {
    const start = Math.max(0, c.start), end = Math.min(dur, c.end);
    if (!(end > start)) continue;
    const text = c.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    let parts = text.length > ASR_MAX_CUE_CHARS ? text.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean) : [text];
    if (parts.length > 1 && parts.every(p => p.length <= 2)) parts = [text];
    const total = parts.reduce((a, p) => a + p.length, 0);
    let t = start;
    parts.forEach((p, i) => {
      const e = i === parts.length - 1 ? end : t + (end - start) * p.length / total;
      cues.push({ start: +t.toFixed(2), end: +e.toFixed(2), text: p });
      t = e;
    });
  }
  // 同じ文が 3 回以上続くのは無音での誤認識（Whisper の癖）なので 1 つにする
  const out = [];
  for (const c of cues) {
    const n = out.length;
    if (n >= 2 && out[n - 1].text === c.text && out[n - 2].text === c.text) { out[n - 1].end = c.end; continue; }
    out.push(c);
  }
  return out.filter(c => c.end - c.start >= 0.2);
}
