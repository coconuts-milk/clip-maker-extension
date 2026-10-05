// Clip Maker content script — YouTube 再生ページから「現在位置・字幕・チャット（リプレイ）・コマ画像」を取り、
// 「動画を作る」で再生中の映像を録画する。
// 設計原則: 取れないものは空で誤魔化さず error を返す（呼び側で表示する）。
// 定数・描画は common.js（先に読み込まれる）。

function videoId() {
  const u = new URL(location.href);
  return u.searchParams.get("v") || (location.pathname.startsWith("/shorts/") ? location.pathname.split("/")[2] : null);
}

// ---- ページ側（inject.js）への依頼 ----
// 動画のタイトルや字幕は、プレーヤーと同じ世界で動く inject.js に聞く（content script からはプレーヤー API を呼べない）。
const PAGE_REQ = "clip-maker-req", PAGE_RES = "clip-maker-res";
const PAGE_TIMEOUT_MS = 30000;   // 字幕の読み直し（最大 8 秒 × 2 手段）を待てる長さ

function askPage(type) {
  return new Promise((resolve, reject) => {
    const rid = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { window.removeEventListener(PAGE_RES, on); reject(new Error("ページ側の部品が応答しません。YouTube のタブを再読み込み（F5）してください")); }, PAGE_TIMEOUT_MS);
    const on = ev => {
      let d;
      try { d = JSON.parse(ev.detail); } catch (_) { return; }
      if (d.rid !== rid) return;
      clearTimeout(timer);
      window.removeEventListener(PAGE_RES, on);
      resolve(d);
    };
    window.addEventListener(PAGE_RES, on);
    window.dispatchEvent(new CustomEvent(PAGE_REQ, { detail: JSON.stringify({ rid, type }) }));
  });
}

// ---- 字幕 ----
async function fetchCaptions(start, end) {
  let r;
  try { r = await askPage("captions"); } catch (e) { return { error: e.message, cues: [] }; }
  if (r.error) return { error: r.error, cues: [] };
  if (r.videoId && r.videoId !== videoId()) return { error: "字幕の取得中に別の動画へ移動しました。もう一度お試しください", cues: [] };
  let j;
  try { j = JSON.parse(r.body); }
  catch (_) { return { error: "字幕データの形式が想定と違います", cues: [] }; }
  // 全区間の字幕を時刻順に並べる
  const all = [];
  for (const ev of (j.events || [])) {
    if (!ev.segs) continue;
    const text = ev.segs.map(s => s.utf8).join("").replace(/\n/g, " ").trim();
    if (!text) continue;
    const t0 = ev.tStartMs / 1000;
    all.push({ t0, t1: t0 + (ev.dDurationMs || 0) / 1000, text });
  }
  all.sort((a, b) => a.t0 - b.t0);
  // 自動生成字幕は 2 行表示の都合で前後の字幕と時間が重なっている。動画に入れるときは 1 つずつ出したいので、
  // 次の字幕が始まったら前の字幕を終わらせる。
  for (let i = 0; i < all.length - 1; i++) {
    if (all[i + 1].t0 > all[i].t0 && all[i + 1].t0 < all[i].t1) all[i].t1 = all[i + 1].t0;
  }
  const cues = [];
  for (const c of all) {
    const s = Math.max(c.t0, start), e = Math.min(c.t1, end);
    if (e - s < 0.05) continue;
    cues.push({ start: +(s - start).toFixed(3), end: +(e - start).toFixed(3), text: c.text });
  }
  return { lang: r.lang, cues };
}

// ---- チャット欄（配信アーカイブのチャットリプレイ。動画下のコメント欄ではない） ----
// チャット iframe（/live_chat_replay）は同一オリジンなので contentDocument を直接読める。
// リプレイはプレーヤーの再生位置に同期するので、切り抜き終了時刻へシークしてから拾う。

