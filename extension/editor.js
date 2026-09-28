// 編集画面（2 段階フローの ②③④⑤）。popup が storage に置いた draft を読み、
// YouTube タブと再通信して範囲の取り直し（吸い出し直し）もできる。
// 2026-09-28 エイジ指示:
//   ①最長 60 秒 ②開始・終了が常に見える ③開始・終了・長さの 3 欄連動 ④開始・終了の両方に「▶ 今の位置」
//   ⑤字幕・チャットを乗せた「出来上がり」プレビューを再生できる ⑥縦（Shorts 9:16）の切り出し
// マスク・crop 座標は 1920×1080 基準（common.js VIDEO_W/H。プロ版 render は height<=1080 で取得するため）。

const CAPTION_FONT_PCT = 6.9;   // 字幕の文字高（出力の短辺に対する %）。core.py CAPTION_FONT_PCT と同じ

let draft = null;
let range = null;   // common.js setupRangeControl
const $ = id => document.getElementById(id);

function showError(text) { const m = $("msg"); m.className = ""; m.textContent = text; }
function showOk(text) { const m = $("msg"); m.className = "ok"; m.textContent = text; }
function capMsg(text, cls) { const m = $("capmsg"); m.className = cls || ""; m.textContent = text; }
const persist = () => chrome.storage.local.set({ draft });

// ---- YouTube タブとの再通信（吸い出し直し・今の再生位置） ----

// draft の動画を開いている YouTube タブを探す。無ければメッセージ文字列を throw（黙って諦めない）。
async function ytTab() {
  const tabs = await chrome.tabs.query({ url: "*://www.youtube.com/*" });
  const tab = tabs.find(t => (t.url || "").includes(draft.clip.video_id));
  if (!tab) {
    throw `この動画（${draft.clip.video_id}）を開いている YouTube タブが見つかりません。\n` +
          `${draft.clip.url} を開いてから、もう一度このボタンを押してください。`;
  }
  return tab;
}

async function sendToTab(req) {
  const tab = await ytTab();
  return assertVer(await messageWithInject(tab.id, req));   // common.js（popup と同じ経路）
}

// ① 範囲表示: 「1:24:09 〜 1:24:25（16.0 秒）」を常時表示。吸い出し済みの範囲と違えば注意も出す
function showRange() {
  const v = $("rangeview");
  try {
    const r = range.read();
    const stale = draft && (Math.abs(r.start - draft.clip.start_sec) > 0.05 || Math.abs(r.end - draft.clip.end_sec) > 0.05);
    v.className = ""; v.textContent = `${fmtTime(r.start)} 〜 ${fmtTime(r.end)}（${r.len.toFixed(1)} 秒）` + (stale ? "　← 変更あり。🔄 で吸い出し直してください" : "");
  } catch (e) { v.className = "bad"; v.textContent = String(e); }
}

// 今の範囲で字幕・チャット・プレビューを取り直す。マスク・レイアウト・チャット設定は引き継ぐ。
async function recapture() {
  let r0;
  try { r0 = range.read(); } catch (e) { capMsg(String(e)); return; }
  capMsg("吸い出し中…（コマ画像は 2 秒ごとに撮るので、60 秒なら 20 秒ほどかかります。YouTube タブがシークします）", "busy");
  let r;
  try { r = await sendToTab({ type: "CLIP_CAPTURE", start: r0.start, end: r0.end, withFrames: true }); }
  catch (e) { capMsg(String(e)); return; }
  draft.clip = { ...r.clip, masks: draft.clip.masks, frame: draft.clip.frame, chat_overlay: draft.clip.chat_overlay };
  draft.captions = r.captions;
  draft.chat = r.chat;
  draft.frames = r.frames;
  await persist();
  renderAll();
  capMsg(`吸い出し直しました: ${fmtTime(r.clip.start_sec)} 〜 ${fmtTime(r.clip.end_sec)}` +
         (r.captions.error ? `\n字幕: ${r.captions.error}` : `／字幕 ${r.captions.cues.length} 行`) +
         (r.chat.error ? `\nチャット: ${r.chat.error}` : `／チャット ${r.chat.messages.length} 件`), "ok");
}

