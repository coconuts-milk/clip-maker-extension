// Clip Maker content script — YouTube 再生ページから「現在位置・字幕・チャット欄（リプレイ）」を取る。
// 設計原則: 取れないものは空で誤魔化さず error を返す（呼び側で表示する）。
// MAX_CLIP_SEC は common.js（manifest で先に読み込まれる）で定義。

function videoId() {
  const u = new URL(location.href);
  return u.searchParams.get("v") || (location.pathname.startsWith("/shorts/") ? location.pathname.split("/")[2] : null);
}

function playerResponse() {
  // YouTube はページに ytInitialPlayerResponse を埋め込む。SPA 遷移後は script から再取得する。
  if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails &&
      window.ytInitialPlayerResponse.videoDetails.videoId === videoId()) {
    return window.ytInitialPlayerResponse;
  }
  for (const s of document.querySelectorAll("script")) {
    const m = s.textContent.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (m) { try { const r = JSON.parse(m[1]); if (r.videoDetails && r.videoDetails.videoId === videoId()) return r; } catch (_) {} }
  }
  return null;
}

// inject.js（main world）が横取りしたプレーヤーの字幕応答。{url, body}
let capturedCaptions = null;
window.addEventListener("clip-maker-captions", ev => {
  try { capturedCaptions = JSON.parse(ev.detail); } catch (_) { /* 壊れた detail は無視 */ }
});
// SPA 遷移で前の動画の字幕が残ると別動画の字幕を保存してしまう → 遷移のたびに捨てる
window.addEventListener("yt-navigate-finish", () => { capturedCaptions = null; });

function capturedIsForCurrentVideo() {
  if (!capturedCaptions) return false;
  const v = new URL(capturedCaptions.url, location.href).searchParams.get("v");
  return !v || v === videoId();   // timedtext URL に v= が無い形式は動画照合をスキップ
}

const CAPTION_WAIT_MS = 6000;   // CC ボタンを押してからプレーヤーが字幕を取りに行くまでの待ち上限

function ensureCaptionsOn() {
  const btn = document.querySelector(".ytp-subtitles-button");
  if (btn && btn.getAttribute("aria-pressed") !== "true") btn.click();
}

async function waitCaptured() {
  const t0 = Date.now();
  while (!capturedCaptions && Date.now() - t0 < CAPTION_WAIT_MS) {
    await new Promise(r => setTimeout(r, 200));
  }
  return capturedCaptions;
}

