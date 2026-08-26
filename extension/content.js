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

const FRAME_W = 1280;        // プレビュー幅。マスク位置決め用途には十分で storage も軽い
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

// 開始・中間・終了の 3 コマを {t: 開始からの相対秒, dataUrl} で返す。撮れないときは {error}。
async function captureFrames(v, start, end) {
  const origTime = v.currentTime, wasPaused = v.paused;
  try {
    if (!v.videoWidth || !v.videoHeight) return { error: "動画がまだ読み込まれていません。少し再生してからもう一度お試しください" };
    v.pause();
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_W;
    canvas.height = Math.round(FRAME_W * v.videoHeight / v.videoWidth);
    const ctx = canvas.getContext("2d");
    const list = [];
    for (const t of [start, (start + end) / 2, Math.max(start, end - 0.1)]) {
      await seekTo(v, t);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      list.push({ t: +(t - start).toFixed(1), dataUrl: canvas.toDataURL("image/jpeg", 0.8) });
    }
    return { w: canvas.width, h: canvas.height, list };
  } catch (e) {
    return { error: `プレビュー画像を取得できませんでした: ${e && e.message ? e.message : e}` };
  } finally {
    v.currentTime = origTime;
    if (!wasPaused) v.play().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "CLIP_CAPTURE") return;
  (async () => {
    const v = document.querySelector("video");
    const id = videoId();
    if (!v || !id) { sendResponse({ error: "YouTube の再生ページで使ってください" }); return; }
    const start = Number.isFinite(msg.start) ? msg.start : v.currentTime;
    const len = Math.min(Math.max(msg.length || 15, 1), MAX_CLIP_SEC);
    const end = Math.min(start + len, Number.isFinite(v.duration) ? v.duration : start + len);
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
