// 編集画面。パネルが storage に置いた下書き（draft）を読み、時間の取り直し・見た目の調整・録画の指示をする。
// プレビューは common.js の drawClipFrame で描く（録画と同じ関数なので、見たままが動画になる）。
// 隠す四角は元動画の座標（1920×1080 基準）で持つ。縦で動画の大きさ・位置を変えると四角も動画と一緒に動く。

let draft = null;
let range = null;
let frameImgs = [];     // [{t, img}] プレビュー用コマ画像
let selMask = -1;       // 選択中の四角（-1 = なし）
const $ = id => document.getElementById(id);

function say(id, text, cls) { const m = $(id); m.className = "msg " + (cls || "bad"); m.textContent = text; }
const persist = () => chrome.storage.local.set({ draft });
const clipDur = () => draft.clip.end_sec - draft.clip.start_sec;

// ---- YouTube タブとの通信 ----

// 下書きの動画を開いている YouTube タブを探す。無ければメッセージ文字列を throw。
async function ytTab() {
  const tabs = await chrome.tabs.query({ url: "*://www.youtube.com/*" });
  const tab = tabs.find(t => (t.url || "").includes(draft.clip.video_id));
  if (!tab) throw `この動画を開いている YouTube タブが見つかりません。\n${draft.clip.url} を開いてから、もう一度押してください。`;
  return tab;
}
async function sendToTab(req) {
  const tab = await ytTab();
  return assertVer(await messageWithInject(tab.id, req));
}

// ---- ① 時間 ----

function rangeChanged() {
  let r;
  try { r = range.read(); } catch (e) { say("capmsg", String(e)); return; }
  const stale = Math.abs(r.start - draft.clip.start_sec) > 0.05 || Math.abs(r.end - draft.clip.end_sec) > 0.05;
  say("capmsg", stale ? "時間を変えました。「この時間で取り直す」を押してください。" : "", stale ? "bad" : "ok");
}

// 今の時間で字幕・コメント・プレビュー画像を取り直す。四角や見た目の設定は引き継ぐ。
async function recapture() {
  if (playing) await setPlaying(false);
  let r0;
  try { r0 = range.read(); } catch (e) { say("capmsg", String(e)); return; }
  say("capmsg", "取り直し中…（動画が少し動きます）", "busy");
  $("recap").disabled = true;
  try {
    const r = await sendToTab({ type: "CLIP_CAPTURE", start: r0.start, end: r0.end, withFrames: true });
    const oldS = draft.clip.start_sec, oldE = draft.clip.end_sec, newS = r.clip.start_sec, newE = r.clip.end_sec;
    const shift = oldS - newS, newDur = newE - newS;
    // 今ある字幕・コメントは時間をずらして残す（直した内容を消さない）。新しい時間の外に出たものは落とす
    const keptCues = draft.captions.cues.map(c => ({ ...c, start: +(c.start + shift).toFixed(3), end: +(c.end + shift).toFixed(3) }))
      .filter(c => c.end > 0 && c.start < newDur).map(c => ({ ...c, start: Math.max(0, c.start), end: Math.min(newDur, c.end) }));
    const keptChat = draft.chat.messages.map(m => ({ ...m, t: +(m.t + shift).toFixed(2) })).filter(m => m.t >= 0 && m.t <= newDur);
    // 増えた区間（前に広げたぶん・後ろに広げたぶん）には、新しく取った字幕・コメントを入れる
    const parts = [];
    if (oldS - newS > 0.05) parts.push([0, oldS - newS]);
    if (newE - oldE > 0.05) parts.push([oldE - newS, newDur]);
    const inParts = t => parts.some(([a, b]) => t >= a - 0.01 && t <= b + 0.01);
    const freshCues = r.captions.cues.filter(c => inParts((c.start + c.end) / 2));
    const freshChat = r.chat.messages.filter(m => inParts(m.t));
    draft.clip = { ...draft.clip, ...r.clip };
    draft.captions = { ...draft.captions, cues: [...keptCues, ...freshCues].sort((a, b) => a.start - b.start) };
    if (draft.captions.error && r.captions.error) draft.captions.error = r.captions.error; else delete draft.captions.error;
    draft.chat = { messages: [...keptChat, ...freshChat].sort((a, b) => a.t - b.t) };
    if (r.chat.error && !keptChat.length) draft.chat.error = r.chat.error; else delete draft.chat.error;
    draft.frames = r.frames;
    draft.needFrames = false;
    // 音声認識で作った字幕なら、増えた区間だけ認識して足す（全部作り直さない）
    if ((draft.subsrc === "asr" || draft.captions.source === "asr") && parts.length) {
      const me = await chrome.tabs.getCurrent(), tab = await ytTab();
      say("capmsg", `増えた時間の音声を取り込み中…（${Math.ceil(newDur)} 秒）`, "busy");
      await chrome.tabs.update(tab.id, { active: true });
      try {
        const a = assertVer(await messageWithInject(tab.id, { type: "CLIP_CAPTURE_AUDIO", video_id: draft.clip.video_id, start: newS, end: newE }));
        draft.audio = { rate: a.rate, pcm16: a.pcm16, sec: a.sec };
      } finally { if (me) await chrome.tabs.update(me.id, { active: true }); }
      await persist();
      await loadFrames();
      renderAll();
      await recognizeParts(parts.filter(([a, b]) => !freshCues.some(c => c.start >= a && c.end <= b)));
    } else {
      await persist();
      await loadFrames();
      renderAll();
    }
    say("capmsg", shift || parts.length ? "取り直しました。今までの字幕・コメントは時間をずらして残し、増えた時間ぶんを足しました。" : "取り直しました。", "ok");
  } catch (e) { say("capmsg", String(e)); }
  finally { $("recap").disabled = false; }
}

async function nowInto(which) {
  try {
    const r = await sendToTab({ type: "CLIP_GET_TIME" });
    if (which === "start") range.setStart(r.t); else range.setEnd(r.t);
  } catch (e) { say("capmsg", String(e)); }
}

