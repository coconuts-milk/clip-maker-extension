// パネル / 編集画面 / content script で共有する定数・部品・描画（同じロジックを 2 箇所に持たない）。
// 描画（drawClipFrame）は編集画面のプレビューと録画の両方がこれを使うので、プレビューで見たものがそのまま動画になる。

const MAX_CLIP_SEC = 60;   // 切り抜きの上限（Shorts の上限に合わせる）
const DEFAULT_LEN_SEC = 30;

const VIDEO_W = 1920, VIDEO_H = 1080;        // 元動画の座標の基準（隠す四角はこの座標で持つ）
const PORTRAIT_W = 1080, PORTRAIT_H = 1920;  // 縦（Shorts 9:16）
const ZOOM_MIN = 0.5;                                   // 縦: 動画の幅を出力幅の半分まで縮小できる
const ZOOM_FILL = PORTRAIT_H / (PORTRAIT_W * VIDEO_H / VIDEO_W);   // 縦: 動画の高さが出力の高さいっぱいになる倍率（≒3.16）

// ---- 設定の既定値 ----
function defaultFrame(mode) {
  // zoom: 1 = 動画の幅が出力の幅ぴったり。pan: 左右位置（0=左端 50=中央 100=右端）。valign: 動画が無い領域（黒）を上下どちらに作るか
  if (mode === "portrait") return { mode, zoom: 1, pan: 50, valign: "center" };
  return { mode: "landscape" };
}
// コメント: 右から左に流す。top_pct/lanes = 流す帯の上端と行数。cross_sec = 画面を横切る秒数。
const DEFAULT_CHAT_OVERLAY = { enabled: true, style: "flow", opacity: 0.7, font_pct: 4.5, top_pct: 4, lanes: 4, cross_sec: 6 };
// 字幕: bottom_pct = 下端からの距離（出力の高さに対する %）
const DEFAULT_CAPTION = { font_pct: 6.9, bottom_pct: 7 };

// 古い下書き・欠けた項目を既定値で埋める
function normalizeClip(clip) {
  const f = clip.frame || {};
  clip.frame = f.mode === "portrait"
    ? { ...defaultFrame("portrait"), ...(Number.isFinite(f.zoom) ? { zoom: f.zoom } : {}), ...(Number.isFinite(f.pan) ? { pan: f.pan } : {}), ...(f.valign ? { valign: f.valign } : {}) }
    : { mode: "landscape" };
  const o = clip.chat_overlay || {};
  clip.chat_overlay = { ...DEFAULT_CHAT_OVERLAY, ...(typeof o.enabled === "boolean" ? { enabled: o.enabled } : {}) };
  for (const k of ["opacity", "font_pct", "top_pct", "lanes", "cross_sec"]) if (o.style === "flow" && Number.isFinite(o[k])) clip.chat_overlay[k] = o[k];
  clip.caption = { ...DEFAULT_CAPTION, ...(clip.caption || {}) };
  clip.masks = Array.isArray(clip.masks) ? clip.masks : [];
  return clip;
}