async function nowInto(which) {
  capMsg("再生位置を取得中…", "busy");
  try {
    const r = await sendToTab({ type: "CLIP_GET_TIME" });
    if (which === "start") range.setStart(r.t); else range.setEnd(r.t);
    capMsg(`${which === "start" ? "開始" : "終了"}に ${fmtTime(r.t)} を入れました${r.paused ? "（停止中の位置）" : ""}。🔄 を押すと吸い出し直します。`, "ok");
  } catch (e) { capMsg(String(e)); }
}

// ---- 出力レイアウト（横 / 縦） ----

function frame() { return draft.clip.frame || (draft.clip.frame = defaultFrame("landscape")); }
function isPortrait() { return frame().mode === "portrait"; }
// 出力の座標系: 横は元画面そのまま、縦は crop 領域。元画面座標 → 出力に対する % に変換する
function outRect() { return isPortrait() ? frame().crop : { x: 0, y: 0, w: VIDEO_W, h: VIDEO_H }; }

function setMode(mode) {
  const cur = frame();
  if (cur.mode === mode) return;
  draft.clip.frame = mode === "portrait" ? (cur.savedCrop ? { mode, crop: cur.savedCrop } : defaultFrame("portrait"))
                                         : { mode: "landscape", savedCrop: cur.crop };
  persist();
  renderLayout();
}

function renderLayout() {
  const p = isPortrait();
  $("out").className = p ? "portrait" : "";
  $("modenote").textContent = p ? "元画面の黄色い枠（608×1080）を 1080×1920 に拡大して出力。枠はドラッグで左右に動かせる" : "元動画の画面全体をそのまま出力";
  const cb = $("cropbox");
  cb.style.display = p ? "block" : "none";
  if (p) {
    const c = frame().crop;
    cb.style.left = (c.x / VIDEO_W * 100) + "%";
    cb.style.width = (c.w / VIDEO_W * 100) + "%";
  }
  renderOverlay();
  renderPreview();
}

// ---- マスク ----

function renderMasks() {
  const tb = $("masks").querySelector("tbody");
  tb.textContent = "";
  draft.clip.masks.forEach((mask, i) => {
    const tr = document.createElement("tr");
    for (const key of ["x", "y", "w", "h", "start", "end"]) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "number";
      inp.value = mask[key] === null || mask[key] === undefined ? "" : mask[key];
      inp.addEventListener("input", () => {
        mask[key] = inp.value === "" ? (key === "end" ? null : 0) : Number(inp.value);
        renderOverlay(); renderPreview();
      });
      td.appendChild(inp);
      tr.appendChild(td);
    }
    const td = document.createElement("td");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "削除";
    del.addEventListener("click", () => { draft.clip.masks.splice(i, 1); renderMasks(); renderPreview(); });
    td.appendChild(del);
    tr.appendChild(td);
    tb.appendChild(tr);
  });
  renderOverlay();
}

function renderOverlay() {
  // 元画面上の黒矩形（% 配置なので表示サイズに依存しない）
  const ov = $("overlay");
  ov.querySelectorAll(".maskbox").forEach(e => e.remove());
  for (const m of draft.clip.masks) {
    const d = document.createElement("div");
    d.className = "maskbox";
    d.style.left = (m.x / VIDEO_W * 100) + "%";
    d.style.top = (m.y / VIDEO_H * 100) + "%";
    d.style.width = (m.w / VIDEO_W * 100) + "%";
    d.style.height = (m.h / VIDEO_H * 100) + "%";
    ov.insertBefore(d, $("cropbox"));
  }
}

// ---- 字幕表 ----