// ---- 設定（画面の形・字幕・コメント） ----

// スライダー 1 本を設定値に結ぶ。fmt は右に出す値の表示
function bindSlider(id, get, set, fmt) {
  const el = $(id), out = $(id + "v");
  const show = () => { el.value = get(); out.textContent = fmt(Number(el.value)); };
  el.addEventListener("input", () => { set(Number(el.value)); out.textContent = fmt(Number(el.value)); draw(); layoutMasks(); });
  el.addEventListener("change", persist);
  return show;
}
const sliders = [];

function setupOptions() {
  const c = () => draft.clip;
  sliders.push(
    bindSlider("cap_bottom", () => 100 - c().caption.bottom_pct, v => { c().caption.bottom_pct = 100 - v; }, v => v >= 85 ? "下" : v <= 15 ? "上" : "中"),
    bindSlider("cap_font", () => c().caption.font_pct, v => { c().caption.font_pct = v; }, v => v.toFixed(1)),
    bindSlider("chat_opacity", () => c().chat_overlay.opacity, v => { c().chat_overlay.opacity = v; }, v => `${Math.round(v * 100)}%`),
    bindSlider("chat_font", () => c().chat_overlay.font_pct, v => { c().chat_overlay.font_pct = v; }, v => v.toFixed(1)),
    bindSlider("chat_top", () => c().chat_overlay.top_pct, v => { c().chat_overlay.top_pct = v; }, v => `上から ${v}%`),
    bindSlider("chat_lanes", () => c().chat_overlay.lanes, v => { c().chat_overlay.lanes = v; }, v => `${v} 行`),
    bindSlider("chat_cross", () => c().chat_overlay.cross_sec, v => { c().chat_overlay.cross_sec = v; }, v => `${v} 秒`),
    bindSlider("pop_font", () => c().chat_popup.font_pct, v => { c().chat_popup.font_pct = v; }, v => v.toFixed(1)),
    bindSlider("pop_sec", () => c().chat_popup.sec, v => { c().chat_popup.sec = v; }, v => `${v} 秒`),
    bindSlider("pop_width", () => c().chat_popup.width_pct, v => { c().chat_popup.width_pct = v; }, v => `${v}%`),
  );
  document.querySelectorAll("input[name=mode]").forEach(el => el.addEventListener("change", () => {
    // 縦の設定（囲み枠・上下の位置）は横に切り替えても覚えておく
    const old = draft.clip.frame;
    if (el.value === "portrait") draft.clip.frame = { ...defaultFrame("portrait"), ...(draft.portraitKeep || {}), mode: "portrait" };
    else { if (old.mode === "portrait") draft.portraitKeep = { crop: old.crop, valign: old.valign }; draft.clip.frame = { mode: "landscape" }; }
    selMask = -1;
    persist(); renderOptions(); resizeCanvas(); layoutCrop(); draw(); layoutMasks();
  }));
  document.querySelectorAll("input[name=valign]").forEach(el => el.addEventListener("change", () => {
    const f = draft.clip.frame;
    f.valign = el.value;
    f.crop = alignCrop(f.crop, f.valign);   // 選んだ合わせ方の位置へ枠を動かす（自由はそのまま）
    persist(); layoutCrop(); draw(); layoutMasks();
  }));
  document.querySelectorAll("input[name=audio]").forEach(el => el.addEventListener("change", () => {
    draft.clip.audio = el.value === "on"; persist(); renderOptions();
  }));
  document.querySelectorAll("input[name=poppos]").forEach(el => el.addEventListener("change", () => {
    draft.clip.chat_popup.pos = el.value; persist(); draw();
  }));
  document.querySelectorAll("input[name=quality]").forEach(el => el.addEventListener("change", () => {
    draft.clip.quality = el.value; chrome.storage.local.set({ quality: el.value }); persist(); renderOptions();
  }));
  $("chat_on").addEventListener("change", () => {
    draft.clip.chat_overlay.enabled = $("chat_on").checked; persist(); renderOptions(); draw();
  });
}

function renderOptions() {
  const f = draft.clip.frame, portrait = f.mode === "portrait";
  document.querySelector(`input[name=mode][value=${f.mode}]`).checked = true;
  $("portraitopts").classList.toggle("hidden", !portrait);
  $("srcwrap").classList.toggle("hidden", !portrait);
  if (portrait) document.querySelector(`input[name=valign][value=${f.valign}]`).checked = true;
  document.querySelector(`input[name=audio][value=${draft.clip.audio ? "on" : "off"}]`).checked = true;
  document.querySelector(`input[name=quality][value=${draft.clip.quality}]`).checked = true;
  renderSizeNote();
  document.querySelector(`input[name=poppos][value=${draft.clip.chat_popup.pos}]`).checked = true;
  $("chat_on").checked = !!draft.clip.chat_overlay.enabled;
  $("chatopts").classList.toggle("hidden", !draft.clip.chat_overlay.enabled);
  sliders.forEach(show => show());
}

// 出来上がりの大きさの目安（画質・音声・長さで変わる）
function renderSizeNote() {
  const mb = estimateMb(draft.clip), sec = clipDur();
  $("sizenote").textContent = `出来上がりの目安: 約 ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB（${sec.toFixed(0)} 秒）`;
}

// ---- プレビュー ----

function loadFrames() {
  const f = draft.frames;
  frameImgs = [];
  if (!f || f.error || !f.list || !f.list.length) return Promise.resolve();
  return Promise.all(f.list.map(fr => new Promise(resolve => {
    const img = new Image();
    img.onload = () => { frameImgs.push({ t: fr.t, img, url: fr.dataUrl }); resolve(); };
    img.onerror = () => resolve();   // 壊れたコマは飛ばす（他のコマで表示できる）
    img.src = fr.dataUrl;
  }))).then(() => frameImgs.sort((a, b) => a.t - b.t));
}

function nearestFrame(t) {
  let best = null;
  for (const f of frameImgs) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  return best;
}