// ---- 時間 ----
// "5049" / "5049.5" / "1:24:09" / "24:09" を秒に変換。不正なら null、空なら undefined。
function parseTimeStr(raw) {
  const s = String(raw).trim();
  if (s === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  return (Number(m[1] || 0)) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// 秒 → {h, m, s, d}（d = 0.1 秒の桁）
function splitTime(sec) {
  const t = Math.max(0, Math.round(sec * 10));
  return { h: Math.floor(t / 36000), m: Math.floor(t / 600) % 60, s: Math.floor(t / 10) % 60, d: t % 10 };
}
const pad2 = n => String(n).padStart(2, "0");
// 秒 → "01:23:45.6"
function fmtTime(sec) {
  const p = splitTime(sec);
  return `${pad2(p.h)}:${pad2(p.m)}:${pad2(p.s)}.${p.d}`;
}

// 時間入力 □:□:□.□（時・分・秒・コンマ）。container に 4 つの枠を作る。
// 返り値: { get(): 秒 | null（未入力・不正）, set(秒), focus() }
function createTimeInput(container, onChange) {
  container.classList.add("timeinput");
  container.textContent = "";
  const defs = [["h", 2, "時"], ["m", 2, "分"], ["s", 2, "秒"], ["d", 1, "コンマ"]];
  const els = {};
  defs.forEach(([key, len, label], i) => {
    if (i > 0) { const sep = document.createElement("span"); sep.className = "tsep"; sep.textContent = i === 3 ? "." : ":"; container.appendChild(sep); }
    const el = document.createElement("input");
    el.type = "text"; el.inputMode = "numeric"; el.maxLength = len; el.className = "tbox t" + key;
    el.setAttribute("aria-label", label); el.title = label;
    container.appendChild(el);
    els[key] = el;
  });
  const order = defs.map(d => els[d[0]]);
  const read = () => {
    const v = {};
    for (const [key] of defs) {
      const raw = els[key].value.trim();
      if (raw !== "" && !/^\d+$/.test(raw)) return null;
      v[key] = raw === "" ? 0 : Number(raw);
    }
    if (order.every(el => el.value.trim() === "")) return null;
    return v.h * 3600 + v.m * 60 + v.s + v.d / 10;
  };
  const write = sec => {
    const p = splitTime(sec);
    els.h.value = pad2(p.h); els.m.value = pad2(p.m); els.s.value = pad2(p.s); els.d.value = String(p.d);
  };
  order.forEach((el, i) => {
    el.addEventListener("focus", () => el.select());
    el.addEventListener("input", () => {
      el.value = el.value.replace(/\D/g, "");
      if (el.value.length >= el.maxLength && order[i + 1]) order[i + 1].focus();   // 桁が埋まったら次の枠へ
      if (onChange) onChange();
    });
    el.addEventListener("keydown", ev => {
      if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        // ↑↓ でその桁を 1 ずつ増減（秒の枠なら 1 秒、コンマなら 0.1 秒）。繰り上がりは自動
        const cur = read();
        if (cur === null) return;
        const step = [3600, 60, 1, 0.1][i] * (ev.key === "ArrowUp" ? 1 : -1);
        write(Math.max(0, cur + step));
        el.select();
        ev.preventDefault();
        if (onChange) onChange();
      } else if (ev.key === "Backspace" && el.value === "" && order[i - 1]) {
        order[i - 1].focus();
      }
    });
    el.addEventListener("blur", () => {
      // 枠を離れたら 0 埋め・繰り上げ（秒に 75 と入れたら 1 分 15 秒）して表示を揃える
      const cur = read();
      if (cur !== null && !container.contains(document.activeElement)) write(cur);
    });
  });
  return { get: read, set: write, focus: () => els.s.focus() };
}

// ---- 開始・終了・長さの 3 つ連動 ----
// 長さを変えた → 終了 = 開始 + 長さ　　終了を変えた → 長さ = 終了 − 開始
// 開始を変えた → 長さ固定で終了をずらす（直前に終了を触っていたときだけ長さの方を計算し直す）
function setupRangeControl(startTI, endTI, lenEl, onChange) {
  let lastTouched = "len";
  const fromLen = () => { const s = startTI.get(), l = Number(lenEl.value); if (s !== null && l > 0) endTI.set(s + l); };
  const fromEnd = () => { const s = startTI.get(), e = endTI.get(); if (s !== null && e !== null && e > s) lenEl.value = String(Math.round((e - s) * 10) / 10); };
  const fire = () => { if (onChange) onChange(); };
  lenEl.addEventListener("input", () => { lastTouched = "len"; fromLen(); fire(); });
  return {
    onStartInput() { if (lastTouched === "end" && endTI.get() !== null) fromEnd(); else fromLen(); fire(); },
    onEndInput() { lastTouched = "end"; fromEnd(); fire(); },
    // 検証済みの {start, end, len} を返す。不正はメッセージ文字列を throw。
    read() {
      const s = startTI.get(), e = endTI.get();
      if (s === null) throw "開始の時間を入れてください（「今時間取得」で今の再生位置が入ります）";
      if (e === null) throw "終了の時間を入れてください（長さを入れると自動で入ります）";
      if (e <= s) throw "終了は開始より後にしてください";
      if (e - s > MAX_CLIP_SEC + 0.05) throw `長さ ${(e - s).toFixed(1)} 秒が上限の ${MAX_CLIP_SEC} 秒を超えています`;
      return { start: s, end: e, len: e - s };
    },
    setStart(t) { startTI.set(t); if (Number(lenEl.value) > 0) fromLen(); else fromEnd(); fire(); },
    setEnd(t) {
      endTI.set(t); lastTouched = "end";
      if (startTI.get() === null) startTI.set(Math.max(0, t - (Number(lenEl.value) || DEFAULT_LEN_SEC)));
      fromEnd(); fire();
    },
    set(start, end) { startTI.set(start); endTI.set(end); lastTouched = "len"; lenEl.value = String(Math.round((end - start) * 10) / 10); fire(); },
  };
}

// ---- 描画（プレビューと録画で共通） ----
const DRAW_FONT = "Meiryo, 'Yu Gothic', 'Hiragino Sans', sans-serif";
const CAPTION_OUTLINE_PCT = 0.7, CAPTION_MARGIN_H_PCT = 4, LINE_HEIGHT = 1.25;
const CHAT_OUTLINE_PCT = 0.3, CHAT_LANE_HEIGHT = 1.35, CHAT_GAP_EM = 1.0;   // 同じ行の前後のコメントの間隔（文字の大きさに対する比）

function outSize(clip) {
  return clip.frame && clip.frame.mode === "portrait" ? { W: PORTRAIT_W, H: PORTRAIT_H } : { W: VIDEO_W, H: VIDEO_H };
}

// 出力の中で動画を置く矩形 {x, y, w, h}（出力の px）。縦は倍率・左右位置・上下ぞろえで決まり、動画の無い所は黒。
function videoRect(clip) {
  const { W, H } = outSize(clip);
  const f = clip.frame || {};
  if (f.mode !== "portrait") return { x: 0, y: 0, w: W, h: H };
  const zoom = Math.min(ZOOM_FILL, Math.max(ZOOM_MIN, Number(f.zoom) || 1));
  const w = W * zoom, h = w * VIDEO_H / VIDEO_W;
  const x = w <= W ? (W - w) / 2 : -(w - W) * Math.min(100, Math.max(0, Number.isFinite(f.pan) ? f.pan : 50)) / 100;
  const y = f.valign === "top" ? 0 : f.valign === "bottom" ? H - h : (H - h) / 2;
  return { x, y, w, h };
}

// 元動画の座標（1920×1080 基準）→ 出力の座標
function srcToOut(clip, r) {
  const v = videoRect(clip), k = v.w / VIDEO_W;
  return { x: v.x + r.x * k, y: v.y + r.y * k, w: r.w * k, h: r.h * k };
}
function outToSrc(clip, r) {
  const v = videoRect(clip), k = v.w / VIDEO_W;
  return { x: (r.x - v.x) / k, y: (r.y - v.y) / k, w: r.w / k, h: r.h / k };
}

function wrapByWidth(ctx, text, maxW) {
  const out = [];
  for (const line of String(text).split("\n")) {
    let cur = "";
    for (const ch of line) {
      if (cur && ctx.measureText(cur + ch).width > maxW) {
        // 英単語の途中では切らない: 半角文字の連続の途中なら直前の空白まで戻る（日本語はどこでも折り返す）
        const sp = cur.lastIndexOf(" ");
        const midWord = ch !== " " && ch.charCodeAt(0) < 0x3000 && cur.charCodeAt(cur.length - 1) < 0x3000 && !cur.endsWith(" ");
        if (midWord && sp > 0) { out.push(cur.slice(0, sp)); cur = cur.slice(sp + 1); }
        else { out.push(cur); cur = ""; }
      }
      if (cur === "" && ch === " ") continue;
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

// 流れるコメントの配置を決める。各コメントに {lane, w}（行・文字幅）を付けて返す。
// 行の選び方: 上の行から順に「前のコメントに追いつかない・重ならない」行を探す。空きが無ければ一番早く空く行。
const flowCache = new WeakMap();   // chat 配列 → {key, items}
function layoutFlow(ctx, chat, clip) {
  const { W, H } = outSize(clip);
  const o = clip.chat_overlay;
  const size = Math.min(W, H) * o.font_pct / 100;
  const key = [W, H, o.font_pct, o.lanes, o.cross_sec, chat.length].join("|");
  const hit = flowCache.get(chat);
  if (hit && hit.key === key) return hit.items;
  ctx.font = `700 ${size}px ${DRAW_FONT}`;
  const lanes = Math.max(1, Math.round(o.lanes)), dur = Math.max(1, o.cross_sec), gap = size * CHAT_GAP_EM;
  const last = new Array(lanes).fill(null);   // 各行の直前のコメント
  const items = [];
  for (const m of [...chat].sort((a, b) => a.t - b.t)) {
    const text = (m.amount ? `${m.amount} ` : "") + m.text;
    const w = ctx.measureText(text).width;
    const speed = (W + w) / dur;
    // 前のコメント p がいる行に入れる条件: (1) p の末尾が右端から gap ぶん離れた後に出る (2) p が消える前に p の末尾へ追いつかない
    const freeAt = p => {
      if (!p) return -Infinity;
      const tailClear = p.t + (p.w + gap) / p.speed;                 // p の末尾が右端から gap 離れる時刻
      const noCatch = p.t + dur - (W - gap) / speed;                  // これ以降に出れば p が左へ抜けるまで追いつかない
      return Math.max(tailClear, noCatch);
    };
    let lane = last.findIndex(p => freeAt(p) <= m.t);
    if (lane < 0) lane = last.reduce((best, p, i) => freeAt(p) < freeAt(last[best]) ? i : best, 0);
    const it = { t: m.t, text, amount: m.amount ? `${m.amount} ` : "", w, speed, lane };
    last[lane] = it;
    items.push(it);
  }
  flowCache.set(chat, { key, items });
  return items;
}

// 1 コマ描く。source は <video> か <img>、t は切り抜き開始からの秒。
function drawClipFrame(ctx, source, clip, cues, chat, t) {
  const { W, H } = outSize(clip);
  const short = Math.min(W, H);
  const dur = clip.end_sec - clip.start_sec;
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const v = videoRect(clip);
  if (source) ctx.drawImage(source, v.x, v.y, v.w, v.h);

  // 隠す四角
  ctx.fillStyle = "#000";
  for (const m of clip.masks) {
    const mEnd = m.end === null || m.end === undefined ? dur : m.end;
    if (t < (m.start || 0) || t > mEnd) continue;
    const r = srcToOut(clip, m);
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  // 流れるコメント（半透明）
  const o = clip.chat_overlay;
  if (o && o.enabled && chat.length) {
    const size = short * o.font_pct / 100, outline = Math.max(1, short * CHAT_OUTLINE_PCT / 100);
    const items = layoutFlow(ctx, chat, clip);
    ctx.font = `700 ${size}px ${DRAW_FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.globalAlpha = Math.min(1, Math.max(0.1, o.opacity));
    const top = H * o.top_pct / 100;
    for (const it of items) {
      const el = t - it.t;
      if (el < 0 || el > o.cross_sec) continue;
      const x = W - it.speed * el, y = top + it.lane * size * CHAT_LANE_HEIGHT;
      if (it.amount) {
        drawOutlined(ctx, it.amount, x, y, outline, "#ffd400");   // スパチャの金額は黄
        drawOutlined(ctx, it.text.slice(it.amount.length), x + ctx.measureText(it.amount).width, y, outline);
      } else {
        drawOutlined(ctx, it.text, x, y, outline);
      }
    }
    ctx.globalAlpha = 1;
  }

  // 字幕（下中央・白文字黒縁）
  const c = clip.caption;
  const capSize = short * c.font_pct / 100;
  ctx.font = `700 ${capSize}px ${DRAW_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const lines = [];
  for (const cue of cues) {
    if (cue.start <= t && t < cue.end && cue.text.trim()) lines.push(...wrapByWidth(ctx, cue.text, W * (1 - 2 * CAPTION_MARGIN_H_PCT / 100)));
  }
  let y = H * (1 - c.bottom_pct / 100) - (lines.length - 1) * capSize * LINE_HEIGHT;
  for (const line of lines) {
    drawOutlined(ctx, line, W / 2, y, short * CAPTION_OUTLINE_PCT / 100);
    y += capSize * LINE_HEIGHT;
  }
}

// ---- 通信 ----
// 旧バージョン検出時の案内文（「パッケージ化されていない拡張」はファイルを差し替えても
// 🔄を押すまで YouTube タブ側が旧版のまま動く）。
function verErrorMsg(pageVer) {
  return `旧バージョンの部品が動いています（ページ側 ${pageVer || "不明（旧版）"} / 本体 ${chrome.runtime.getManifest().version}）。\n` +
         "YouTube のタブを再読み込み（F5）してから、もう一度お試しください。";
}

// タブの content script へメッセージを送る。生きた content script が無いタブ
// （拡張を入れる前から開いていた／拡張の更新直後）には部品をその場で注入して 1 回だけ再試行する。
async function messageWithInject(tabId, req) {
  let r;
  try { r = await chrome.tabs.sendMessage(tabId, req); } catch (_) { r = undefined; }
  if (r !== undefined) return r;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["inject.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["common.js", "content.js"] });
    r = await chrome.tabs.sendMessage(tabId, req);
  } catch (_2) { throw "ページと通信できません。YouTube のタブを再読み込み（F5）してからもう一度お試しください。"; }
  if (r === undefined) throw verErrorMsg(undefined);
  return r;
}

// content script の応答を検証する。error はそのまま投げ、旧バージョンの部品が動いていたら案内する。
function assertVer(r) {
  if (r === undefined || r === null) throw verErrorMsg(undefined);
  if (r.error) throw r.error;
  if (r.ver !== chrome.runtime.getManifest().version) throw verErrorMsg(r.ver);
  return r;
}
