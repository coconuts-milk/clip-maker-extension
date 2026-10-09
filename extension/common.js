// パネル / 編集画面 / content script で共有する定数・部品・描画（同じロジックを 2 箇所に持たない）。
// 描画（drawClipFrame）は編集画面のプレビューと録画の両方がこれを使うので、プレビューで見たものがそのまま動画になる。

// 部品の版。manifest.json の version と同じ値にする（e2e/check_panel.js が一致を確認する）。
// Chrome は、YouTube のタブで動く部品（content.js など）と manifest を「拡張を読み込んだ時点」で覚え、
// chrome://extensions の更新ボタンを押すまで使い続ける（タブを読み込み直しても変わらない＝2026-10-04 実機で確認）。
// 一方、パネルと編集画面は開くたびに最新のファイルを読む。そのため、ファイルだけ差し替えて更新ボタンを押していないと、
// 新しい編集画面が古い部品に命令することになり、知らない命令が無視される
// （2026-10-04: これで「再生が止まらない・囲み枠が効かない・音なしが効かない」が起きた）。
// 見つけ方: 開いた画面が読んだ BUILD（最新）と、Chrome が覚えている manifest の version（読み込み時点）を比べる（needsExtensionReload）。
const BUILD = "0.15.0";

const MAX_CLIP_SEC = 60;   // 切り抜きの上限（Shorts の上限に合わせる）
const DEFAULT_LEN_SEC = 30;

const VIDEO_W = 1920, VIDEO_H = 1080;        // 元動画の座標の基準（隠す四角はこの座標で持つ）
const PORTRAIT_W = 1080, PORTRAIT_H = 1920;  // 縦（Shorts 9:16）
// 縦: 元の動画の上に置く「囲み枠」。枠は出来上がりと同じ形（9:16）で固定。枠の中がそのまま出来上がりになる。
// 枠は動画の外へはみ出せて、はみ出した所は黒。例: 枠の幅を動画の幅に合わせると、動画が横いっぱい・上下が黒になる。
// SRC_VIEW: 編集画面で「元の動画」として見せる範囲（元動画の px）。枠が動ける範囲でもある。
//   幅は動画の左右に 10% ずつの余白、高さはその幅の 9:16 の枠がちょうど入る高さ。
const SRC_VIEW_W = VIDEO_W * 1.2, SRC_VIEW_H = SRC_VIEW_W * PORTRAIT_H / PORTRAIT_W;
const SRC_VIEW = { x: (VIDEO_W - SRC_VIEW_W) / 2, y: (VIDEO_H - SRC_VIEW_H) / 2, w: SRC_VIEW_W, h: SRC_VIEW_H };
const CROP_MIN_W = 240;                      // 枠の最小の幅（元動画の px）。これ以上小さいと拡大しすぎて絵が粗くなる
const CROP_RATIO = PORTRAIT_H / PORTRAIT_W;  // 枠の高さ ÷ 幅（固定）
const DEFAULT_CROP_W = VIDEO_H;              // 最初の枠の幅 = 動画の高さ（中央の正方形が出来上がりの中央に入り、上下が黒）

// 画質（ビットレート）。送り先の容量制限（例: 20MB）に合わせて下げられるようにする
const QUALITY = {
  high:  { label: "高",   video_bps: 8000000, audio_bps: 192000, note: "きれい" },
  std:   { label: "標準", video_bps: 4000000, audio_bps: 160000, note: "ほどほど" },
  small: { label: "軽い", video_bps: 2000000, audio_bps: 96000,  note: "容量を抑える" },
};
const DEFAULT_QUALITY = "std";
// 出来上がりの大きさの目安（MB）。ビットレート × 秒数（実際は絵の動きで前後する）
function estimateMb(clip) {
  const q = QUALITY[clip.quality] || QUALITY[DEFAULT_QUALITY];
  const sec = clip.end_sec - clip.start_sec;
  return (q.video_bps + (clip.audio ? q.audio_bps : 0)) * sec / 8 / 1048576;
}