function resizeCanvas() {
  normalizeClip(draft.clip);
  const { W, H } = outSize(draft.clip);
  const cv = $("pv");
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  $("stage").className = draft.clip.frame.mode === "portrait" ? "portrait" : "landscape";
}

const pvTime = () => Math.min(Number($("pvtime").value), clipDur());

function draw() {
  const t = pvTime();
  $("pvtime").max = clipDur().toFixed(1);
  $("pvtimedisp").textContent = `${t.toFixed(1)} / ${clipDur().toFixed(1)} 秒`;
  const fr = nearestFrame(t);
  const f = draft.frames;
  $("stagemsg").textContent = fr ? "" : ((f && f.error) ? f.error : "プレビュー画像がありません。") + "\n「この時間で取り直す」を押すと表示されます。";
  drawClipFrame($("pv").getContext("2d"), fr ? fr.img : null, draft.clip, draft.captions.cues, draft.chat.messages, t);
  const si = $("srcimg");
  if (fr && si.getAttribute("src") !== fr.url) si.src = fr.url;   // 縦のときに出す「元の動画」も同じコマにする
}

// 再生: YouTube のタブで同じ所を再生し（音声はそちらから鳴る）、その再生位置にプレビューの時刻を合わせる。
// 映像は 2 秒ごとのコマ送りだが、字幕・コメント・四角は音声と同じ時刻で出入りするので、音を聞きながら字幕を合わせられる。
// YouTube のタブが見つからないときだけ、音なしで時計どおりに進める。
const PV_POLL_MS = 200;        // YouTube タブの再生位置を聞く間隔
const PV_AHEAD_MAX = 0.35;     // 次の応答が来るまでに先へ進めてよい秒数（読み込み待ちの間に字幕だけ先走らないようにする）
let playing = null;            // {base: 最後に分かった時刻, at: それを知った時点, live: 音声つきか, frozen: 止まっているか, poll}

async function setPlaying(on) {
  if (!on) {
    if (!playing) return;
    const was = playing;
    playing = null;
    clearInterval(was.poll);
    $("play").textContent = "▶";
    if (was.live) sendToTab({ type: "CLIP_PAUSE" }).catch(() => {});
    return;
  }
  if (playing) return;
  if (pvTime() >= clipDur() - 0.05) $("pvtime").value = 0;   // 末尾で押したら頭から
  const s0 = Number($("pvtime").value);
  const me = playing = { base: s0, at: performance.now(), live: false, frozen: true, poll: null };
  $("play").textContent = "⏸";
  try {
    await sendToTab({ type: "CLIP_PLAY", t: draft.clip.start_sec + s0, end: draft.clip.end_sec });
    if (playing !== me) return;   // 待っている間に止められた
    me.live = true;
    me.poll = setInterval(() => pollTab(me), PV_POLL_MS);
    say("pvmsg", "", "ok");
  } catch (e) {
    if (playing !== me) return;
    me.frozen = false; me.at = performance.now();
    say("pvmsg", `音なしで再生しています。${String(e).split("\n")[0]}`);
  }
  requestAnimationFrame(tick);
}

async function pollTab(me) {
  let r;
  try { r = await sendToTab({ type: "CLIP_GET_TIME" }); } catch (_) { return; }
  if (playing !== me) return;
  const rel = r.t - draft.clip.start_sec;
  me.frozen = r.paused || Math.abs(rel - me.base) < 0.001;   // 一時停止中・読み込み待ちは時刻を進めない
  me.base = rel; me.at = performance.now();
  say("pvmsg", r.muted ? "YouTube の音量がミュートになっています。音を聞くには YouTube のタブでミュートを解除してください。" : "", r.muted ? "bad" : "ok");
  if (r.paused && (rel >= clipDur() - 0.15 || rel < -0.5)) { $("pvtime").value = Math.min(clipDur(), Math.max(0, rel)); draw(); setPlaying(false); }
  else if (r.paused && me.sawPlaying) setPlaying(false);       // YouTube のタブ側で止められた
  if (!r.paused) me.sawPlaying = true;
}

function tick(now) {
  if (!playing) return;
  const ahead = playing.frozen ? 0 : (now - playing.at) / 1000;
  const t = playing.base + (playing.live ? Math.min(ahead, PV_AHEAD_MAX) : ahead);
  if (t >= clipDur()) { $("pvtime").value = clipDur(); draw(); setPlaying(false); return; }
  $("pvtime").value = Math.max(0, t).toFixed(2);
  draw();
  requestAnimationFrame(tick);
}

// ---- 縦: 囲み枠（元の動画のどこを使うか） ----
// 枠は出来上がりと同じ形（9:16）で固定。「元の動画」の表示範囲は common.js の SRC_VIEW（動画の上下に広い余白がある）。

function layoutCrop() {
  if (draft.clip.frame.mode !== "portrait") return;
  const c = draft.clip.frame.crop, b = $("cropbox").style;
  b.left = ((c.x - SRC_VIEW.x) / SRC_VIEW.w * 100) + "%"; b.top = ((c.y - SRC_VIEW.y) / SRC_VIEW.h * 100) + "%";
  b.width = (c.w / SRC_VIEW.w * 100) + "%"; b.height = (c.h / SRC_VIEW.h * 100) + "%";
}