function renderCues() {
  $("cuesmsg").textContent = draft.captions.error ? `字幕を取得できていません: ${draft.captions.error}\n→ ①の「🔄 この範囲で吸い出し直す」で再取得できます（YouTube タブで CC を押してからだと確実）。` :
    draft.captions.cues.length === 0 ? "この範囲に字幕がありません（必要なら下の「字幕を追加」で手で入れられます）。" : "";
  const tb = $("cues").querySelector("tbody");
  tb.textContent = "";
  draft.captions.cues.forEach((cue, i) => {
    const tr = document.createElement("tr");
    const tdPlay = document.createElement("td");
    const play = document.createElement("button");
    play.className = "playcue"; play.textContent = "▶"; play.title = "YouTube タブでこの字幕の位置を再生（音声確認）";
    play.addEventListener("click", () => playCue(cue));
    tdPlay.appendChild(play);
    tr.appendChild(tdPlay);
    for (const key of ["start", "end"]) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "number"; inp.step = "0.001"; inp.value = cue[key];
      inp.addEventListener("input", () => { cue[key] = Number(inp.value); renderPreview(); });
      td.appendChild(inp);
      tr.appendChild(td);
    }
    const tdText = document.createElement("td");
    const text = document.createElement("input");
    text.type = "text"; text.value = cue.text;
    text.addEventListener("input", () => { cue.text = text.value; renderPreview(); });
    tdText.appendChild(text);
    tr.appendChild(tdText);
    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "削除";
    del.addEventListener("click", () => { draft.captions.cues.splice(i, 1); renderCues(); renderPreview(); });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);
    tb.appendChild(tr);
  });
}

// ---- チャット表（表示専用。チャットは編集しない。author は chat.json には保存され続ける） ----

function renderChat() {
  $("chatmsg").textContent = draft.chat.error ? `チャットを取得できていません: ${draft.chat.error}\n→ ①の「🔄 この範囲で吸い出し直す」で再取得できます。` :
    draft.chat.messages.length === 0 ? "この範囲にチャットがありません。" : "";
  const tb = $("chat").querySelector("tbody");
  tb.textContent = "";
  for (const c of draft.chat.messages) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td");
    tdTime.textContent = String(c.t);
    tr.appendChild(tdTime);
    const tdT = document.createElement("td");
    if (c.amount) { const s = document.createElement("span"); s.className = "amt"; s.textContent = `${c.amount} `; tdT.appendChild(s); }
    if (c.type === "membership") { const s = document.createElement("span"); s.className = "note"; s.textContent = "（メンバー）"; tdT.appendChild(s); }
    tdT.appendChild(document.createTextNode(c.text));
    tr.appendChild(tdT);
    tb.appendChild(tr);
  }
}

// 字幕行の ▶: YouTube タブを字幕の絶対位置へシークして再生（字幕の長さ分だけ流れて自動停止）
async function playCue(cue) {
  try {
    await sendToTab({ type: "CLIP_PLAY", t: draft.clip.start_sec + cue.start, dur: Math.max(cue.end - cue.start, 0.5) });
    $("cuesmsg").textContent = "";
  } catch (e) { $("cuesmsg").textContent = String(e); }
}

// ---- チャット焼き込み設定 ----

function chatOv() { return draft.clip.chat_overlay || (draft.clip.chat_overlay = { ...DEFAULT_CHAT_OVERLAY }); }

function renderChatOpts() {
  const o = chatOv();
  $("chat_on").checked = !!o.enabled;
  $("chat_max").value = o.max; $("chat_show").value = o.show_sec; $("chat_w").value = o.w_pct; $("chat_font").value = o.font_pct;
}

function bindChatOpts() {
  $("chat_on").addEventListener("change", () => { chatOv().enabled = $("chat_on").checked; persist(); renderPreview(); });
  const numOpt = (id, key, lo, hi) => $(id).addEventListener("input", () => {
    const v = Number($(id).value);
    if (Number.isFinite(v) && v >= lo && v <= hi) { chatOv()[key] = v; persist(); renderPreview(); }
  });
  numOpt("chat_max", "max", 1, 12); numOpt("chat_show", "show_sec", 0, 60); numOpt("chat_w", "w_pct", 10, 100); numOpt("chat_font", "font_pct", 1, 8);
}

// その時刻に画面に出ているチャット（焼き付けの core.py visible_chat と同じ規則: t 以前・show_sec 以内・新しい順に max 件）
function visibleChat(t) {
  const o = chatOv();
  if (!o.enabled) return [];
  return draft.chat.messages
    .filter(m => m.t <= t && (o.show_sec <= 0 || t - m.t < o.show_sec))
    .sort((a, b) => b.t - a.t).slice(0, o.max);
}

// ---- プレビュー（時刻スライダー + 再生 + 最寄りコマ + 字幕帯 + チャット枠。出力レイアウトで表示） ----