const CHAT_SYNC_TIMEOUT_MS = 12000;  // シーク後にチャットリプレイが追いつくまでの待ち上限
const CHAT_POLL_MS = 500;            // 同期待ちの巡回間隔
const CHAT_STABLE_POLLS = 2;         // 件数がこの回数連続で変わらなければ読み込み完了とみなす

function chatDoc() {
  const f = document.querySelector("iframe#chatframe");
  try { return f ? f.contentDocument : null; } catch (_) { return null; }
}

async function ensureChatOpen() {
  if (chatDoc()) return true;
  const btn = document.querySelector("#show-hide-button button");   // 「チャットのリプレイを表示」
  if (!btn) return false;
  btn.click();
  const t0 = Date.now();
  while (Date.now() - t0 < CHAT_SYNC_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, CHAT_POLL_MS));
    if (chatDoc()) return true;
  }
  return false;
}

function chatTs(s) {
  // チャットの時刻表示は動画内時刻（"1:24:10"）。配信開始前は "-0:05" 形式
  if (!s) return null;
  const neg = s.startsWith("-");
  const sec = parseTimeStr(neg ? s.slice(1) : s);
  return (sec === null || sec === undefined) ? null : (neg ? -sec : sec);
}

function readChatMessages(d) {
  const out = [];
  d.querySelectorAll("yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer").forEach(el => {
    const t = chatTs(el.querySelector("#timestamp")?.textContent.trim());
    if (t === null) return;
    const author = el.querySelector("#author-name")?.textContent.trim() || "";
    const text = el.querySelector("#message")?.textContent.trim() || "";
    const amount = el.querySelector("#purchase-amount")?.textContent.trim();
    const tag = el.tagName.toLowerCase();
    const type = tag.includes("paid") ? "superchat" : tag.includes("membership") ? "membership" : "chat";
    if (text || amount) out.push({ t, author, text, ...(amount ? { amount } : {}), ...(type !== "chat" ? { type } : {}) });
  });
  return out;
}

// 切り抜き区間 [start, end] のチャットを {t: 切り抜き開始からの秒, author, text, ...} で返す。
async function collectChat(v, start, end) {
  if (!(await ensureChatOpen())) {
    return { error: "チャット欄が見つかりません（チャットのリプレイが無い動画では取れません）", messages: [] };
  }
  const origTime = v.currentTime, wasPaused = v.paused;
  try {
    v.pause();
    await seekTo(v, Math.max(start, end - 0.1));   // リプレイを区間終端まで進める（履歴に区間全体が残る）
    let prev = -1, stable = 0, msgs = [];
    const t0 = Date.now();
    while (Date.now() - t0 < CHAT_SYNC_TIMEOUT_MS && stable < CHAT_STABLE_POLLS) {
      await new Promise(r => setTimeout(r, CHAT_POLL_MS));
      const d = chatDoc();
      msgs = d ? readChatMessages(d) : [];
      stable = msgs.length === prev && msgs.length > 0 ? stable + 1 : 0;
      prev = msgs.length;
    }
    if (!msgs.length) {
      return { error: "チャットを読み込めませんでした（チャットのリプレイが表示されているか確認してください）", messages: [] };
    }
    const s0 = Math.floor(start);   // チャットの時刻表示は秒単位なので秒に丸めて範囲判定
    const inRange = msgs.filter(m => m.t >= s0 && m.t <= Math.ceil(end));
    return { messages: inRange.map(m => ({ ...m, t: m.t - s0 })) };
  } finally {
    v.currentTime = origTime;
    if (!wasPaused) v.play().catch(() => {});
  }
}

// ---- 編集画面のプレビュー用コマ画像 ----
// YouTube 埋め込み iframe は拡張ページだとエラー 153 で拒否されるため、<video> から実際のコマを canvas で撮って渡す。
// storage.local（既定 10MB）に収めるため幅 960・JPEG 0.7（1 枚 ≒ 60KB × 31 枚 ≒ 2MB）。

const FRAME_W = 960;
const FRAME_STEP_SEC = 2;    // コマの間隔
const FRAME_MAX = 31;        // 60 秒 ÷ 2 + 両端
const SEEK_TIMEOUT_MS = 8000;
const DECODE_WAIT_MS = 250;  // seeked 後にフレームが描画されるまでの余裕

