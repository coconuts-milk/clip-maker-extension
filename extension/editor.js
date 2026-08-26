// 編集画面（2 段階フローの ②③④⑤）。popup が storage に置いた draft を読み、
// 字幕・コメントの修正と矩形マスクの指定をして 3 ファイルに保存する。
// マスク座標は 1920×1080 基準（プロ版 render は height<=1080 で取得するため）。

const VIDEO_W = 1920, VIDEO_H = 1080;   // マスク座標の基準解像度

let draft = null;
const $ = id => document.getElementById(id);

function showError(text) { const m = $("msg"); m.className = ""; m.textContent = text; }
function showOk(text) { const m = $("msg"); m.className = "ok"; m.textContent = text; }

function renderMasks() {
  // 一覧表
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

function renderCues() {
  const tb = $("cues").querySelector("tbody");
  tb.textContent = "";
  draft.captions.cues.forEach((cue, i) => {
    const tr = document.createElement("tr");
    for (const key of ["start", "end"]) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "number"; inp.step = "0.001"; inp.value = cue[key];
      inp.addEventListener("input", () => { cue[key] = Number(inp.value); });
      td.appendChild(inp);
      tr.appendChild(td);
    }
    const tdText = document.createElement("td");
    const text = document.createElement("input");
    text.type = "text"; text.value = cue.text;
    text.addEventListener("input", () => { cue.text = text.value; });
    tdText.appendChild(text);
    tr.appendChild(tdText);
    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "削除";
    del.addEventListener("click", () => { draft.captions.cues.splice(i, 1); renderCues(); });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);
    tb.appendChild(tr);
  });
}

function renderComments() {
  const tb = $("comments").querySelector("tbody");
  tb.textContent = "";
  draft.comments.forEach((c, i) => {
    const tr = document.createElement("tr");
    const tdA = document.createElement("td");
    tdA.textContent = c.author || "";
    tr.appendChild(tdA);
    const tdT = document.createElement("td");
    const inp = document.createElement("input");
    inp.type = "text"; inp.value = c.text;
    inp.addEventListener("input", () => { c.text = inp.value; });
    tdT.appendChild(inp);
    tr.appendChild(tdT);
    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "削除";
    del.addEventListener("click", () => { draft.comments.splice(i, 1); renderComments(); });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);
    tb.appendChild(tr);
  });
}

// ---- プレビュー（吸い出し時に撮った実際のコマ 3 枚。iframe 埋め込みは拡張ページだとエラー 153 で拒否される） ----
function renderFrames() {
  const f = draft.frames;
  const img = $("frame"), sm = $("stagemsg"), bar = $("framebtns");
  if (!f || f.error || !f.list || !f.list.length) {
    sm.textContent = (f && f.error) ? f.error :
      "プレビュー画像がありません。YouTube のタブで「吸い出して編集画面を開く」からやり直すと表示されます（四角の指定は座標入力でも可能）。";
    bar.style.display = "none";
    return;
  }
  const labels = ["開始", "中間", "終了"];
  f.list.forEach((fr, i) => {
    const b = document.createElement("button");
    b.textContent = `${labels[i]} ${fmtTime(draft.clip.start_sec + fr.t)}`;
    b.addEventListener("click", () => {
      img.src = fr.dataUrl;
      bar.querySelectorAll("button").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
    });
    bar.appendChild(b);
    if (i === 0) { img.src = fr.dataUrl; b.classList.add("on"); }
  });
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
  const start = parseTimeStr($("start_sec").value), end = parseTimeStr($("end_sec").value);
  if (start === null || start === undefined || end === null || end === undefined) {
    return "開始・終了は「1:24:09」か「5049」（秒）の形式で入れてください";
  }
  if (end <= start) return `終了(${fmtTime(end)}) は開始(${fmtTime(start)}) より後にしてください`;
  if (end - start > MAX_CLIP_SEC) return `長さ ${(end - start).toFixed(1)} 秒が無料版の上限 ${MAX_CLIP_SEC} 秒を超えています`;
  draft.clip.start_sec = start; draft.clip.end_sec = end;
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
  for (let i = 0; i < draft.comments.length; i++) {
    if (!draft.comments[i].text.trim()) return `コメント ${i + 1} 行目が空です（不要なら削除ボタンで消してください）`;
  }
  return null;
}

async function init() {
  $("edver").textContent = "v" + chrome.runtime.getManifest().version;
  const { draft: d } = await chrome.storage.local.get("draft");
  if (!d) {
    showError("編集データがありません。YouTube のタブで「吸い出して編集画面を開く」からやり直してください。");
    $("save").disabled = true;
    return;
  }
  draft = d;
  $("clipinfo").textContent = `${d.clip.title}（${d.clip.video_id}）` +
    (d.captions.error ? ` — 字幕: ${d.captions.error}` : ` — 字幕 ${d.captions.cues.length} 行 / コメント ${d.comments.length} 件`);
  $("start_sec").value = fmtTime(d.clip.start_sec);
  $("end_sec").value = fmtTime(d.clip.end_sec);
  const updateLen = () => {
    const s = parseTimeStr($("start_sec").value), e = parseTimeStr($("end_sec").value);
    $("lenview").textContent = (Number.isFinite(s) && Number.isFinite(e) && e > s) ? `（長さ ${(e - s).toFixed(1)} 秒）` : "";
  };
  updateLen();
  $("start_sec").addEventListener("input", updateLen);
  $("end_sec").addEventListener("input", updateLen);
  renderFrames();
  renderMasks(); renderCues(); renderComments(); setupDrawing();

  $("addcue").addEventListener("click", () => {
    const last = draft.captions.cues[draft.captions.cues.length - 1];
    draft.captions.cues.push({ start: last ? last.end : 0, end: (last ? last.end : 0) + 2, text: "" });
    renderCues();
  });

  $("save").addEventListener("click", async () => {
    const err = validate();
    if (err) { showError(err); return; }
    const base = await saveClipFiles(draft.clip, draft.captions.cues, draft.comments);
    await chrome.storage.local.set({ draft });   // 保存後もこのタブで編集を続けられるように最新化
    showOk(`保存しました → ダウンロード/clip-maker/${base}.*\n` +
           `焼き付け: clipmaker render "ダウンロード/clip-maker/${base}.clip.json" を PC で実行（プロ版）`);
  });
}

init();
