// Clip Maker content script — YouTube 再生ページから「現在位置・字幕・表示中コメント」を取る。
// 設計原則: 取れないものは空で誤魔化さず error を返す（呼び側で表示する）。

const MAX_CLIP_SEC = 30;   // 無料版の上限（仕様: 30 秒上限）

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
  if (!capturedCaptions) { ensureCaptionsOn(); await waitCaptured(); }
  if (!capturedCaptions) return { error: "字幕を取得できませんでした。プレーヤーの CC ボタンを押してからもう一度お試しください", cues: [] };
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

function collectComments() {
  // 表示済みコメントだけ（YouTube Data API キー不要）。未スクロール分は取れないので件数を返す。
  const out = [];
  document.querySelectorAll("ytd-comment-view-model, ytd-comment-renderer").forEach(el => {
    const author = el.querySelector("#author-text")?.textContent.trim();
    const text = el.querySelector("#content-text")?.textContent.trim();
    const likes = el.querySelector("#vote-count-middle")?.textContent.trim() || "0";
    if (text) out.push({ author, text, likes });
  });
  return out;
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
    sendResponse({
      clip: { video_id: id, url: `https://www.youtube.com/watch?v=${id}`, title,
              start_sec: +start.toFixed(3), end_sec: +end.toFixed(3), max_clip_sec: MAX_CLIP_SEC,
              captured_at: new Date().toISOString() },
      captions,
      comments: collectComments(),
    });
  })().catch(e => sendResponse({ error: `取得中にエラー: ${e && e.message ? e.message : e}` }));
  return true;   // async sendResponse
});