function seekTo(v, t) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { v.removeEventListener("seeked", on); reject(new Error("動画の位置を移動できませんでした（読み込みが止まっていないか確認してください）")); }, SEEK_TIMEOUT_MS);
    const on = () => { clearTimeout(timer); v.removeEventListener("seeked", on); setTimeout(resolve, DECODE_WAIT_MS); };
    v.addEventListener("seeked", on);
    v.currentTime = t;
  });
}

async function captureFrames(v, start, end) {
  const origTime = v.currentTime, wasPaused = v.paused;
  try {
    if (!v.videoWidth || !v.videoHeight) return { error: "動画がまだ読み込まれていません。少し再生してからもう一度お試しください" };
    v.pause();
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_W;
    canvas.height = Math.round(FRAME_W * v.videoHeight / v.videoWidth);
    const ctx = canvas.getContext("2d");
    const dur = end - start;
    const step = Math.max(FRAME_STEP_SEC, dur / (FRAME_MAX - 1));
    const times = [];
    for (let t = 0; t < dur - 0.05; t += step) times.push(t);
    times.push(Math.max(0, dur - 0.1));
    const list = [];
    for (const rel of times) {
      await seekTo(v, start + rel);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      list.push({ t: +rel.toFixed(1), dataUrl: canvas.toDataURL("image/jpeg", 0.7) });
    }
    return { w: canvas.width, h: canvas.height, list };
  } catch (e) {
    return { error: `プレビュー画像を取得できませんでした: ${e && e.message ? e.message : e}` };
  } finally {
    v.currentTime = origTime;
    if (!wasPaused) v.play().catch(() => {});
  }
}

// ---- 動画を作る（拡張だけで完結） ----
// 再生中の <video> を canvas に描き、その上に四角・コメント・字幕を重ねて録画する。
// 実時間で再生しながら録るので、60 秒の切り抜きは 60 秒かかる。音声は <video> の captureStream から取る。
// 描画は common.js の drawClipFrame（編集画面のプレビューと同じ関数）。
//
// 録画の方式は 2 つ:
//  (A) WebCodecs（VideoEncoder / AudioEncoder）+ 自前の mp4 組み立て（mp4.js）。コマごとに元動画の時刻をそのまま書くので
//      コマの間隔が揃う。ふつうの mp4 になる。Chrome / Edge の PC 版で使える。
//  (B) MediaRecorder。(A) が使えないブラウザ向け。コマの時刻が取り込み時の時計で付くため間隔が少し揺れる。

const REC_FPS = 30;              // 動画のコマに合わせた取り込みが使えないブラウザでの取り込み間隔
const REC_WATCH_MS = 200;        // 録画の終了・異常を見張る間隔
const REC_VIDEO_BPS = 8000000;   // 1080p30 の H.264 で破綻しない実用値
const REC_AUDIO_BPS = 192000;
const REC_KEYFRAME_US = 2000000;   // キーフレームの間隔（2 秒。シークのしやすさと大きさのバランス）
const REC_STALL_US = 150000;       // 再生が止まった（読み込み待ち）とみなす、時計と動画の時刻のずれ。これを超えたぶん映像の時刻を遅らせて音声と合わせる
const REC_QUEUE_MAX = 30;          // エンコードの待ち行列がこれを超えたらコマを落とす（落とした数は知らせる）
// mp4 を優先。録れない環境だけ webm（拡張子も webm にして、別形式を mp4 と偽らない）
const REC_MIMES = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4",
                   "video/webm;codecs=h264,opus", "video/webm;codecs=vp9,opus", "video/webm"];

let recording = false;
let lastRecording = null;   // {id, blob}。編集画面が CLIP_GET_CHUNK で取りに来るまで保持する

