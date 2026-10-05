// 音声認識（字幕を自分で作る）。編集画面から Worker として起動される。
// 認識は Whisper（OpenAI の音声認識モデル）を transformers.js でブラウザ内で動かす。PC 側に何も入れない。
// 受け取る: { type: "run", audio: Float32Array（16kHz・モノラル）, model: "small" | "turbo", device: "webgpu" | "wasm" }
// 返す:     { type: "progress", stage, pct, note } を随時、最後に { type: "done", chunks: [{start, end, text}], elapsed_s } か { type: "error", message }
import { pipeline, env, WhisperTextStreamer } from "./vendor/transformers.js";

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("./vendor/", import.meta.url).href;   // onnxruntime の wasm は拡張の中から読む

// モデルの候補。dtype は WebGPU（GPU）と wasm（CPU）で変える（GPU は fp16/q4、CPU は 8bit が無難）
const MODELS = {
  small: { id: "onnx-community/whisper-small", webgpu: { encoder_model: "fp16", decoder_model_merged: "q4" }, wasm: { encoder_model: "q8", decoder_model_merged: "q8" } },
  turbo: { id: "onnx-community/whisper-large-v3-turbo", webgpu: { encoder_model: "q4f16", decoder_model_merged: "q4f16" }, wasm: { encoder_model: "q4", decoder_model_merged: "q4" } },
};
const SAMPLE_RATE = 16000;
const CHUNK_S = 30, STRIDE_S = 5;   // Whisper は 30 秒単位。つなぎ目は 5 秒重ねる

let loaded = null;   // {key, transcriber}
const post = m => self.postMessage(m);

async function load(modelKey, device) {
  const key = modelKey + "/" + device;
  if (loaded && loaded.key === key) return loaded.transcriber;
  if (loaded) { try { await loaded.transcriber.dispose(); } catch (_) { /* 解放済み */ } loaded = null; }
  const m = MODELS[modelKey];
  if (!m) throw new Error(`モデルの指定が不正です: ${modelKey}`);
  const seen = {};   // ファイルごとの進み具合（合計で % を出す）
  const transcriber = await pipeline("automatic-speech-recognition", m.id, {
    device, dtype: m[device],
    progress_callback: p => {
      if (p.status === "progress" && p.file) {
        seen[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
        const tot = Object.values(seen).reduce((a, x) => a + x.total, 0), got = Object.values(seen).reduce((a, x) => a + x.loaded, 0);
        post({ type: "progress", stage: "download", pct: tot ? got / tot * 100 : 0, note: `認識モデルをダウンロード中 ${(got / 1048576).toFixed(0)} / ${(tot / 1048576).toFixed(0)} MB（初回だけ）` });
      } else if (p.status === "ready") {
        post({ type: "progress", stage: "load", pct: 100, note: "認識モデルを読み込みました" });
      }
    },
  });
  loaded = { key, transcriber };
  return transcriber;
}

self.onmessage = async ev => {
  const req = ev.data;
  if (req.type !== "run") return;
  const t0 = performance.now();
  try {
    post({ type: "progress", stage: "load", pct: 0, note: "認識モデルを準備中…" });
    const transcriber = await load(req.model, req.device);
    const audio = req.audio;
    const total = audio.length / SAMPLE_RATE;
    const time_precision = transcriber.processor.feature_extractor.config.chunk_length / transcriber.model.config.max_source_positions;
    let chunkStart = 0;
    const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
      time_precision,
      skip_prompt: true,
      on_chunk_start: t => { chunkStart = t; post({ type: "progress", stage: "transcribe", pct: Math.min(99, t / total * 100), note: `音声を認識中 ${t.toFixed(0)} / ${total.toFixed(0)} 秒` }); },
      callback_function: () => {},
    });
    const out = await transcriber(audio, {
      language: "ja", task: "transcribe", return_timestamps: true,
      chunk_length_s: CHUNK_S, stride_length_s: STRIDE_S, force_full_sequences: false,
      top_k: 0, do_sample: false, streamer,
    });
    const chunks = (out.chunks || []).map(c => ({ start: c.timestamp[0], end: c.timestamp[1] === null ? total : c.timestamp[1], text: (c.text || "").trim() }))
      .filter(c => c.text && Number.isFinite(c.start));
    post({ type: "done", chunks, text: out.text, elapsed_s: +((performance.now() - t0) / 1000).toFixed(1) });
  } catch (e) {
    post({ type: "error", message: e && e.message ? e.message : String(e) });
  }
};
