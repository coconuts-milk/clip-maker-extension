// 編集画面（2 段階フローの ②③④⑤）。popup が storage に置いた draft を読み、
// YouTube タブと再通信して範囲の取り直し（吸い出し直し）もできる（2026-08-28 エイジ指示）。
//   ① 今の再生位置をワンボタンで開始に ② 開始・終了を変えたら字幕・チャットを吸い出し直す
//   ③ 字幕・チャットは必ず表示（取れないときは理由と再取得の案内） ④ 時刻スライダー付きプレビュー
// マスク座標は 1920×1080 基準（プロ版 render は height<=1080 で取得するため）。

const VIDEO_W = 1920, VIDEO_H = 1080;   // マスク座標の基準解像度
const CHAT_NOW_MAX = 8;                 // プレビュー横に出す「この時点までのチャット」の件数（画面に収まる実用数）

let draft = null;
const $ = id => document.getElementById(id);

function showError(text) { const m = $("msg"); m.className = ""; m.textContent = text; }
function showOk(text) { const m = $("msg"); m.className = "ok"; m.textContent = text; }
function capMsg(text, cls) { const m = $("capmsg"); m.className = cls || ""; m.textContent = text; }

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

// 範囲入力を検証して {start, end} を返す。不正はメッセージ文字列を throw。
function parseRange() {
  const start = parseTimeStr($("start_sec").value), end = parseTimeStr($("end_sec").value);
  if (start === null || start === undefined || end === null || end === undefined) {
    throw "開始・終了は「1:24:09」か「5049」（秒）の形式で入れてください";
  }
  if (end <= start) throw `終了(${fmtTime(end)}) は開始(${fmtTime(start)}) より後にしてください`;
  if (end - start > MAX_CLIP_SEC) throw `長さ ${(end - start).toFixed(1)} 秒が無料版の上限 ${MAX_CLIP_SEC} 秒を超えています`;
  return { start, end };
}

// 今の範囲で字幕・チャット・プレビューを取り直す。マスクは引き継ぐ（座標は範囲に依存しない）。
async function recapture() {
  let range;
  try { range = parseRange(); } catch (e) { capMsg(String(e)); return; }
  capMsg("吸い出し中…（数秒かかります。YouTube タブが一瞬シークします）", "busy");
  let r;
  try { r = await sendToTab({ type: "CLIP_CAPTURE", start: range.start, end: range.end, withFrames: true }); }
  catch (e) { capMsg(String(e)); return; }
  draft.clip = { ...r.clip, masks: draft.clip.masks };
  draft.captions = r.captions;
  draft.chat = r.chat;
  draft.frames = r.frames;
  await chrome.storage.local.set({ draft });
  renderAll();
  capMsg(`吸い出し直しました: ${fmtTime(r.clip.start_sec)} 〜 ${fmtTime(r.clip.end_sec)}` +
         (r.captions.error ? `\n字幕: ${r.captions.error}` : `／字幕 ${r.captions.cues.length} 行`) +
         (r.chat.error ? `\nチャット: ${r.chat.error}` : `／チャット ${r.chat.messages.length} 件`), "ok");
}

// 「▶ 今の再生位置を開始にする」: 開始＝今、終了＝今＋現在の長さ、でそのまま吸い出し直す（1 アクション）。
async function fromNow() {
  capMsg("再生位置を取得中…", "busy");
  let r;
  try { r = await sendToTab({ type: "CLIP_GET_TIME" }); } catch (e) { capMsg(String(e)); return; }
  const cur = parseRange0();
  const len = cur ? cur.end - cur.start : 15;
  $("start_sec").value = fmtTime(r.t);
  $("end_sec").value = fmtTime(r.t + len);
  updateLen();
  await recapture();
}

// parseRange の throw しない版（fromNow が現在の長さを引き継ぐためだけに使う）
function parseRange0() {
  try { return parseRange(); } catch (_) { return null; }
}

function updateLen() {
  const s = parseTimeStr($("start_sec").value), e = parseTimeStr($("end_sec").value);
  $("lenview").textContent = (Number.isFinite(s) && Number.isFinite(e) && e > s) ? `（長さ ${(e - s).toFixed(1)} 秒）` : "";
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
        renderOverlay();
      });
      td.appendChild(inp);
      tr.appendChild(td);
    }
    const td = document.createElement("td");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "削除";
    del.addEventListener("click", () => { draft.clip.masks.splice(i, 1); renderMasks(); });
    td.appendChild(del);
    tr.appendChild(td);
    tb.appendChild(tr);
  });
  renderOverlay();
}