function setupCropEditing() {
  const st = $("srcstage");
  let drag = null;
  const toSrc = ev => {
    const r = st.getBoundingClientRect();
    return { x: SRC_VIEW.x + Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * SRC_VIEW.w,
             y: SRC_VIEW.y + Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) * SRC_VIEW.h };
  };
  // 上より・中央・下より を選んでいる間は、上下の位置はその合わせ方で決まる（大きさを変えても合ったまま）
  const apply = c => {
    const f = draft.clip.frame;
    f.crop = alignCrop(c, f.valign);
    layoutCrop(); draw(); layoutMasks();
  };
  // 固定する角 anchor と動かす角 p から 9:16 の枠を作る。表示範囲からはみ出さない大きさまで
  const fromCorners = (anchor, p) => {
    const left = p.x < anchor.x, up = p.y < anchor.y;
    const roomW = left ? anchor.x - SRC_VIEW.x : SRC_VIEW.x + SRC_VIEW.w - anchor.x;
    const roomH = up ? anchor.y - SRC_VIEW.y : SRC_VIEW.y + SRC_VIEW.h - anchor.y;
    const want = Math.max(Math.abs(p.x - anchor.x), Math.abs(p.y - anchor.y) / CROP_RATIO);
    const w = Math.max(CROP_MIN_W, Math.min(want, roomW, roomH / CROP_RATIO));
    return { x: left ? anchor.x - w : anchor.x, y: up ? anchor.y - w * CROP_RATIO : anchor.y, w };
  };
  st.addEventListener("pointerdown", ev => {
    if (ev.button !== 0 || draft.clip.frame.mode !== "portrait") return;
    const p = toSrc(ev), c = draft.clip.frame.crop;
    if (ev.target.dataset.h) {
      const hh = ev.target.dataset.h;
      drag = { kind: "corner", anchor: { x: hh.includes("w") ? c.x + c.w : c.x, y: hh.includes("n") ? c.y + c.h : c.y } };
    } else if (ev.target.id === "cropbox") {
      drag = { kind: "move", dx: p.x - c.x, dy: p.y - c.y };
    } else {
      drag = { kind: "corner", anchor: p };   // 何も無い所からドラッグ: 新しく囲み直す
    }
    st.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  st.addEventListener("pointermove", ev => {
    if (!drag) return;
    const p = toSrc(ev), c = draft.clip.frame.crop;
    if (drag.kind === "move") apply({ x: p.x - drag.dx, y: p.y - drag.dy, w: c.w });
    else if (Math.abs(p.x - drag.anchor.x) > 8 || Math.abs(p.y - drag.anchor.y) > 8) apply(fromCorners(drag.anchor, p));
  });
  const finish = ev => {
    if (!drag) return;
    drag = null;
    try { st.releasePointerCapture(ev.pointerId); } catch (_) { /* 既に解放済み */ }
    persist();
  };
  st.addEventListener("pointerup", finish);
  st.addEventListener("pointercancel", finish);
}

// ---- 隠す四角 ----

const MIN_MASK_OUT = 12;   // これより小さい四角は作らない（出力の px。誤クリックで点のような四角ができるのを防ぐ）

// 四角の枠（掴む用の見た目）を今の設定に合わせて置き直す。黒塗り自体は canvas 側が描く
function layoutMasks() {
  const ov = $("ov");
  const { W, H } = outSize(draft.clip);
  ov.querySelectorAll(".mask:not(.tmp)").forEach(e => e.remove());
  draft.clip.masks.forEach((m, i) => {
    const r = srcToOut(draft.clip, m);
    const d = document.createElement("div");
    d.className = "mask" + (i === selMask ? " sel" : "");
    d.dataset.i = String(i);
    d.style.left = (r.x / W * 100) + "%"; d.style.top = (r.y / H * 100) + "%";
    d.style.width = (r.w / W * 100) + "%"; d.style.height = (r.h / H * 100) + "%";
    for (const h of ["nw", "ne", "sw", "se"]) { const e = document.createElement("div"); e.className = "h " + h; e.dataset.h = h; d.appendChild(e); }
    const x = document.createElement("button"); x.className = "x"; x.textContent = "×"; x.title = "この四角を消す"; x.dataset.del = "1";
    d.appendChild(x);
    ov.appendChild(d);
  });
  renderMaskList();
}

function renderMaskList() {
  const tb = $("masklist").querySelector("tbody");
  tb.textContent = "";
  $("masklist").classList.toggle("hidden", draft.clip.masks.length === 0);
  draft.clip.masks.forEach((m, i) => {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = `四角 ${i + 1}`;
    tr.appendChild(name);
    for (const key of ["start", "end"]) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "number"; inp.min = "0"; inp.step = "0.1";
      inp.value = m[key] === null || m[key] === undefined ? "" : m[key];
      inp.addEventListener("input", () => { m[key] = inp.value === "" ? (key === "end" ? null : 0) : Number(inp.value); draw(); });
      inp.addEventListener("change", persist);
      td.appendChild(inp);
      tr.appendChild(td);
    }
    const td = document.createElement("td");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "消す";
    del.addEventListener("click", () => removeMask(i));
    td.appendChild(del);
    tr.appendChild(td);
    tb.appendChild(tr);
  });
}

function removeMask(i) {
  draft.clip.masks.splice(i, 1);
  selMask = -1;
  persist(); layoutMasks(); draw();
}