// 録画中の案内。ページの上端に出す（録画は <video> の映像を直接描くので、この表示は動画に入らない）
function showRecBanner(total) {
  const box = document.createElement("div");
  box.id = "clip-maker-rec";
  box.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b00020;color:#fff;" +
    "font:700 20px/1.4 Meiryo,system-ui,sans-serif;padding:10px 20px 12px;box-shadow:0 2px 12px rgba(0,0,0,.5);text-align:center;pointer-events:none";
  const line = document.createElement("div");
  const bar = document.createElement("div");
  bar.style.cssText = "height:8px;background:rgba(255,255,255,.3);border-radius:4px;margin-top:8px;overflow:hidden";
  const fill = document.createElement("div");
  fill.style.cssText = "height:100%;width:0;background:#fff";
  bar.appendChild(fill);
  box.appendChild(line);
  box.appendChild(bar);
  document.documentElement.appendChild(box);
  const update = t => {
    const el = Math.min(total, Math.max(0, t));
    line.textContent = `● 録画中です。タブ移動しないでください。　${el.toFixed(1)} / ${total.toFixed(1)} 秒`;
    fill.style.width = (total > 0 ? el / total * 100 : 0) + "%";
  };
  update(0);
  return { update, remove: () => box.remove() };
}

function blobChunkBase64(blob, offset, length) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = () => reject(fr.error || new Error("録画データを読めませんでした"));
    fr.readAsDataURL(blob.slice(offset, offset + length));
  });
}

// 録画して Blob を保持する。保存は編集画面が拡張のダウンロード機能で行う
// （ページ側の <a download> は 2 本目以降が Chrome の「複数ファイルのダウンロード」制限で止まる＝2026-09-28 実機で確認）。
async function recordWithMediaRecorder(v, clip, cues, chat, ctx, banner, total) {
  if (typeof MediaRecorder === "undefined") throw new Error("このブラウザは録画に対応していません（PC 版の Chrome / Edge で使ってください）");
  const mime = REC_MIMES.find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("このブラウザで録画できる動画形式がありません");
  const canvas = ctx.canvas;
  let rec;
  try {

    // 取り込み方: 動画の新しいコマが画面に出るたびに 1 枚描いて 1 枚取り込む（requestVideoFrameCallback + requestFrame）。
    // 一定間隔で取り込む方式は、動画のコマと取り込みのタイミングがずれてコマが飛ぶ
    // （2026-10-04 実測: 30 コマ/秒の動画が約 26 コマ/秒になり、14 秒で 50〜90 回飛んだ）。
    const perFrame = typeof v.requestVideoFrameCallback === "function";
    const vTrack = canvas.captureStream(perFrame ? 0 : REC_FPS).getVideoTracks()[0];
    const pushFrame = () => { if (perFrame && vTrack.requestFrame) vTrack.requestFrame(); };
    const audioTracks = clip.audio ? v.captureStream().getAudioTracks() : [];
    if (clip.audio && !audioTracks.length) throw new Error("この動画から音声を取り出せませんでした");
    const stream = new MediaStream([vTrack, ...audioTracks]);
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: REC_VIDEO_BPS, audioBitsPerSecond: REC_AUDIO_BPS });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => { rec.onstop = resolve; rec.onerror = e => reject(e.error || new Error("録画エラー")); });

    rec.start(1000);
    pushFrame();
    await v.play();
    await new Promise((resolve, reject) => {
      const t0 = Date.now(), limit = total * 1000 * 3 + 15000;   // 読み込み待ちで止まっても永久に待たない
      let done = false, lastT = 0, watch = null;
      const finish = (fn, arg) => { if (done) return; done = true; clearInterval(watch); fn(arg); };
      const paint = mediaTime => {
        lastT = Math.max(0, mediaTime - clip.start_sec);
        drawClipFrame(ctx, v, clip, cues, chat, lastT);
        pushFrame();
      };
      if (perFrame) {
        const onFrame = (_now, meta) => {
          if (done) return;
          if (meta.mediaTime >= clip.end_sec) { finish(resolve); return; }
          paint(meta.mediaTime);
          v.requestVideoFrameCallback(onFrame);
        };
        v.requestVideoFrameCallback(onFrame);
      } else {
        const loop = () => { if (done) return; paint(v.currentTime); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
      }
      watch = setInterval(() => {
        banner.update(lastT);
        if (v.currentTime >= clip.end_sec || v.ended) finish(resolve);
        else if (Date.now() - t0 > limit) finish(reject, new Error("録画が時間内に終わりませんでした（動画の読み込みが止まっていないか確認してください）"));
        else if (document.hidden) finish(reject, new Error("録画中に YouTube のタブが隠れました。録画中はタブを移動しないでください"));
      }, REC_WATCH_MS);
    });
    v.pause();
    rec.stop();
    await stopped;

    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    if (!blob.size) throw new Error("録画データが空でした");
    return { blob, ext: mime.startsWith("video/mp4") ? "mp4" : "webm", method: "MediaRecorder", dropped: 0 };
  } finally {
    if (rec && rec.state !== "inactive") { try { rec.stop(); } catch (_) { /* 既に停止 */ } }
  }
}