function nearestFrame(t) {
  const f = draft.frames;
  if (!f || f.error || !f.list || !f.list.length) return null;
  let best = f.list[0];
  for (const fr of f.list) if (Math.abs(fr.t - t) < Math.abs(best.t - t)) best = fr;
  return best;
}

function renderPreview() {
  const dur = draft.clip.end_sec - draft.clip.start_sec;
  const slider = $("pvtime");
  slider.max = dur.toFixed(1);
  const t = Math.min(Number(slider.value), dur);
  $("pvtimedisp").textContent = `${fmtTime(draft.clip.start_sec + t)}　開始+${t.toFixed(1)} / ${dur.toFixed(1)} 秒`;

  const best = nearestFrame(t);
  const img = $("frame"), sm = $("stagemsg"), oimg = $("outimg"), om = $("outmsg");
  const f = draft.frames;
  if (!best) {
    const why = (f && f.error) ? `${f.error}\n→ ①の「🔄 この範囲で吸い出し直す」で撮り直せます。` :
      "プレビュー画像がありません。①の「🔄 この範囲で吸い出し直す」を押すと表示されます。";
    sm.textContent = why; om.textContent = why;
    img.removeAttribute("src"); oimg.removeAttribute("src");
  } else {
    sm.textContent = ""; om.textContent = "";
    if (img.getAttribute("src") !== best.dataUrl) { img.src = best.dataUrl; oimg.src = best.dataUrl; }
  }

  // 出力プレビューの画像配置: 横はそのまま、縦は crop 領域が枠いっぱいになるよう拡大して左にずらす
  const r = outRect();
  oimg.style.width = (VIDEO_W / r.w * 100) + "%";
  oimg.style.left = (-r.x / r.w * 100) + "%";
  oimg.style.top = (-r.y / r.h * 100) + "%";

  // 出力上のマスク（その時刻に有効なものだけ。焼き付けの enable=between と同じ）
  const om2 = $("outmasks");
  om2.textContent = "";
  for (const m of draft.clip.masks) {
    const mEnd = m.end === null || m.end === undefined ? dur : m.end;
    if (t < (m.start || 0) || t > mEnd) continue;
    const d = document.createElement("div");
    d.className = "outmask";
    d.style.left = ((m.x - r.x) / r.w * 100) + "%";
    d.style.top = ((m.y - r.y) / r.h * 100) + "%";
    d.style.width = (m.w / r.w * 100) + "%";
    d.style.height = (m.h / r.h * 100) + "%";
    om2.appendChild(d);
  }

  const outEl = $("out");
  const shortSide = Math.min(outEl.clientWidth || 640, outEl.clientHeight || 360);   // 文字の大きさは短辺基準（core.py build_ass と同じ）

  // 字幕帯（焼き付けと同じ「その時刻に出ている字幕」）
  const band = $("cueband");
  band.textContent = "";
  const active = draft.captions.cues.filter(c => c.start <= t && t <= c.end && c.text.trim());
  for (const c of active) {
    const s = document.createElement("span");
    s.style.fontSize = (shortSide * CAPTION_FONT_PCT / 100) + "px";
    s.textContent = c.text;
    band.appendChild(s);
    band.appendChild(document.createElement("br"));
  }

  // チャット枠（焼き付けと同じ配置。新しいものが上）
  const o = chatOv();
  const box = $("chatbox");
  box.style.display = o.enabled ? "block" : "none";
  box.style.left = o.x_pct + "%"; box.style.top = o.y_pct + "%"; box.style.width = o.w_pct + "%";
  box.textContent = "";
  const vis = visibleChat(t);
  if (!vis.length) {
    // この時刻に出るコメントが無い。位置だけ分かるよう薄い目印を出す（動画には入らない）
    const ph = document.createElement("div");
    ph.className = "ph";
    ph.textContent = draft.chat.messages.length ? "コメント表示位置（この時刻は無し）" : "コメント表示位置（この範囲にコメント無し）";
    box.appendChild(ph);
  }
  for (const m of vis) {
    const d = document.createElement("div");
    d.className = "cm";
    d.style.fontSize = (shortSide * o.font_pct / 100) + "px";
    if (m.amount) { const s = document.createElement("span"); s.className = "amt"; s.textContent = `${m.amount} `; d.appendChild(s); }
    d.appendChild(document.createTextNode(m.text));
    box.appendChild(d);
  }
}