// 画面の上の操作。ポインタを掴んだままにするので、枠の外へ出ても端で止まり、外で離しても確定する。
function setupMaskEditing() {
  const ov = $("ov");
  let drag = null;   // {kind: "new"|"move"|"resize", ...}
  // ポインタ位置 → 出力の px（枠の外は端に丸める）
  const toOut = ev => {
    const r = ov.getBoundingClientRect();
    const { W, H } = outSize(draft.clip);
    return { x: Math.min(W, Math.max(0, (ev.clientX - r.left) / r.width * W)),
             y: Math.min(H, Math.max(0, (ev.clientY - r.top) / r.height * H)) };
  };
  const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  const storeOut = (i, r) => {
    const s = outToSrc(draft.clip, r);
    Object.assign(draft.clip.masks[i], { x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h) });
  };

  ov.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    const el = ev.target.closest(".mask");
    if (ev.target.dataset.del) { removeMask(Number(el.dataset.i)); ev.preventDefault(); return; }
    const p = toOut(ev);
    const { W, H } = outSize(draft.clip);
    if (el) {
      const i = Number(el.dataset.i);
      const r = srcToOut(draft.clip, draft.clip.masks[i]);
      selMask = i;
      if (ev.target.dataset.h) {
        // 角を掴んだ: 反対側の角を固定して大きさを変える
        const h = ev.target.dataset.h;
        const anchor = { x: h.includes("w") ? r.x + r.w : r.x, y: h.includes("n") ? r.y + r.h : r.y };
        drag = { kind: "resize", i, anchor };
      } else {
        drag = { kind: "move", i, dx: p.x - r.x, dy: p.y - r.y, w: Math.min(r.w, W), h: Math.min(r.h, H) };
      }
      layoutMasks();
    } else {
      selMask = -1;
      layoutMasks();
      const tmp = document.createElement("div");
      tmp.className = "mask tmp";
      ov.appendChild(tmp);
      drag = { kind: "new", p0: p, tmp };
    }
    ov.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  ov.addEventListener("pointermove", ev => {
    if (!drag) return;
    const p = toOut(ev);
    const { W, H } = outSize(draft.clip);
    if (drag.kind === "new") {
      const r = rectOf(drag.p0, p);
      Object.assign(drag.tmp.style, { left: (r.x / W * 100) + "%", top: (r.y / H * 100) + "%", width: (r.w / W * 100) + "%", height: (r.h / H * 100) + "%" });
      return;
    }
    if (drag.kind === "move") {
      storeOut(drag.i, { x: Math.min(W - drag.w, Math.max(0, p.x - drag.dx)), y: Math.min(H - drag.h, Math.max(0, p.y - drag.dy)), w: drag.w, h: drag.h });
    } else {
      const r = rectOf(drag.anchor, p);
      if (r.w >= MIN_MASK_OUT && r.h >= MIN_MASK_OUT) storeOut(drag.i, r);
    }
    layoutMasks(); draw();
  });

  const finish = ev => {
    if (!drag) return;
    if (drag.kind === "new") {
      const r = rectOf(drag.p0, toOut(ev));
      drag.tmp.remove();
      if (r.w >= MIN_MASK_OUT && r.h >= MIN_MASK_OUT) {
        draft.clip.masks.push({ x: 0, y: 0, w: 0, h: 0, start: 0, end: null });
        selMask = draft.clip.masks.length - 1;
        storeOut(selMask, r);
      }
    }
    drag = null;
    try { ov.releasePointerCapture(ev.pointerId); } catch (_) { /* 既に解放済み */ }
    persist(); layoutMasks(); draw();
  };
  ov.addEventListener("pointerup", finish);
  ov.addEventListener("pointercancel", finish);

  document.addEventListener("keydown", ev => {
    if ((ev.key === "Delete" || ev.key === "Backspace") && selMask >= 0 && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      removeMask(selMask);
      ev.preventDefault();
    }
  });
}

// ---- ③ 字幕の文 ----

function renderCues() {
  say("cuesmsg", draft.captions.error ? `字幕を取得できていません: ${draft.captions.error}\n「この時間で取り直す」でもう一度取得できます。` :
    draft.captions.cues.length === 0 ? "この時間には字幕がありません。「字幕を追加」で入れられます。" : "");
  const tb = $("cues").querySelector("tbody");
  tb.textContent = "";
  draft.captions.cues.forEach((cue, i) => {
    const tr = document.createElement("tr");
    const tdPlay = document.createElement("td");
    const play = document.createElement("button");
    play.className = "playcue"; play.textContent = "▶"; play.title = "YouTube のタブでこの字幕の所を再生（音声の確認）";
    play.addEventListener("click", () => playCue(cue));
    tdPlay.appendChild(play);
    tr.appendChild(tdPlay);
    for (const key of ["start", "end"]) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "number"; inp.step = "0.1"; inp.min = "0"; inp.value = cue[key];
      inp.addEventListener("input", () => { cue[key] = Number(inp.value); draw(); });
      inp.addEventListener("change", persist);
      td.appendChild(inp);
      tr.appendChild(td);
    }
    const tdText = document.createElement("td");
    const text = document.createElement("input");
    text.type = "text"; text.value = cue.text;
    text.addEventListener("input", () => { cue.text = text.value; draw(); });
    text.addEventListener("change", persist);
    text.addEventListener("focus", () => { $("pvtime").value = Math.min(clipDur(), (cue.start + cue.end) / 2); draw(); });   // 直している字幕をプレビューに出す
    tdText.appendChild(text);
    tr.appendChild(tdText);
    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "消す";
    del.addEventListener("click", () => { draft.captions.cues.splice(i, 1); persist(); renderCues(); draw(); });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);
    tb.appendChild(tr);
  });
}

// 字幕行の ▶: その字幕の所だけ YouTube のタブで再生する（音声の確認）。プレビューもその字幕の頭に合わせる
async function playCue(cue) {
  if (playing) await setPlaying(false);
  $("pvtime").value = cue.start; draw();
  try { await sendToTab({ type: "CLIP_PLAY", t: draft.clip.start_sec + cue.start, end: draft.clip.start_sec + Math.max(cue.end, cue.start + 0.5) }); }
  catch (e) { say("cuesmsg", String(e)); }
}

// ---- コメント一覧（表示のみ） ----