async function fetchCaptions(start, end) {
  const pr = playerResponse();
  const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
                 pr.captions.playerCaptionsTracklistRenderer.captionTracks;
  if (!tracks || !tracks.length) return { error: "この動画には字幕トラックがありません", cues: [] };
  // 拡張から timedtext を直接 fetch すると pot トークン無しで空が返るため、プレーヤーの通信を使う。
  if (!capturedIsForCurrentVideo()) { capturedCaptions = null; ensureCaptionsOn(); await waitCaptured(); }
  if (!capturedIsForCurrentVideo()) {
    // プレーヤー初期化直後は CC が ON でも timedtext を取りに行かないことがある（2026-08 実測）
    // → 一度 OFF→ON にトグルして取得し直させる
    const btn = document.querySelector(".ytp-subtitles-button");
    if (btn) {
      btn.click(); await new Promise(r => setTimeout(r, 300)); btn.click();
      await waitCaptured();
    }
  }
  if (!capturedIsForCurrentVideo()) return { error: "字幕を取得できませんでした。プレーヤーの CC ボタンを押してからもう一度お試しください", cues: [] };
  const lang = new URL(capturedCaptions.url, location.href).searchParams.get("lang") || "";
  let j;
  try { j = JSON.parse(capturedCaptions.body); }
  catch (_) { return { error: "字幕の形式が想定外（json3 ではない）", cues: [] }; }
  const cues = [];
  for (const ev of (j.events || [])) {
    if (!ev.segs) continue;
    const t0 = ev.tStartMs / 1000, t1 = t0 + (ev.dDurationMs || 0) / 1000;
    if (t1 < start || t0 > end) continue;
    const text = ev.segs.map(s => s.utf8).join("").replace(/\n/g, " ").trim();
    if (text) cues.push({ start: +(Math.max(t0, start) - start).toFixed(3), end: +(Math.min(t1, end) - start).toFixed(3), text });
  }
  return { lang, cues };
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
  // 「チャットのリプレイを表示」が閉じていたら開く
  const btn = document.querySelector("#show-hide-button button");
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
  const sec = parseTimeStr(neg ? s.slice(1) : s);   // common.js
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
// 取れないときは明示 error（コメント欄で代用したり空で誤魔化したりしない）。
async function collectChat(v, start, end) {
  if (!(await ensureChatOpen())) {
    return { error: "チャット欄が見つかりません（チャットリプレイの無い動画では取れません）", messages: [] };
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
      return { error: "チャットを読み込めませんでした（チャットリプレイが表示されているか確認してください）", messages: [] };
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
// YouTube 埋め込み iframe は拡張ページ（referer 無し）だとエラー 153 で拒否されるため、
// 吸い出し時に <video> から実際のコマを canvas で撮って編集画面に渡す（2026-08-26 実機で確認）。
// 2026-09-28: プレビューを「再生」できるよう、3 枚から FRAME_STEP_SEC 刻み（最大 FRAME_MAX 枚）に増やす。
// storage.local（既定 10MB）に収めるため幅 960・JPEG 0.7（1 枚 ≒ 60KB × 31 枚 ≒ 2MB）。

const FRAME_W = 960;
const FRAME_STEP_SEC = 2;    // コマの間隔。字幕・チャットの出入りを追うには 2 秒で十分（コマ自体は静止画）
const FRAME_MAX = 31;        // 60 秒 ÷ 2 + 両端
const SEEK_TIMEOUT_MS = 8000;
const DECODE_WAIT_MS = 250;  // seeked 後にフレームが描画されるまでの余裕

function seekTo(v, t) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { v.removeEventListener("seeked", on); reject(new Error("プレビュー用のシークがタイムアウトしました")); }, SEEK_TIMEOUT_MS);
    const on = () => { clearTimeout(timer); v.removeEventListener("seeked", on); setTimeout(resolve, DECODE_WAIT_MS); };
    v.addEventListener("seeked", on);
    v.currentTime = t;
  });
}

// 区間内のコマを {t: 開始からの相対秒, dataUrl} のリストで返す（開始・FRAME_STEP_SEC 刻み・終了）。撮れないときは {error}。
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
// 再生中の <video> を canvas に描き、その上にマスク・字幕・チャットを重ねて MediaRecorder で録画する。
// 実時間で再生しながら録るので、60 秒の切り抜きは 60 秒かかる。音声は <video> の captureStream から取る。
// 見た目は編集画面の「出来上がり」プレビューと同じ規則（文字サイズは短辺基準・チャットは新しい順に max 件）。

const REC_FPS = 30;
const REC_VIDEO_BPS = 8000000;   // 1080p30 の H.264 で破綻しない実用値
const REC_AUDIO_BPS = 192000;
const REC_CAPTION_FONT_PCT = 6.9, REC_CAPTION_OUTLINE_PCT = 0.7, REC_CAPTION_MARGIN_V_PCT = 7, REC_CAPTION_MARGIN_H_PCT = 4;
const REC_CHAT_OUTLINE_PCT = 0.35, REC_CHAT_LINE_GAP = 0.3, REC_LINE_HEIGHT = 1.25;
const REC_FONT = "Meiryo, 'Yu Gothic', sans-serif";
// mp4 を優先。録れない環境だけ webm（拡張子も webm にして、黙って別形式を mp4 と偽らない）
const REC_MIMES = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4",
                   "video/webm;codecs=h264,opus", "video/webm;codecs=vp9,opus", "video/webm"];

function wrapByWidth(ctx, text, maxW) {
  const out = [];
  for (const line of String(text).split("\n")) {
    let cur = "";
    for (const ch of line) {
      if (cur && ctx.measureText(cur + ch).width > maxW) {
        // 英単語の途中では切らない: 半角文字の連続の途中なら直前の空白まで戻って折り返す（日本語はどこでも折り返す）
        const sp = cur.lastIndexOf(" ");
        const midWord = ch !== " " && ch.charCodeAt(0) < 0x3000 && cur.charCodeAt(cur.length - 1) < 0x3000 && !cur.endsWith(" ");
        if (midWord && sp > 0) { out.push(cur.slice(0, sp)); cur = cur.slice(sp + 1); }
        else { out.push(cur); cur = ""; }
      }
      if (cur === "" && ch === " ") continue;   // 行頭の空白は捨てる
      cur += ch;
    }
    out.push(cur);
  }
  return out;
}