// (A) WebCodecs。使えるかを先に確かめる。使えない理由は文字列で返す（使えるときは設定を返す）
async function webCodecsSupport(W, H, audio) {
  if (!("VideoEncoder" in window) || !("VideoFrame" in window)) return { why: "VideoEncoder が無い" };
  // High プロファイル・レベル 4.2（1920×1080 の 60 コマ/秒まで）
  const vcfg = { codec: "avc1.64002A", width: W, height: H, bitrate: REC_VIDEO_BPS, framerate: 30, avc: { format: "avc" },
                 latencyMode: "realtime", hardwareAcceleration: "no-preference" };
  let vs;
  try { vs = await VideoEncoder.isConfigSupported(vcfg); } catch (e) { return { why: `映像の設定が通らない: ${e.message}` }; }
  if (!vs.supported) return { why: "H.264 のエンコードに対応していない" };
  if (audio) {
    if (!("AudioEncoder" in window) || !("MediaStreamTrackProcessor" in window)) return { why: "AudioEncoder が無い" };
    try {
      const as = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: REC_AUDIO_BPS, aac: { format: "aac" } });
      if (!as.supported) return { why: "AAC のエンコードに対応していない" };
    } catch (e) { return { why: `音声の設定が通らない: ${e.message}` }; }
  }
  return { vcfg };
}

// AAC の AudioSpecificConfig（2 バイト）。エンコーダが description を返さないときの代わり
function aacConfig(sampleRate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const idx = Math.max(0, rates.indexOf(sampleRate));
  return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);   // AAC LC
}