// 再生: スライダーを実時間で進める（コマは静止画の切替だが字幕・チャット・マスクの出入りは実時間どおり）
let playing = null;   // {t0: performance.now(), s0: 開始スライダー値}
function setPlaying(on) {
  if (on) {
    const dur = draft.clip.end_sec - draft.clip.start_sec;
    if (Number($("pvtime").value) >= dur - 0.05) $("pvtime").value = 0;   // 末尾で押したら頭から
    playing = { t0: performance.now(), s0: Number($("pvtime").value) };
    $("play").textContent = "⏸";
    requestAnimationFrame(tick);
  } else {
    playing = null;
    $("play").textContent = "▶";
  }
}
function tick(now) {
  if (!playing) return;
  const dur = draft.clip.end_sec - draft.clip.start_sec;
  const t = playing.s0 + (now - playing.t0) / 1000;
  if (t >= dur) { $("pvtime").value = dur; renderPreview(); setPlaying(false); return; }
  $("pvtime").value = t.toFixed(1);
  renderPreview();
  requestAnimationFrame(tick);
}

// ---- 元画面上の操作: マスクをドラッグで追加／縦のときは黄色い枠をドラッグで移動 ----
function setupDrawing() {
  const ov = $("overlay"), cb = $("cropbox");
  let p0 = null, tmp = null, cropDrag = null;
  const toVideo = ev => {
    const r = ov.getBoundingClientRect();
    return { x: Math.round((ev.clientX - r.left) / r.width * VIDEO_W),
             y: Math.round((ev.clientY - r.top) / r.height * VIDEO_H) };
  };
  cb.addEventListener("mousedown", ev => {
    if (!isPortrait()) return;
    cropDrag = { x0: toVideo(ev).x, cx0: frame().crop.x };
    ev.stopPropagation(); ev.preventDefault();
  });
  window.addEventListener("mousemove", ev => {
    if (!cropDrag) return;
    const c = frame().crop;
    c.x = Math.max(0, Math.min(VIDEO_W - c.w, Math.round(cropDrag.cx0 + toVideo(ev).x - cropDrag.x0)));
    cb.style.left = (c.x / VIDEO_W * 100) + "%";
    renderPreview();
  });
  window.addEventListener("mouseup", () => { if (cropDrag) { cropDrag = null; persist(); } });

  ov.addEventListener("mousedown", ev => {
    p0 = toVideo(ev);
    tmp = document.createElement("div");
    tmp.className = "maskbox";
    ov.insertBefore(tmp, cb);
    ev.preventDefault();
  });
  ov.addEventListener("mousemove", ev => {
    if (!p0 || !tmp) return;
    const p = toVideo(ev);
    const x = Math.min(p0.x, p.x), y = Math.min(p0.y, p.y);
    const w = Math.abs(p.x - p0.x), h = Math.abs(p.y - p0.y);
    tmp.style.left = (x / VIDEO_W * 100) + "%";
    tmp.style.top = (y / VIDEO_H * 100) + "%";
    tmp.style.width = (w / VIDEO_W * 100) + "%";
    tmp.style.height = (h / VIDEO_H * 100) + "%";
  });
  ov.addEventListener("mouseup", ev => {
    if (!p0 || !tmp) return;
    const p = toVideo(ev);
    const x = Math.min(p0.x, p.x), y = Math.min(p0.y, p.y);
    const w = Math.abs(p.x - p0.x), h = Math.abs(p.y - p0.y);
    tmp.remove(); tmp = null; p0 = null;
    if (w < 2 && h < 2) return;   // ただのクリックは何もしない（エラーを出すと煩い）
    if (w < 4 || h < 4) { showError("四角が小さすぎます（もう少し大きくドラッグしてください）"); return; }
    draft.clip.masks.push({ x, y, w, h, start: 0, end: null });
    showOk("");
    renderMasks(); renderPreview(); persist();
  });

  // 出力プレビュー上のチャット枠をドラッグで移動（座標は出力に対する %）
  const box = $("chatbox"), out = $("out");
  let boxDrag = null;
  box.addEventListener("mousedown", ev => {
    const r = out.getBoundingClientRect();
    boxDrag = { px: ev.clientX, py: ev.clientY, x0: chatOv().x_pct, y0: chatOv().y_pct, w: r.width, h: r.height };
    ev.preventDefault();
  });
  window.addEventListener("mousemove", ev => {
    if (!boxDrag) return;
    const o = chatOv();
    o.x_pct = Math.max(0, Math.min(100 - o.w_pct, Math.round(boxDrag.x0 + (ev.clientX - boxDrag.px) / boxDrag.w * 100)));
    o.y_pct = Math.max(0, Math.min(95, Math.round(boxDrag.y0 + (ev.clientY - boxDrag.py) / boxDrag.h * 100)));
    renderPreview();
  });
  window.addEventListener("mouseup", () => { if (boxDrag) { boxDrag = null; persist(); } });
}