// コメントは直せる（時刻・本文・削除・追加）。流れるコメントの配置は本文の長さで決まるので、直すたびにプレビューを描き直す
function renderChat() {
  say("chatmsg", draft.chat.error ? `コメントを取得できていません: ${draft.chat.error}` :
    draft.chat.messages.length === 0 ? "この時間にはコメントがありません。「コメントを追加」で入れられます。" : "");
  const tb = $("chat").querySelector("tbody");
  tb.textContent = "";
  draft.chat.messages.forEach((c, i) => {
    const tr = document.createElement("tr");
    const tdPlay = document.createElement("td");
    const jump = document.createElement("button");
    jump.className = "playcue"; jump.textContent = "▶"; jump.title = "プレビューをこのコメントが出る時刻にする";
    jump.addEventListener("click", () => { if (playing) setPlaying(false); $("pvtime").value = c.t; draw(); });
    tdPlay.appendChild(jump);
    tr.appendChild(tdPlay);
    const tdTime = document.createElement("td");
    const t = document.createElement("input");
    t.type = "number"; t.step = "0.1"; t.min = "0"; t.className = "ct"; t.value = c.t;
    t.addEventListener("input", () => { c.t = Number(t.value); draw(); });
    t.addEventListener("change", persist);
    tdTime.appendChild(t);
    tr.appendChild(tdTime);
    const tdT = document.createElement("td");
    if (c.amount) { const s = document.createElement("span"); s.className = "amt"; s.textContent = `${c.amount} `; tdT.appendChild(s); }
    const x = document.createElement("input");
    x.type = "text"; x.className = "cx"; x.value = c.text;
    x.addEventListener("input", () => { c.text = x.value; draw(); });
    x.addEventListener("change", persist);
    x.addEventListener("focus", () => { $("pvtime").value = Math.min(clipDur(), c.t + 1); draw(); });   // 直しているコメントが流れている所を見せる
    tdT.appendChild(x);
    tr.appendChild(tdT);
    // ポップアップ: 付けると流れずに、出る時刻から指定の秒数だけ白い枠で大きく出る
    const tdPop = document.createElement("td");
    tdPop.className = "pop";
    const pop = document.createElement("input");
    pop.type = "checkbox"; pop.checked = !!c.popup; pop.title = "このコメントをポップアップで出す";
    const ps = document.createElement("input");
    ps.type = "number"; ps.className = "ps"; ps.min = "0.5"; ps.step = "0.5"; ps.title = "出す秒数（空＝設定の秒数）";
    ps.value = c.popup_sec || ""; ps.placeholder = String(draft.clip.chat_popup.sec); ps.style.display = c.popup ? "" : "none";
    pop.addEventListener("change", () => { c.popup = pop.checked; if (!pop.checked) delete c.popup_sec; ps.style.display = pop.checked ? "" : "none"; persist(); $("pvtime").value = c.t; draw(); });
    ps.addEventListener("input", () => { const v = Number(ps.value); if (v > 0) c.popup_sec = v; else delete c.popup_sec; draw(); });
    ps.addEventListener("change", persist);
    tdPop.appendChild(pop); tdPop.appendChild(ps);
    tr.appendChild(tdPop);
    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "消す";
    del.addEventListener("click", () => { draft.chat.messages.splice(i, 1); persist(); renderChat(); draw(); });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);
    tb.appendChild(tr);
  });
}

// ---- 音声認識で字幕を作る ----
let asrRunning = false;

function asrProgress(show, pct, note) {
  $("asrprog").classList.toggle("hidden", !show);
  if (show) { $("asrfill").style.width = Math.max(0, Math.min(100, pct)) + "%"; $("asrnote").textContent = note || ""; }
}

async function runRecognition() {
  if (asrRunning) return;
  if (draft.captions.cues.length && draft.asrDone && !confirm("今の字幕はすべて置き換わります（直した文も消えます）。続けますか？")) return;
  if (playing) await setPlaying(false);
  asrRunning = true;
  $("asr").disabled = true;
  const model = (document.querySelector("input[name=asrmodel]:checked") || {}).value || ASR_DEFAULT_MODEL;
  try {
    if (!draft.audio) {
      // 音声がまだ無い（YouTube の字幕で取り込んだ下書き）: YouTube のタブで取り込む
      const tab = await ytTab();
      const me = await chrome.tabs.getCurrent();
      asrProgress(true, 0, `字幕用の音声を取り込み中…（${Math.ceil(clipDur())} 秒。YouTube のタブが前に出ます）`);
      await chrome.tabs.update(tab.id, { active: true });
      try {
        const a = assertVer(await messageWithInject(tab.id, { type: "CLIP_CAPTURE_AUDIO", video_id: draft.clip.video_id, start: draft.clip.start_sec, end: draft.clip.end_sec }));
        draft.audio = { rate: a.rate, pcm16: a.pcm16, sec: a.sec };
      } finally { if (me) await chrome.tabs.update(me.id, { active: true }); }
      await persist();
    }
    const device = await asrDevice();
    $("asrdev").textContent = device === "webgpu" ? "GPU で認識" : "CPU で認識（時間がかかります）";
    const r = await runAsr(draft.audio.pcm16, model, device, m => asrProgress(true, m.pct, m.note));
    const cues = asrToCues(r.chunks, clipDur(), pcm16ToFloat(draft.audio.pcm16), draft.audio.rate);
    if (!cues.length) throw new Error("この時間には話し声が見つかりませんでした（無音か音楽だけの区間）");
    draft.captions = { lang: "ja", cues, source: "asr", model };
    draft.asrDone = true;
    await persist();
    renderCues(); draw();
    asrProgress(true, 100, `認識しました（${cues.length} 行・${r.elapsed_s} 秒・${device === "webgpu" ? "GPU" : "CPU"}）`);
  } catch (e) {
    asrProgress(true, 0, "");
    say("cuesmsg", `音声認識に失敗しました: ${e && e.message ? e.message : e}`);
  } finally {
    asrRunning = false;
    $("asr").disabled = false;
  }
}

// 指定した区間（切り抜き開始からの秒）だけ音声認識して、字幕に足す
async function recognizeParts(parts) {
  if (!parts.length || !draft.audio) return;
  if (asrRunning) return;
  asrRunning = true;
  $("asr").disabled = true;
  const model = (document.querySelector("input[name=asrmodel]:checked") || {}).value || ASR_DEFAULT_MODEL;
  try {
    const device = await asrDevice();
    const audio = pcm16ToFloat(draft.audio.pcm16), rate = draft.audio.rate;
    const added = [];
    for (const [a, b] of parts) {
      const margin = 0.3, s0 = Math.max(0, a - margin), s1 = Math.min(clipDur(), b + margin);
      const slice = audio.slice(Math.floor(s0 * rate), Math.ceil(s1 * rate));
      if (slice.length < rate * 0.5) continue;
      asrProgress(true, 0, `増えた時間（${a.toFixed(1)}〜${b.toFixed(1)} 秒）を認識中…`);
      const r = await runAsrFloat(slice, model, device, m => asrProgress(true, m.pct, m.note));
      for (const c of asrToCues(r.chunks, s1 - s0, slice, rate)) {
        const cs = +(c.start + s0).toFixed(2), ce = +(c.end + s0).toFixed(2);
        if (ce <= a || cs >= b) continue;   // 余白ぶんに掛かっただけの行は入れない
        added.push({ start: Math.max(a, cs), end: Math.min(b, ce), text: c.text });
      }
    }
    draft.captions.cues = [...draft.captions.cues, ...added].sort((x, y) => x.start - y.start);
    draft.captions.source = "asr";
    await persist();
    renderCues(); draw();
    asrProgress(true, 100, added.length ? `増えた時間に ${added.length} 行を足しました` : "増えた時間には話し声が見つかりませんでした");
  } catch (e) {
    asrProgress(true, 0, "");
    say("cuesmsg", `音声認識に失敗しました: ${e && e.message ? e.message : e}`);
  } finally {
    asrRunning = false;
    $("asr").disabled = false;
  }
}