async function recordWithWebCodecs(v, clip, cues, chat, ctx, banner, total, vcfg) {
  const { W, H } = outSize(clip);
  const canvas = ctx.canvas;
  const vSamples = [], aSamples = [];
  let vDesc = null, aDesc = null, aRate = 0, aCh = 0;
  let dropped = 0, encErr = null;

  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description) vDesc = meta.decoderConfig.description;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      vSamples.push({ ts: chunk.timestamp, dur: chunk.duration || 0, key: chunk.type === "key", data });
    },
    error: e => { encErr = encErr || e; },
  });
  venc.configure(vcfg);

  // 音声: 取り出したブロックをそのままエンコーダへ。a0（映像の最初のコマの時点の音声の時刻）より前は捨てる
  let aenc = null, reader = null, a0 = null;
  let latestAudio = null;   // {ts, dur, at} 最後に届いた音声ブロック
  if (clip.audio) {
    const track = v.captureStream().getAudioTracks()[0];
    if (!track) throw new Error("この動画から音声を取り出せませんでした");
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    (async () => {
      for (;;) {
        const { value: data, done } = await reader.read();
        if (done || !data) break;
        const dur = data.numberOfFrames / data.sampleRate * 1e6;
        latestAudio = { ts: data.timestamp, dur, at: performance.now() };
        if (!aenc) {
          aRate = data.sampleRate; aCh = data.numberOfChannels;
          aenc = new AudioEncoder({
            output: (chunk, meta) => {
              if (meta && meta.decoderConfig && meta.decoderConfig.description) aDesc = meta.decoderConfig.description;
              if (a0 === null) return;
              const ts = chunk.timestamp - a0;
              if (ts < 0) return;   // 映像が始まる前のぶん
              const d = new Uint8Array(chunk.byteLength);
              chunk.copyTo(d);
              aSamples.push({ ts, dur: chunk.duration || 0, data: d });
            },
            error: e => { encErr = encErr || e; },
          });
          aenc.configure({ codec: "mp4a.40.2", sampleRate: aRate, numberOfChannels: aCh, bitrate: REC_AUDIO_BPS, aac: { format: "aac" } });
        }
        if (a0 !== null && data.timestamp + dur > a0 && aenc.state === "configured") aenc.encode(data);
        data.close();
      }
    })().catch(e => { encErr = encErr || e; });
  }

  // 映像: 新しいコマが画面に出るたびに 1 枚。時刻は元動画の時刻（mediaTime）から付けるので間隔が揃う。
  // 読み込み待ちで再生が止まると時計だけ進むので、そのぶんを stall に足して音声とずれないようにする
  let m0 = null, t0 = 0, stall = 0, lastTs = -1, lastKey = -Infinity, lastT = 0;
  await v.play();
  await new Promise((resolve, reject) => {
    const tStart = Date.now(), limit = total * 1000 * 3 + 15000;
    let done = false, watch = null;
    const finish = (fn, arg) => { if (done) return; done = true; clearInterval(watch); fn(arg); };
    const onFrame = (now, meta) => {
      if (done) return;
      if (meta.mediaTime >= clip.end_sec) { finish(resolve); return; }
      if (m0 === null) {
        m0 = meta.mediaTime; t0 = now;
        a0 = latestAudio ? latestAudio.ts + latestAudio.dur + (now - latestAudio.at) * 1000 : 0;   // 今この瞬間の音声の時刻
      }
      const media = (meta.mediaTime - m0) * 1e6, wall = (now - t0) * 1000;
      if (wall - (media + stall) > REC_STALL_US) stall = wall - media;
      const ts = Math.round(media + stall);
      lastT = Math.max(0, meta.mediaTime - clip.start_sec);
      drawClipFrame(ctx, v, clip, cues, chat, lastT);
      if (ts > lastTs) {
        if (venc.encodeQueueSize > REC_QUEUE_MAX) dropped++;
        else {
          const frame = new VideoFrame(canvas, { timestamp: ts });
          const key = ts - lastKey >= REC_KEYFRAME_US;
          if (key) lastKey = ts;
          venc.encode(frame, { keyFrame: key });
          frame.close();
          lastTs = ts;
        }
      }
      if (encErr) { finish(reject, encErr); return; }
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
    watch = setInterval(() => {
      banner.update(lastT);
      if (v.currentTime >= clip.end_sec || v.ended) finish(resolve);
      else if (Date.now() - tStart > limit) finish(reject, new Error("録画が時間内に終わりませんでした（動画の読み込みが止まっていないか確認してください）"));
      else if (document.hidden) finish(reject, new Error("録画中に YouTube のタブが隠れました。録画中はタブを移動しないでください"));
    }, REC_WATCH_MS);
  });
  v.pause();
  if (reader) { try { await reader.cancel(); } catch (_) { /* 既に閉じた */ } }
  await venc.flush();
  venc.close();
  if (aenc) { await aenc.flush(); aenc.close(); }
  if (encErr) throw encErr;
  if (!vSamples.length) throw new Error("映像のコマを 1 枚も取り込めませんでした");
  if (!vDesc) throw new Error("映像の設定情報（avcC）が取れませんでした");
  vSamples.sort((x, y) => x.ts - y.ts);
  // 最後のコマの長さは 1 つ前の間隔と同じにする
  if (vSamples.length >= 2) vSamples[vSamples.length - 1].dur = vSamples[vSamples.length - 1].ts - vSamples[vSamples.length - 2].ts;
  const audio = clip.audio && aSamples.length ? { samples: aSamples, description: aDesc || aacConfig(aRate, aCh), sampleRate: aRate, channels: aCh } : null;
  if (clip.audio && !audio) throw new Error("音声を 1 つも取り込めませんでした");
  const bytes = buildMp4({ video: { samples: vSamples, description: vDesc, width: W, height: H }, audio });
  return { blob: new Blob([bytes], { type: "video/mp4" }), ext: "mp4", method: "WebCodecs", dropped, frames: vSamples.length };
}