function drawOutlined(ctx, text, x, y, outline, fill) {
  ctx.lineJoin = "round";
  ctx.lineWidth = outline * 2;
  ctx.strokeStyle = "#000";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill || "#fff";
  ctx.fillText(text, x, y);
}

// 1 コマ描く。t は切り抜き開始からの秒。
function drawClipFrame(ctx, v, W, H, clip, cues, chat, t) {
  const portrait = clip.frame && clip.frame.mode === "portrait";
  const crop = portrait ? clip.frame.crop : { x: 0, y: 0, w: VIDEO_W, h: VIDEO_H };
  const sx = v.videoWidth / VIDEO_W, sy = v.videoHeight / VIDEO_H;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(v, crop.x * sx, crop.y * sy, crop.w * sx, crop.h * sy, 0, 0, W, H);

  // 隠す四角（元画面 1920×1080 基準の座標 → 出力座標）
  const dur = clip.end_sec - clip.start_sec;
  ctx.fillStyle = "#000";
  for (const m of (clip.masks || [])) {
    const mEnd = m.end === null || m.end === undefined ? dur : m.end;
    if (t < (m.start || 0) || t > mEnd) continue;
    ctx.fillRect((m.x - crop.x) / crop.w * W, (m.y - crop.y) / crop.h * H, m.w / crop.w * W, m.h / crop.h * H);
  }

  const short = Math.min(W, H);

  // 字幕（下中央・白文字黒縁）
  const capSize = short * REC_CAPTION_FONT_PCT / 100;
  ctx.font = `700 ${capSize}px ${REC_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const capLines = [];
  for (const c of cues) {
    if (c.start <= t && t <= c.end && c.text.trim()) capLines.push(...wrapByWidth(ctx, c.text, W * (1 - 2 * REC_CAPTION_MARGIN_H_PCT / 100)));
  }
  let y = H * (1 - REC_CAPTION_MARGIN_V_PCT / 100) - (capLines.length - 1) * capSize * REC_LINE_HEIGHT;
  for (const line of capLines) {
    drawOutlined(ctx, line, W / 2, y, short * REC_CAPTION_OUTLINE_PCT / 100);
    y += capSize * REC_LINE_HEIGHT;
  }

  // チャット（指定枠・新しい順に max 件・show_sec で消える）
  const o = clip.chat_overlay;
  if (o && o.enabled) {
    const size = short * o.font_pct / 100, boxW = W * o.w_pct / 100, x0 = W * o.x_pct / 100;
    ctx.font = `700 ${size}px ${REC_FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const outline = Math.max(1, short * REC_CHAT_OUTLINE_PCT / 100);
    const vis = chat.filter(m => m.t <= t && (o.show_sec <= 0 || t - m.t < o.show_sec)).sort((a, b) => b.t - a.t).slice(0, o.max);
    let cy = H * o.y_pct / 100;
    for (const m of vis) {
      const amt = m.amount ? `${m.amount} ` : "";
      const lines = wrapByWidth(ctx, amt + m.text, boxW);
      lines.forEach((line, i) => {
        if (i === 0 && amt && line.startsWith(amt)) {
          drawOutlined(ctx, amt, x0, cy, outline, "#ffd400");   // スパチャ金額は黄
          drawOutlined(ctx, line.slice(amt.length), x0 + ctx.measureText(amt).width, cy, outline);
        } else {
          drawOutlined(ctx, line, x0, cy, outline);
        }
        cy += size * REC_LINE_HEIGHT;
      });
      cy += size * REC_CHAT_LINE_GAP;
    }
  }
}

let recording = false;
let lastRecording = null;   // {id, blob}。編集画面が CLIP_GET_CHUNK で取りに来るまで保持する