// ---- 設定ファイル ----

// 読み込んだ設定（コマ画像なし）に、YouTube のタブでコマ画像を撮って足す。タブが無ければ開く
async function fetchFramesForProject() {
  say("projmsg", "動画のコマ画像を撮っています…（YouTube のタブが前に出ます）", "busy");
  let tab;
  try { tab = await ytTab(); }
  catch (_) {
    tab = await chrome.tabs.create({ url: `${draft.clip.url}&t=${Math.floor(draft.clip.start_sec)}s` });
    for (let i = 0; i < 60; i++) {   // 動画が使えるようになるまで待つ
      await new Promise(r => setTimeout(r, 500));
      const r = await sendRawOrNull(tab.id);
      if (r && r.ready) break;
    }
  }
  const me = await chrome.tabs.getCurrent();
  await chrome.tabs.update(tab.id, { active: true });
  try {
    const r = assertVer(await messageWithInject(tab.id, { type: "CLIP_CAPTURE", start: draft.clip.start_sec, end: draft.clip.end_sec, withFrames: true, framesOnly: true }));
    draft.frames = r.frames;
    draft.clip.title = r.clip.title || draft.clip.title;
    draft.needFrames = false;
    await persist();
    await loadFrames();
    renderAll();
    say("projmsg", "読み込みました。", "ok");
  } catch (e) {
    say("projmsg", `コマ画像を撮れませんでした: ${e}`);
  } finally { if (me) await chrome.tabs.update(me.id, { active: true }); }
}
async function sendRawOrNull(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, { type: "CLIP_GET_TIME" }); } catch (_) { return null; }
}

async function loadProjectFile(file) {
  const p = JSON.parse(await file.text());
  const d = draftFromProject(p);
  await chrome.storage.local.set({ draft: d });
  location.reload();   // 下書きを入れ替えたので画面ごと開き直す（init が needFrames を見てコマ画像を撮る）
}

// ---- 動画を作る ----

function validate() {
  let r;
  try { r = range.read(); } catch (e) { return String(e); }
  if (Math.abs(r.start - draft.clip.start_sec) > 0.05 || Math.abs(r.end - draft.clip.end_sec) > 0.05) {
    return "時間を変えた後は「この時間で取り直す」を押してください。";
  }
  for (let i = 0; i < draft.captions.cues.length; i++) {
    const c = draft.captions.cues[i];
    if (!c.text.trim()) return `字幕 ${i + 1} 行目の文が空です（要らなければ「消す」で消してください）`;
    if (!(c.end > c.start) || c.start < 0) return `字幕 ${i + 1} 行目の時間がおかしいです（開始 ${c.start} → 終了 ${c.end}）`;
  }
  for (let i = 0; i < draft.clip.masks.length; i++) {
    const m = draft.clip.masks[i];
    if (m.end !== null && m.end !== undefined && m.end <= (m.start || 0)) return `四角 ${i + 1} の「消す時間」は「出す時間」より後にしてください`;
  }
  return null;
}

const CHUNK_BYTES = 4 * 1024 * 1024;   // 1 回で運ぶ録画データの大きさ（メッセージ上限 64MB に対して十分小さい）