// ---- 設定の既定値 ----
function defaultFrame(mode) {
  // crop: 元の動画（1920×1080 基準）の座標で表した 9:16 の枠。
  // valign: 枠の上下の合わせ方。top = 動画の上端と枠の上端をそろえる（動画が上より・下が黒）、bottom = 下より、
  //         center = 中央、free = 手で動かした位置のまま
  if (mode === "portrait") return { mode, crop: alignCrop({ x: (VIDEO_W - DEFAULT_CROP_W) / 2, y: 0, w: DEFAULT_CROP_W }, "center"), valign: "center" };
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
    ? normalizePortrait(f)
    : { mode: "landscape" };
  clip.audio = clip.audio !== false;   // 音声を入れるか（既定: 入れる）
  if (!QUALITY[clip.quality]) clip.quality = DEFAULT_QUALITY;
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
// 囲み枠を使える範囲に収める: 形は 9:16 固定、幅は CROP_MIN_W〜SRC_VIEW の幅、位置は SRC_VIEW の中
function clampCrop(c) {
  const w = Math.min(SRC_VIEW.w, Math.max(CROP_MIN_W, c.w)), h = w * CROP_RATIO;
  const x = Math.min(SRC_VIEW.x + SRC_VIEW.w - w, Math.max(SRC_VIEW.x, c.x));
  const y = Math.min(SRC_VIEW.y + SRC_VIEW.h - h, Math.max(SRC_VIEW.y, c.y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// 枠の上下の位置を合わせ方どおりにする（free はそのまま）
function alignCrop(c, valign) {
  const h = c.w * CROP_RATIO;
  const y = valign === "top" ? 0 : valign === "bottom" ? VIDEO_H - h : valign === "center" ? (VIDEO_H - h) / 2 : c.y;
  return clampCrop({ x: c.x, y, w: c.w });
}

// 保存してあった縦の設定を今の形式にそろえる（古い形式・欠けた項目は既定値）
function normalizePortrait(f) {
  const valign = ["top", "center", "bottom", "free"].includes(f.valign) ? f.valign : "center";
  const c = f.crop;
  if (!c || !Number.isFinite(c.w) || !Number.isFinite(c.x)) return defaultFrame("portrait");
  // v0.9.0 の枠は形が自由だった。幅と左右の位置はそのまま使い、上下は元の枠の中心に合わせて 9:16 にする
  const is916 = Number.isFinite(c.h) && Math.abs(c.h / c.w - CROP_RATIO) < 0.01;
  const y = is916 ? c.y : (Number.isFinite(c.y) && Number.isFinite(c.h) ? c.y + c.h / 2 - c.w * CROP_RATIO / 2 : 0);
  return { mode: "portrait", crop: clampCrop({ x: c.x, y, w: c.w }), valign: is916 ? valign : "free" };
}

// 出力の中で動画全体を置く矩形 {x, y, w, h}（出力の px）。縦は「囲み枠 = 出力全体」になるように拡大・移動する。
function videoRect(clip) {
  const { W, H } = outSize(clip);
  const f = clip.frame || {};
  if (f.mode !== "portrait") return { x: 0, y: 0, w: W, h: H };
  const k = W / f.crop.w;
  return { x: -f.crop.x * k, y: -f.crop.y * k, w: VIDEO_W * k, h: VIDEO_H * k };
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
  const key = [W, H, o.font_pct, o.lanes, o.cross_sec, chat.map(m => `${m.t}:${m.amount || ""}:${m.text}`).join("\n")].join("|");
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
  if (source) ctx.drawImage(source, v.x, v.y, v.w, v.h);   // 縦は枠の外が canvas の外になるので、そのまま描けば枠どおりに切れる

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

// 保存する動画のファイル名: 作った日時_縦横_音の有無。例: 20261004_153045_short_sound_off.mp4
function clipFileName(clip, ext, now) {
  const d = now || new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `${stamp}_${clip.frame.mode === "portrait" ? "short" : "horizon"}_${clip.audio ? "sound_on" : "sound_off"}.${ext}`;
}

// ---- 設定ファイル（動画と一緒に保存する .clipmaker.json。後から読み込んで再編集できる） ----
const PROJECT_FORMAT = 1;
function projectFromDraft(draft) {
  const { savedCrop, ...frame } = draft.clip.frame || {};
  return {
    clipmaker: PROJECT_FORMAT, build: BUILD, saved_at: new Date().toISOString(),
    clip: { ...draft.clip, frame },
    captions: { lang: draft.captions.lang || "", source: draft.captions.source || "youtube", cues: draft.captions.cues },
    chat: { messages: draft.chat.messages },
    subsrc: draft.subsrc || "youtube",
  };
}
// 読み込んだ設定ファイルを下書きにする。コマ画像と音声は入っていないので、needFrames を立てて後で撮る
function draftFromProject(p) {
  if (!p || p.clipmaker !== PROJECT_FORMAT || !p.clip || !p.clip.video_id || !Number.isFinite(p.clip.start_sec) || !Number.isFinite(p.clip.end_sec)) {
    throw "設定ファイルの形式が違います（Clip Maker が保存した .clipmaker.json を選んでください）";
  }
  const clip = normalizeClip({ ...p.clip });
  return {
    clip,
    captions: { lang: (p.captions && p.captions.lang) || "", source: (p.captions && p.captions.source) || "youtube", cues: (p.captions && p.captions.cues) || [] },
    chat: { messages: (p.chat && p.chat.messages) || [] },
    frames: null, audio: null, subsrc: p.subsrc || "youtube", asrDone: true, needFrames: true, qualitySet: true,
  };
}

// ---- 版の食い違い ----
// 拡張の本体（Chrome が覚えている版）が、今のファイルより古いか
function needsExtensionReload() {
  return chrome.runtime.getManifest().version !== BUILD;
}
const NEED_RELOAD_MSG = "拡張機能の更新が必要です。「拡張を更新する」を押してください。";

// 「更新が必要」の案内とボタンを host の先頭に出す。押すと拡張が自分で読み込み直される（開いているパネル・編集画面は閉じる）
function showReloadNotice(host, note) {
  const box = document.createElement("div");
  box.id = "needreload";
  box.style.cssText = "background:#fff4d6;border:2px solid #e0a800;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:16px;line-height:1.6";
  const p = document.createElement("div");
  p.textContent = "拡張機能が新しくなっています。更新するまで正しく動きません。" + (note || "");
  const b = document.createElement("button");
  b.className = "primary";
  b.style.marginTop = "8px";
  b.textContent = "拡張を更新する";
  b.addEventListener("click", () => chrome.runtime.reload());
  box.appendChild(p);
  box.appendChild(b);
  // 古い部品に命令を送らないよう、ほかのボタンは押せなくする
  document.querySelectorAll("button").forEach(x => { x.disabled = true; });
  host.insertBefore(box, host.firstChild);
}

// ---- 通信 ----
// YouTube のタブで動く部品（content.js）へメッセージを送る。部品が居ないタブ
// （拡張を入れる前から開いていた／拡張の更新直後）には、その場で入れてから送り直す。
async function messageWithInject(tabId, req) {
  if (needsExtensionReload()) throw NEED_RELOAD_MSG;
  let r;
  try { r = await chrome.tabs.sendMessage(tabId, req); } catch (_) { r = undefined; }
  if (r === undefined) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["inject.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["common.js", "mp4.js", "content.js"] });
      r = await chrome.tabs.sendMessage(tabId, req);
    } catch (_2) { r = undefined; }
  }
  if (r === undefined) throw "ページと通信できません。YouTube のタブを再読み込み（F5）してからもう一度お試しください。";
  return r;
}

// 応答を検証する。error はそのまま投げる。相手の版が違うとき（古い部品が残っているタブ）は読み込み直しを案内する
function assertVer(r) {
  if (r === undefined || r === null) throw "ページと通信できません。YouTube のタブを再読み込み（F5）してからもう一度お試しください。";
  if (r.error) throw r.error;
  if (r.build !== BUILD) throw "YouTube のタブで古い部品が動いています。YouTube のタブを再読み込み（F5）してから、もう一度お試しください。";
  return r;
}