// Blob の一部を base64 で返す（メッセージは JSON なのでバイナリをそのまま送れない）
function blobChunkBase64(blob, offset, length) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = () => reject(fr.error || new Error("録画データを読めませんでした"));
    fr.readAsDataURL(blob.slice(offset, offset + length));
  });
}

// 録画して Blob を保持する。返り値 {id, size, mime, file, ...}。保存は編集画面が拡張のダウンロード機能で行う
// （ページ側の <a download> は 2 本目以降が Chrome の「複数ファイルのダウンロード」制限で止まる＝2026-09-28 実機で確認）。
// 失敗はメッセージを throw。
async function recordClip(v, clip, cues, chat) {
  if (recording) throw new Error("いま別の録画が進行中です。終わってからもう一度押してください");
  if (!v.videoWidth || !v.videoHeight) throw new Error("動画がまだ読み込まれていません。少し再生してからもう一度お試しください");
  if (typeof v.captureStream !== "function" || typeof MediaRecorder === "undefined") throw new Error("このブラウザは録画に対応していません（Chrome / Edge の PC 版で使ってください）");
  const mime = REC_MIMES.find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("このブラウザで録画できる動画形式がありません");
  const portrait = clip.frame && clip.frame.mode === "portrait";
  const W = portrait ? PORTRAIT_W : VIDEO_W, H = portrait ? PORTRAIT_H : VIDEO_H;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  const orig = { t: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume, rate: v.playbackRate };
  recording = true;
  let rec;
  try {
    v.pause();
    v.playbackRate = 1;
    v.muted = false;   // ミュートのままだと無音の動画になる
    await seekTo(v, clip.start_sec);
    drawClipFrame(ctx, v, W, H, clip, cues, chat, 0);

    const audioTracks = v.captureStream().getAudioTracks();
    const stream = new MediaStream([...canvas.captureStream(REC_FPS).getVideoTracks(), ...audioTracks]);
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: REC_VIDEO_BPS, audioBitsPerSecond: REC_AUDIO_BPS });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => { rec.onstop = resolve; rec.onerror = e => reject(e.error || new Error("録画エラー")); });

    rec.start(1000);
    await v.play();
    await new Promise((resolve, reject) => {
      const t0 = Date.now(), limit = (clip.end_sec - clip.start_sec) * 1000 * 3 + 15000;   // 読み込み待ちで止まっても永久に待たない
      const loop = () => {
        drawClipFrame(ctx, v, W, H, clip, cues, chat, Math.max(0, v.currentTime - clip.start_sec));
        if (v.currentTime >= clip.end_sec || v.ended) { resolve(); return; }
        if (Date.now() - t0 > limit) { reject(new Error("録画が時間内に終わりませんでした（動画の読み込みが止まっていないか確認してください）")); return; }
        if (document.hidden) { reject(new Error("録画中に YouTube のタブが隠れました。録画中はこのタブを表示したままにしてください")); return; }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    v.pause();
    rec.stop();
    await stopped;

    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    if (!blob.size) throw new Error("録画データが空でした");
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    const file = `clip_${clip.video_id}_${Math.floor(clip.start_sec)}_${portrait ? "tate" : "yoko"}.${ext}`;
    lastRecording = { id: String(Date.now()), blob };
    return { id: lastRecording.id, size: blob.size, mime: blob.type, file, ext,
             sec: +(clip.end_sec - clip.start_sec).toFixed(1), mb: +(blob.size / 1048576).toFixed(1) };
  } finally {
    if (rec && rec.state !== "inactive") { try { rec.stop(); } catch (_) { /* 既に停止 */ } }
    v.pause();
    v.muted = orig.muted; v.volume = orig.volume; v.playbackRate = orig.rate;
    v.currentTime = orig.t;
    if (!orig.paused) v.play().catch(() => {});
    recording = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CLIP_GET_CHUNK") {
    if (!lastRecording || lastRecording.id !== msg.id) { sendResponse({ error: "録画データが見つかりません。もう一度「動画を作る」を押してください" }); return; }
    blobChunkBase64(lastRecording.blob, msg.offset, msg.length)
      .then(b64 => sendResponse({ ver: chrome.runtime.getManifest().version, b64 }))
      .catch(e => sendResponse({ error: `録画データの受け渡しに失敗しました: ${e && e.message ? e.message : e}` }));
    return true;
  }
  if (msg.type === "CLIP_RELEASE") {
    if (lastRecording && lastRecording.id === msg.id) lastRecording = null;   // メモリ解放
    sendResponse({ ver: chrome.runtime.getManifest().version, ok: true });
    return;
  }
  if (msg.type === "CLIP_RENDER") {
    (async () => {
      const v = document.querySelector("video");
      if (!v || videoId() !== msg.clip.video_id) { sendResponse({ error: "切り抜き元の動画を開いている YouTube タブで実行してください" }); return; }
      const r = await recordClip(v, msg.clip, msg.cues || [], msg.chat || []);
      sendResponse({ ver: chrome.runtime.getManifest().version, ...r });
    })().catch(e => sendResponse({ error: `動画を作れませんでした: ${e && e.message ? e.message : e}` }));
    return true;   // async sendResponse
  }
  if (msg.type === "CLIP_GET_TIME") {
    // 「▶ 今の再生位置を開始にする」用。同期応答（待つものが無い）
    const v = document.querySelector("video");
    if (!v) { sendResponse({ error: "YouTube の再生ページで使ってください" }); return; }
    sendResponse({ ver: chrome.runtime.getManifest().version, t: v.currentTime, paused: v.paused, duration: v.duration });
    return;
  }
  if (msg.type === "CLIP_PLAY") {
    // 字幕行の「▶」用。指定の絶対秒へシークして再生し、dur 秒後に一時停止する（音声位置の確認）。
    const v = document.querySelector("video");
    if (!v) { sendResponse({ error: "YouTube の再生ページで使ってください" }); return; }
    if (!Number.isFinite(msg.t) || msg.t < 0) { sendResponse({ error: "再生位置が不正です" }); return; }
    v.currentTime = msg.t;
    v.play().catch(() => {});
    clearTimeout(window.__clipPlayTimer);   // 連打時は前の停止予約を破棄して最後の1回だけ効かせる
    if (Number.isFinite(msg.dur) && msg.dur > 0) {
      window.__clipPlayTimer = setTimeout(() => v.pause(), msg.dur * 1000);
    }
    sendResponse({ ver: chrome.runtime.getManifest().version, ok: true });
    return;
  }
  if (msg.type !== "CLIP_CAPTURE") return;
  (async () => {
    const v = document.querySelector("video");
    const id = videoId();
    if (!v || !id) { sendResponse({ error: "YouTube の再生ページで使ってください" }); return; }
    const start = Number.isFinite(msg.start) ? msg.start : v.currentTime;
    let end;
    if (Number.isFinite(msg.end)) {
      // 終了指定あり: 不正は黙って切り詰めず明示エラー（P-03）
      if (msg.end <= start) { sendResponse({ error: `終了(${fmtTime(msg.end)}) は開始(${fmtTime(start)}) より後にしてください` }); return; }
      if (msg.end - start > MAX_CLIP_SEC) { sendResponse({ error: `長さ ${(msg.end - start).toFixed(1)} 秒が無料版の上限 ${MAX_CLIP_SEC} 秒を超えています` }); return; }
      end = msg.end;
    } else {
      const len = Math.min(Math.max(msg.length || 15, 1), MAX_CLIP_SEC);
      end = start + len;
    }
    end = Math.min(end, Number.isFinite(v.duration) ? v.duration : end);
    const pr = playerResponse();
    const title = (pr && pr.videoDetails && pr.videoDetails.title) || document.title;
    const captions = await fetchCaptions(start, end);
    const frames = msg.withFrames ? await captureFrames(v, start, end) : undefined;
    const chat = await collectChat(v, start, end);
    sendResponse({
      ver: chrome.runtime.getManifest().version,   // popup 側で新旧不一致（🔄忘れ）を検出するため
      clip: { video_id: id, url: `https://www.youtube.com/watch?v=${id}`, title,
              start_sec: +start.toFixed(3), end_sec: +end.toFixed(3), max_clip_sec: MAX_CLIP_SEC,
              captured_at: new Date().toISOString() },
      captions,
      chat,
      frames,
    });
  })().catch(e => sendResponse({ error: `取得中にエラー: ${e && e.message ? e.message : e}` }));
  return true;   // async sendResponse
});
