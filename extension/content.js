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

async function fetchCaptions(start, end) {
  const pr = playerResponse();
  const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
                 pr.captions.playerCaptionsTracklistRenderer.captionTracks;
  if (!tracks || !tracks.length) return { error: "この動画には字幕トラックがありません", cues: [] };
  const track = tracks.find(t => /^ja/.test(t.languageCode)) || tracks[0];
  const res = await fetch(track.baseUrl + "&fmt=json3");
  if (!res.ok) return { error: `字幕の取得に失敗 (${res.status})`, cues: [] };
  const j = await res.json();
  const cues = [];
  for (const ev of (j.events || [])) {
    if (!ev.segs) continue;
    const t0 = ev.tStartMs / 1000, t1 = t0 + (ev.dDurationMs || 0) / 1000;
    if (t1 < start || t0 > end) continue;
    const text = ev.segs.map(s => s.utf8).join("").replace(/\n/g, " ").trim();
    if (text) cues.push({ start: Math.max(t0, start) - start, end: Math.min(t1, end) - start, text });
  }
  return { lang: track.languageCode, cues };
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
    const end = Math.min(start + len, v.duration || start + len);
    const title = playerResponse()?.videoDetails?.title || document.title;
    const captions = await fetchCaptions(start, end);
    sendResponse({
      clip: { video_id: id, url: `https://www.youtube.com/watch?v=${id}`, title,
              start_sec: +start.toFixed(3), end_sec: +end.toFixed(3), max_clip_sec: MAX_CLIP_SEC,
              captured_at: new Date().toISOString() },
      captions,
      comments: collectComments(),
    });
  })();
  return true;   // async sendResponse
});