// ---- 動画を作る前の検証 ----
function validate() {
  let r;
  try { r = range.read(); } catch (e) { return String(e); }
  if (Math.abs(r.start - draft.clip.start_sec) > 0.5 || Math.abs(r.end - draft.clip.end_sec) > 0.5) {
    return "範囲を変えた後は ①の「🔄 この範囲で吸い出し直す」を押してから動画を作ってください（字幕・チャットが古い範囲のままです）";
  }
  for (let i = 0; i < draft.captions.cues.length; i++) {
    const c = draft.captions.cues[i];
    if (!c.text.trim()) return `字幕 ${i + 1} 行目が空です（不要なら削除ボタンで消してください）`;
    if (c.end <= c.start || c.start < 0) return `字幕 ${i + 1} 行目の時刻が不正です（開始 ${c.start} → 終了 ${c.end}）`;
  }
  for (let i = 0; i < draft.clip.masks.length; i++) {
    const m = draft.clip.masks[i];
    if (m.w <= 0 || m.h <= 0 || m.x < 0 || m.y < 0) return `四角 ${i + 1} 個目の座標が不正です`;
    if (m.end !== null && m.end !== undefined && m.end <= m.start) return `四角 ${i + 1} 個目の表示終了は表示開始より後にしてください`;
  }
  if (isPortrait()) {
    const c = frame().crop;
    if (c.x < 0 || c.x + c.w > VIDEO_W || c.w <= 0 || c.h <= 0) return "縦の切り出し枠が画面からはみ出しています";
  }
  return null;   // チャットは表示専用なので検査対象外（吸い出したままを保存する）
}

function renderAll() {
  $("clipinfo").textContent = `${draft.clip.title}（${draft.clip.video_id}）` +
    (draft.captions.error ? ` — 字幕: 取得失敗（③参照）` : ` — 字幕 ${draft.captions.cues.length} 行`) +
    (draft.chat.error ? ` / チャット: 取得失敗（③参照）` : ` / チャット ${draft.chat.messages.length} 件`);
  range.set(draft.clip.start_sec, draft.clip.end_sec);
  document.querySelector(`input[name=mode][value=${frame().mode}]`).checked = true;
  renderChatOpts();
  renderMasks(); renderCues(); renderChat(); renderLayout();
}

async function init() {
  $("edver").textContent = "v" + chrome.runtime.getManifest().version;
  const { draft: d } = await chrome.storage.local.get("draft");
  if (!d) {
    showError("編集データがありません。YouTube のタブで「吸い出して編集画面を開く」からやり直してください。");
    $("save").disabled = true;
    return;
  }
  if (!d.chat) {
    // 旧形式（comments）の draft は列構成が違うので黙って変換しない（P-03）
    showError("古い形式の編集データです。YouTube のタブで「吸い出して編集画面を開く」からやり直してください。");
    $("save").disabled = true;
    return;
  }
  draft = d;
  range = setupRangeControl($("start_sec"), $("end_sec"), $("len_sec"), showRange);
  renderAll();
  setupDrawing();
  bindChatOpts();

  $("nowstart").addEventListener("click", () => nowInto("start"));
  $("nowend").addEventListener("click", () => nowInto("end"));
  $("recap").addEventListener("click", recapture);
  $("pvtime").addEventListener("input", () => { if (playing) setPlaying(false); renderPreview(); });
  $("play").addEventListener("click", () => setPlaying(!playing));
  document.addEventListener("keydown", ev => {
    if (ev.code === "Space" && !/^(INPUT|TEXTAREA|BUTTON)$/.test(document.activeElement.tagName)) { ev.preventDefault(); setPlaying(!playing); }
  });
  document.querySelectorAll("input[name=mode]").forEach(el => el.addEventListener("change", () => setMode(el.value)));
  window.addEventListener("resize", renderPreview);

  $("addcue").addEventListener("click", () => {
    const last = draft.captions.cues[draft.captions.cues.length - 1];
    draft.captions.cues.push({ start: last ? last.end : 0, end: (last ? last.end : 0) + 2, text: "" });
    renderCues(); renderPreview();
  });

  $("save").addEventListener("click", makeVideo);
}