function renderOverlay() {
  // プレビュー上の黒矩形（% 配置なので表示サイズに依存しない）
  const ov = $("overlay");
  ov.querySelectorAll(".maskbox").forEach(e => e.remove());
  for (const m of draft.clip.masks) {
    const d = document.createElement("div");
    d.className = "maskbox";
    d.style.left = (m.x / VIDEO_W * 100) + "%";
    d.style.top = (m.y / VIDEO_H * 100) + "%";
    d.style.width = (m.w / VIDEO_W * 100) + "%";
    d.style.height = (m.h / VIDEO_H * 100) + "%";
    ov.appendChild(d);
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
    // ▶: YouTube タブでこの字幕の音声位置を再生する（文字だけでは修正できない＝2026-08-28 エイジ指摘③）
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

// ---- チャット表（表示専用。チャットは編集しない＝2026-08-28 エイジ指摘③。author は chat.json には保存され続ける） ----

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

// ---- プレビュー（時刻スライダー + 最寄りコマ + 字幕帯 + その時点までのチャット） ----
// コマは吸い出し時に撮った実画像（iframe 埋め込みは拡張ページだとエラー 153 で拒否される）。

function renderPreview() {
  const dur = draft.clip.end_sec - draft.clip.start_sec;
  const slider = $("pvtime");
  slider.max = dur.toFixed(1);
  const t = Math.min(Number(slider.value), dur);
  $("pvtimedisp").textContent = `${fmtTime(draft.clip.start_sec + t)}（開始+${t.toFixed(1)}秒）`;

  // 最寄りコマ
  const f = draft.frames;
  const img = $("frame"), sm = $("stagemsg");
  if (!f || f.error || !f.list || !f.list.length) {
    sm.textContent = (f && f.error) ? `${f.error}\n→ ①の「🔄 この範囲で吸い出し直す」で撮り直せます。` :
      "プレビュー画像がありません。①の「🔄 この範囲で吸い出し直す」を押すと表示されます（四角の指定は座標入力でも可能）。";
    img.removeAttribute("src");
  } else {
    sm.textContent = "";
    let best = f.list[0];
    for (const fr of f.list) if (Math.abs(fr.t - t) < Math.abs(best.t - t)) best = fr;
    if (img.getAttribute("src") !== best.dataUrl) img.src = best.dataUrl;
  }

  // 字幕帯（焼き付けと同じ「その時刻に出ている字幕」）
  const band = $("cueband");
  band.textContent = "";
  const active = draft.captions.cues.filter(c => c.start <= t && t <= c.end && c.text.trim());
  for (const c of active) {
    const s = document.createElement("span");
    s.textContent = c.text;
    band.appendChild(s);
    band.appendChild(document.createElement("br"));
  }

  // この時点までのチャット（新しい順・直近 CHAT_NOW_MAX 件）
  const pane = $("chatnow");
  pane.textContent = "";
  const past = draft.chat.messages.filter(m => m.t <= t).sort((a, b) => b.t - a.t).slice(0, CHAT_NOW_MAX);
  if (!past.length) {
    const d = document.createElement("div");
    d.className = "note";
    d.textContent = draft.chat.error ? "チャット未取得（③の欄を参照）" : "この時点より前のチャットはまだ無い（スライダーを右へ）";
    pane.appendChild(d);
  }
  for (const m of past) {
    const d = document.createElement("div");
    d.className = "cm";
    const b = document.createElement("b");
    b.textContent = fmtTime(m.t);   // 投稿者は出さない（2026-08-28 エイジ指摘③: 投稿者不要）
    d.appendChild(b);
    if (m.amount) { const s = document.createElement("span"); s.className = "amt"; s.textContent = ` ${m.amount}`; d.appendChild(s); }
    d.appendChild(document.createTextNode(" " + m.text));
    pane.appendChild(d);
  }
}

// ---- 矩形の描画（プレビュー上をドラッグで追加・常時有効） ----
function setupDrawing() {
  const ov = $("overlay");
  let p0 = null, tmp = null;
  const toVideo = ev => {
    const r = ov.getBoundingClientRect();
    return { x: Math.round((ev.clientX - r.left) / r.width * VIDEO_W),
             y: Math.round((ev.clientY - r.top) / r.height * VIDEO_H) };
  };
  ov.addEventListener("mousedown", ev => {
    p0 = toVideo(ev);
    tmp = document.createElement("div");
    tmp.className = "maskbox";
    ov.appendChild(tmp);
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
    renderMasks();
  });
}

// ---- 保存（検証してから 3 ファイル） ----
function validate() {
  let range;
  try { range = parseRange(); } catch (e) { return String(e); }
  if (Math.abs(range.start - draft.clip.start_sec) > 0.5 || Math.abs(range.end - draft.clip.end_sec) > 0.5) {
    return "範囲を変えた後は ①の「🔄 この範囲で吸い出し直す」を押してから保存してください（字幕・チャットが古い範囲のままです）";
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
  return null;   // チャットは表示専用なので検査対象外（吸い出したままを保存する）
}

function renderAll() {
  $("clipinfo").textContent = `${draft.clip.title}（${draft.clip.video_id}）` +
    (draft.captions.error ? ` — 字幕: 取得失敗（③参照）` : ` — 字幕 ${draft.captions.cues.length} 行`) +
    (draft.chat.error ? ` / チャット: 取得失敗（③参照）` : ` / チャット ${draft.chat.messages.length} 件`);
  $("start_sec").value = fmtTime(draft.clip.start_sec);
  $("end_sec").value = fmtTime(draft.clip.end_sec);
  updateLen();
  renderMasks(); renderCues(); renderChat(); renderPreview();
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
  renderAll();
  setupDrawing();

  $("start_sec").addEventListener("input", updateLen);
  $("end_sec").addEventListener("input", updateLen);
  $("fromnow").addEventListener("click", fromNow);
  $("recap").addEventListener("click", recapture);
  $("pvtime").addEventListener("input", renderPreview);

  $("addcue").addEventListener("click", () => {
    const last = draft.captions.cues[draft.captions.cues.length - 1];
    draft.captions.cues.push({ start: last ? last.end : 0, end: (last ? last.end : 0) + 2, text: "" });
    renderCues(); renderPreview();
  });

  $("save").addEventListener("click", async () => {
    const err = validate();
    if (err) { showError(err); return; }
    const base = await saveClipFiles(draft.clip, draft.captions.cues, draft.chat.messages);
    await chrome.storage.local.set({ draft });   // 保存後もこのタブで編集を続けられるように最新化
    showOk(`保存しました → ダウンロード/clip-maker/${base}.*\n` +
           `自動焼き付けが動いていれば、約1分で同じフォルダに ${base}.mp4（切り抜き動画）が出ます。\n` +
           `動いていない場合は PC で clipmaker watch を起動（または clipmaker render で1本ずつ）。`);
  });
}

init();