// 録画の入口。準備（停止・位置合わせ・案内）と後片付け（元の状態に戻す）はここで行い、取り込みは (A) か (B) に任せる
async function recordClip(v, clip, cues, chat) {
  if (recording) throw new Error("いま別の録画が進行中です。終わってからもう一度押してください");
  if (!v.videoWidth || !v.videoHeight) throw new Error("動画がまだ読み込まれていません。少し再生してからもう一度お試しください");
  if (typeof v.captureStream !== "function" || typeof v.requestVideoFrameCallback !== "function") throw new Error("このブラウザは録画に対応していません（PC 版の Chrome / Edge で使ってください）");
  normalizeClip(clip);
  const { W, H } = outSize(clip);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const total = clip.end_sec - clip.start_sec;
  const wc = await webCodecsSupport(W, H, clip.audio);

  const orig = { t: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume, rate: v.playbackRate };
  recording = true;
  let banner;
  try {
    v.pause();
    v.playbackRate = 1;
    if (clip.audio) v.muted = false;   // 音声を入れるとき、ミュートのままだと無音の動画になる
    await seekTo(v, clip.start_sec);
    drawClipFrame(ctx, v, clip, cues, chat, 0);
    banner = showRecBanner(total);
    const r = wc.vcfg ? await recordWithWebCodecs(v, clip, cues, chat, ctx, banner, total, wc.vcfg)
                      : await recordWithMediaRecorder(v, clip, cues, chat, ctx, banner, total);
    lastRecording = { id: String(Date.now()), blob: r.blob };
    return { id: lastRecording.id, size: r.blob.size, mime: r.blob.type, ext: r.ext, method: r.method, why: wc.why, dropped: r.dropped, frames: r.frames,
             sec: +total.toFixed(1), mb: +(r.blob.size / 1048576).toFixed(1) };
  } finally {
    if (banner) banner.remove();
    v.pause();
    v.muted = orig.muted; v.volume = orig.volume; v.playbackRate = orig.rate;
    v.currentTime = orig.t;
    if (!orig.paused) v.play().catch(() => {});
    recording = false;
  }
}