const CHUNK_BYTES = 4 * 1024 * 1024;   // 1 メッセージで運ぶ録画データの大きさ（base64 で約 5.4MB。メッセージ上限 64MB に対して十分小さい）

// YouTube タブが持っている録画データを分割で受け取り、拡張のダウンロード機能で ダウンロード/clip-maker/ に保存する。
async function saveRecording(tabId, r) {
  const parts = [];
  for (let off = 0; off < r.size; off += CHUNK_BYTES) {
    const c = assertVer(await messageWithInject(tabId, { type: "CLIP_GET_CHUNK", id: r.id, offset: off, length: CHUNK_BYTES }));
    const bin = atob(c.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    parts.push(u8);
  }
  const blob = new Blob(parts, { type: r.mime });
  if (blob.size !== r.size) throw `録画データの受け渡しでサイズが合いません（${blob.size} / ${r.size}）`;
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: "clip-maker/" + r.file, saveAs: false, conflictAction: "uniquify" });
    // 完了まで待つ（完了前に URL を破棄すると保存が途中で切れる）
    for (let i = 0; i < 300; i++) {
      const [it] = await chrome.downloads.search({ id });
      if (it && it.state === "complete") { r.file = it.filename.split(/[\\/]/).pop(); return; }
      if (it && it.state === "interrupted") throw `保存に失敗しました（${it.error || "原因不明"}）`;
      await new Promise(res => setTimeout(res, 200));
    }
    throw "保存が時間内に終わりませんでした";
  } finally {
    URL.revokeObjectURL(url);
    messageWithInject(tabId, { type: "CLIP_RELEASE", id: r.id }).catch(() => {});
  }
}

// ④ 動画を作る: YouTube タブを前面に出して実時間で録画し、終わったら編集画面に戻る（拡張だけで完結）。
// 録画中は YouTube タブが見えている必要がある（隠れたタブは描画が止まり、映像が固まるため）。
async function makeVideo() {
  const err = validate();
  if (err) { showError(err); return; }
  const btn = $("save");
  const { savedCrop, ...fr } = frame();   // savedCrop は編集画面の都合（横に戻したとき枠位置を覚える）なので渡さない
  const clip = { ...draft.clip, frame: fr };
  const sec = clip.end_sec - clip.start_sec;
  let tab, me;
  try { tab = await ytTab(); me = await chrome.tabs.getCurrent(); } catch (e) { showError(String(e)); return; }
  btn.disabled = true;
  await persist();
  const m = $("msg"); m.className = "busy";
  m.textContent = `録画中…（約 ${Math.ceil(sec) + 3} 秒）YouTube のタブが前に出ます。終わるまでタブを切り替えず、そのまま待ってください。`;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    const r = assertVer(await messageWithInject(tab.id, { type: "CLIP_RENDER", clip, cues: draft.captions.cues, chat: draft.chat.messages }));
    if (me) await chrome.tabs.update(me.id, { active: true });   // 録画は終わったので編集画面に戻す
    m.textContent = "録画できました。保存中…";
    await saveRecording(tab.id, r);
    showOk(`動画ができました → ダウンロード/clip-maker/${r.file}（${r.sec} 秒・${r.mb} MB・${isPortrait() ? "縦 1080×1920" : "横 1920×1080"}）` +
           (r.ext === "webm" ? "\nこのブラウザは mp4 で録画できないため webm 形式になっています。" : ""));
  } catch (e) {
    showError(String(e));
  } finally {
    btn.disabled = false;
    if (me) { try { await chrome.tabs.update(me.id, { active: true }); } catch (_) { /* 編集タブが閉じられていた */ } }
  }
}

init();