// YouTube タブが持っている録画データを分割で受け取り、ダウンロード/clip-maker/ に保存する。
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
  if (blob.size !== r.size) throw `録画データの受け渡しで大きさが合いません（${blob.size} / ${r.size}）`;
  const url = URL.createObjectURL(blob);
  try {
    r.file = clipFileName(draft.clip, r.ext);
    const id = await chrome.downloads.download({ url, filename: "clip-maker/" + r.file, saveAs: false, conflictAction: "uniquify" });
    for (let i = 0; i < 300; i++) {   // 完了まで待つ（完了前に URL を破棄すると保存が途中で切れる）
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

// YouTube タブを前に出して録画し、終わったら編集画面に戻って保存する。
async function makeVideo() {
  const err = validate();
  if (err) { say("msg", err); return; }
  let tab, me;
  try { tab = await ytTab(); me = await chrome.tabs.getCurrent(); } catch (e) { say("msg", String(e)); return; }
  if (playing) await setPlaying(false);
  $("save").disabled = true;
  await persist();
  say("msg", "録画中…", "busy");
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    const r = assertVer(await messageWithInject(tab.id, { type: "CLIP_RENDER", clip: draft.clip, cues: draft.captions.cues, chat: draft.chat.messages }));
    if (me) await chrome.tabs.update(me.id, { active: true });
    say("msg", "保存中…", "busy");
    await saveRecording(tab.id, r);
    // 設定ファイルも一緒に保存する（後から読み込んで再編集できる）
    const pj = JSON.stringify(projectFromDraft(draft), null, 1);
    const pjName = r.file.replace(/\.(mp4|webm)$/, "") + ".clipmaker.json";
    try {
      await chrome.downloads.download({ url: "data:application/json;charset=utf-8," + encodeURIComponent(pj), filename: "clip-maker/" + pjName, saveAs: false, conflictAction: "uniquify" });
      r.project = pjName;
    } catch (e) { r.projectError = String(e); }
    const warn = (r.method !== "WebCodecs" ? `\n（この環境ではコマの間隔が揺れる方式で録画しました: ${r.why || ""}）` : "") +
                 (r.dropped ? `\n（処理が追いつかず ${r.dropped} コマ落ちました）` : "") +
                 (r.ext === "webm" ? "\n（このブラウザは mp4 で録画できないため webm 形式です）" : "");
    say("msg", `動画ができました。\nダウンロード ＞ clip-maker ＞ ${r.file}` + (r.project ? `\n設定ファイル: ${r.project}（読み込むと再編集できます）` : `\n設定ファイルを保存できませんでした: ${r.projectError || ""}`) + warn, warn ? "bad" : "ok");
  } catch (e) {
    say("msg", String(e));
  } finally {
    $("save").disabled = false;
    if (me) { try { await chrome.tabs.update(me.id, { active: true }); } catch (_) { /* 編集タブが閉じられていた */ } }
  }
}

// ---- 起動 ----

function renderAll() {
  $("clipinfo").textContent = draft.clip.title;
  range.set(draft.clip.start_sec, draft.clip.end_sec);
  say("capmsg", "", "ok");
  renderOptions();
  resizeCanvas();
  renderCues(); renderChat();
  layoutCrop();
  layoutMasks();
  draw();
}

async function init() {
  $("edver").textContent = "v" + BUILD;
  if (needsExtensionReload()) showReloadNotice(document.querySelector("main"), "更新するとこの編集画面は閉じます。YouTube のタブで Clip Maker を開き直してください（編集中の内容は残ります）。");
  const { draft: d } = await chrome.storage.local.get("draft");
  if (!d || !d.chat || !d.captions || !d.clip) {
    say("msg", "編集するデータがありません。YouTube のタブで Clip Maker を開き、「吸い出して編集画面を開く」からやり直してください。");
    $("save").disabled = true;
    return;
  }
  draft = d;
  normalizeClip(draft.clip);
  const { quality: savedQuality } = await chrome.storage.local.get("quality");   // 前回選んだ画質を引き継ぐ
  if (!d.qualitySet && QUALITY[savedQuality]) { draft.clip.quality = savedQuality; draft.qualitySet = true; }

  const startTI = createTimeInput($("start_sec"), () => range.onStartInput());
  const endTI = createTimeInput($("end_sec"), () => range.onEndInput());
  range = setupRangeControl(startTI, endTI, $("len_sec"), rangeChanged);

  setupOptions();
  setupMaskEditing();
  setupCropEditing();
  await loadFrames();
  renderAll();

  $("nowstart").addEventListener("click", () => nowInto("start"));
  $("nowend").addEventListener("click", () => nowInto("end"));
  $("recap").addEventListener("click", recapture);
  $("pvtime").addEventListener("input", () => { if (playing) setPlaying(false); draw(); });
  $("play").addEventListener("click", () => setPlaying(!playing));
  document.addEventListener("keydown", ev => {
    if (ev.code === "Space" && !/^(INPUT|TEXTAREA|BUTTON)$/.test(document.activeElement.tagName)) { ev.preventDefault(); setPlaying(!playing); }
  });
  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tabpane").forEach(p => p.classList.toggle("hidden", p.id !== "tab-" + b.dataset.tab));
  }));
  $("addchat").addEventListener("click", () => {
    const t = +pvTime().toFixed(1);
    draft.chat.messages.push({ t, author: "", text: "" });
    draft.chat.messages.sort((a, b) => a.t - b.t);
    persist(); renderChat(); draw();
    const row = [...$("chat").querySelectorAll("tbody tr")].find(tr => Number(tr.querySelector("input.ct").value) === t && tr.querySelector("input.cx").value === "");
    if (row) row.querySelector("input.cx").focus();
  });
  $("addcue").addEventListener("click", () => {
    // 今プレビューで見ている時刻に追加する。次の字幕があれば、その開始に合わせて終わる（間に挟むとき）
    const t = +pvTime().toFixed(1);
    const next = draft.captions.cues.filter(c => c.start > t + 0.2).sort((a, b) => a.start - b.start)[0];
    const end = next ? +next.start.toFixed(2) : +Math.min(clipDur(), t + 3).toFixed(1);
    draft.captions.cues.push({ start: t, end, text: "" });
    draft.captions.cues.sort((a, b) => a.start - b.start);
    persist(); renderCues(); draw();
    const row = [...$("cues").querySelectorAll("tbody tr")].find(tr => Number(tr.querySelectorAll("input[type=number]")[0].value) === t && tr.querySelector("input[type=text]").value === "");
    if (row) { row.scrollIntoView({ block: "nearest" }); row.querySelector("input[type=text]").focus(); }
  });
  $("save").addEventListener("click", makeVideo);
  $("asr").addEventListener("click", runRecognition);
  $("loadproj").addEventListener("change", async () => {
    const f = $("loadproj").files[0];
    if (!f) return;
    try { await loadProjectFile(f); } catch (e) { say("projmsg", String(e)); }
    $("loadproj").value = "";
  });
  if (draft.needFrames) fetchFramesForProject();
  const { asrModel } = await chrome.storage.local.get("asrModel");
  document.querySelector(`input[name=asrmodel][value=${ASR_MODELS[asrModel] ? asrModel : ASR_DEFAULT_MODEL}]`).checked = true;
  document.querySelectorAll("input[name=asrmodel]").forEach(el => el.addEventListener("change", () => chrome.storage.local.set({ asrModel: el.value })));
  asrDevice().then(d => { $("asrdev").textContent = d === "webgpu" ? "GPU で認識" : "CPU で認識（時間がかかります）"; });
  // パネルで「音声認識」を選んで取り込んだ下書きは、開いたときに認識を始める
  if (draft.subsrc === "asr" && draft.audio && !draft.asrDone) runRecognition();
  if (needsExtensionReload()) document.querySelectorAll("button").forEach(x => { if (!x.closest("#needreload")) x.disabled = true; });
}

init();