// 広告の再生中は <video> が広告の映像になっている。そのまま吸い出し・録画すると広告を切り抜いてしまう
function adPlaying() {
  const p = document.getElementById("movie_player");
  return !!(p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting")));
}
const AD_MSG = "広告の再生中です。広告が終わってから、もう一度押してください。";

// ---- メッセージ ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const build = BUILD;   // 相手（パネル・編集画面）が版の食い違いを見つけるために、すべての応答に付ける
  const v = document.querySelector("video");

  if (msg.type === "CLIP_GET_TIME") {
    if (!v || !videoId()) { sendResponse({ error: "YouTube の動画ページで使ってください" }); return; }
    sendResponse({ build, t: v.currentTime, paused: v.paused, muted: v.muted || v.volume === 0, duration: v.duration, video_id: videoId(), ready: v.readyState >= 1 });
    return;
  }
  if (msg.type === "CLIP_PLAY") {
    // 指定の位置へ移動して再生し、end（動画内の秒）に達したら一時停止する。
    // 編集画面のプレビュー再生（音声はこのタブから鳴る）と、字幕行の「▶」で使う。
    if (!v) { sendResponse({ error: "YouTube の動画ページで使ってください" }); return; }
    if (recording) { sendResponse({ error: "録画中は再生できません" }); return; }
    if (!Number.isFinite(msg.t) || msg.t < 0 || !Number.isFinite(msg.end) || msg.end <= msg.t) { sendResponse({ error: "再生位置が不正です" }); return; }
    clearInterval(window.__clipPlayTimer);   // 連打時は最後の 1 回だけ効かせる
    v.currentTime = msg.t;
    v.play().catch(() => {});
    window.__clipPlayTimer = setInterval(() => {
      if (v.currentTime >= msg.end || v.paused && !v.seeking && v.readyState >= 3) {
        clearInterval(window.__clipPlayTimer);
        if (v.currentTime >= msg.end) v.pause();
      }
    }, 50);
    sendResponse({ build, ok: true });
    return;
  }
  if (msg.type === "CLIP_PAUSE") {
    if (v && !recording) { clearInterval(window.__clipPlayTimer); v.pause(); }
    sendResponse({ build, ok: true });
    return;
  }
  if (msg.type === "CLIP_GET_CHUNK") {
    if (!lastRecording || lastRecording.id !== msg.id) { sendResponse({ error: "録画データが見つかりません。もう一度「動画を作る」を押してください" }); return; }
    blobChunkBase64(lastRecording.blob, msg.offset, msg.length)
      .then(b64 => sendResponse({ build, b64 }))
      .catch(e => sendResponse({ error: `録画データの受け渡しに失敗しました: ${e && e.message ? e.message : e}` }));
    return true;
  }
  if (msg.type === "CLIP_RELEASE") {
    if (lastRecording && lastRecording.id === msg.id) lastRecording = null;   // メモリ解放
    sendResponse({ build, ok: true });
    return;
  }
  if (msg.type === "CLIP_RENDER") {
    (async () => {
      if (!v || videoId() !== msg.clip.video_id) { sendResponse({ error: "切り抜き元の動画を開いている YouTube タブで実行してください" }); return; }
      if (adPlaying()) { sendResponse({ error: AD_MSG }); return; }
      const r = await recordClip(v, msg.clip, msg.cues || [], msg.chat || []);
      sendResponse({ build, ...r });
    })().catch(e => sendResponse({ error: `動画を作れませんでした: ${e && e.message ? e.message : e}` }));
    return true;
  }
  if (msg.type !== "CLIP_CAPTURE") return;
  (async () => {
    const id = videoId();
    if (!v || !id) { sendResponse({ error: "YouTube の動画ページで使ってください" }); return; }
    if (adPlaying()) { sendResponse({ error: AD_MSG }); return; }
    const start = msg.start;
    if (!Number.isFinite(start) || !Number.isFinite(msg.end)) { sendResponse({ error: "開始と終了の時間を入れてください" }); return; }
    if (msg.end <= start) { sendResponse({ error: "終了は開始より後にしてください" }); return; }
    if (msg.end - start > MAX_CLIP_SEC + 0.05) { sendResponse({ error: `長さ ${(msg.end - start).toFixed(1)} 秒が上限の ${MAX_CLIP_SEC} 秒を超えています` }); return; }
    const end = Math.min(msg.end, Number.isFinite(v.duration) ? v.duration : msg.end);
    if (end <= start) { sendResponse({ error: "開始が動画の長さを超えています" }); return; }
    let title = document.title.replace(/ - YouTube$/, "");
    try { const info = await askPage("info"); if (info.id === id && info.title) title = info.title; } catch (_) { /* タイトルはページ名で代用できる */ }
    const captions = await fetchCaptions(start, end);
    const frames = msg.withFrames ? await captureFrames(v, start, end) : undefined;
    const chat = await collectChat(v, start, end);
    sendResponse({
      build,
      clip: { video_id: id, url: `https://www.youtube.com/watch?v=${id}`, title, start_sec: +start.toFixed(3), end_sec: +end.toFixed(3) },
      captions, chat, frames,
    });
  })().catch(e => sendResponse({ error: `取得中にエラー: ${e && e.message ? e.message : e}` }));
  return true;   // async sendResponse
});
