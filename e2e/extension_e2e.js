// 拡張の実機 E2E: 本物の Chrome に拡張を読み込み、普段の使い方どおりに通す。
//   別の動画から YouTube 内の移動で目的の動画へ → パネル（開いた時点の時間が開始に入る）→ 吸い出し
//   → 編集画面: 字幕が取れている／四角を複数作る・枠の外まで引っぱる・移動・大きさ変更・削除／プレビュー再生
//   → 「動画を作る」横 → 縦。録画中は YouTube タブに「録画中」の表示が出る。
// 使い方: node e2e/extension_e2e.js [videoId] [start秒] [length秒]
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXT = path.resolve(__dirname, "..", "extension");
const VIDEO = process.argv[2] || "JnKgfHO_UbU";   // 配信アーカイブ（自動字幕とチャットのリプレイあり）
const START = process.argv[3] !== undefined ? Number(process.argv[3]) : 1880;   // 31:20〜。コメントが入っている時間帯
const LEN = process.argv[4] !== undefined ? Number(process.argv[4]) : 14;
const FIRST = "jNQXAC9IVRw";                       // 最初に開く別の動画
const OUT = path.join(os.homedir(), "Downloads", "clip-maker");
const SHOTS = path.join(__dirname, "shots");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok }); console.log(`${ok ? "OK " : "NG "} ${name}${detail !== undefined ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); };

// ファイル名は「作った日時_縦横_音の有無」。例: 20261004_153045_short_sound_off.mp4
// ffmpeg / ffprobe の場所（PATH に無ければ winget の入れ先を探す）
function tool(name) {
  const { execSync } = require("child_process");
  try { return execSync(`where ${name}`, { encoding: "utf8" }).split(/\r?\n/)[0].trim(); } catch (_) { /* PATH に無い */ }
  const root = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  for (const d of fs.existsSync(root) ? fs.readdirSync(root).filter(n => n.startsWith("Gyan.FFmpeg")) : []) {
    for (const v of fs.readdirSync(path.join(root, d))) {
      const f = path.join(root, d, v, "bin", name + ".exe");
      if (fs.existsSync(f)) return f;
    }
  }
  throw new Error(name + " が見つかりません");
}
// 動画に入っているもの: ["video", "audio"] など
function streamsOf(file) {
  const { execFileSync } = require("child_process");
  return execFileSync(tool("ffprobe"), ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file], { encoding: "utf8" }).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}
// コマの間隔: {fps, longGaps(50ms 超の数), maxGapMs, frames}
function frameGaps(file) {
  const { execFileSync } = require("child_process");
  const out = execFileSync(tool("ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file], { encoding: "utf8", maxBuffer: 1 << 26 });
  const pts = out.split(/\r?\n/).map(x => x.trim().replace(/,$/, "")).filter(Boolean).map(Number);
  const gaps = pts.slice(1).map((t, i) => t - pts[i]);
  return { frames: pts.length, fps: +((pts.length - 1) / (pts[pts.length - 1] - pts[0])).toFixed(2), longGaps: gaps.filter(g => g > 0.05).length, maxGapMs: +(Math.max(...gaps) * 1000).toFixed(1) };
}
// 動画の t 秒のコマから、横いっぱい・高さ 40px の帯（上端が y）を取り、明るさの平均（0〜255）を返す
function bandBrightness(file, t, y) {
  const { execFileSync } = require("child_process");
  const buf = execFileSync(tool("ffmpeg"), ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=iw:40:0:${y}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 26 });
  let n = 0;
  for (const b of buf) n += b;
  return buf.length ? n / buf.length : -1;
}

// 「YouTube のタブが古い部品のまま」を再現するため、途中で部品の版（common.js の BUILD）を書き換える。終わったら必ず元に戻す
const COMMON = path.join(EXT, "common.js");
const COMMON_ORIG = fs.readFileSync(COMMON, "utf8");
const restoreCommon = () => fs.writeFileSync(COMMON, COMMON_ORIG);
process.on("exit", restoreCommon);

async function waitVideoFile(since, tag, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(OUT)) {
      const hit = fs.readdirSync(OUT)
        .filter(n => new RegExp(`^\\d{8}_\\d{6}_${tag}\\.(mp4|webm)$`).test(n))
        .map(n => path.join(OUT, n))
        .filter(p => fs.statSync(p).mtimeMs >= since && fs.statSync(p).size > 0);
      if (hit.length) return hit.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    }
    await sleep(500);
  }
  return null;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, enableExtensions: [EXT],
    // YouTube は headless・自動操作フラグ付きだと字幕本文を空で返す（2026-08 実測）ので、通常ブラウザと同じ条件にする
    args: ["--mute-audio", "--lang=ja", "--disable-blink-features=AutomationControlled", "--window-size=1600,1000"],
    ignoreDefaultArgs: ["--enable-automation"],
    defaultViewport: null,
  });
  const files = [];
  try {
    // 1) 別の動画を開いてから YouTube 内の移動で目的の動画へ（字幕が「無い」と誤判定された条件）
    const page = await browser.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${FIRST}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("video", { timeout: 30000 });
    for (const sel of ['button[aria-label*="同意"]', 'button[aria-label*="Accept"]']) {
      const b = await page.$(sel); if (b) { await b.click(); break; }
    }
    await sleep(4000);
    await page.evaluate((id, t) => {
      document.querySelector("ytd-app").fire("yt-navigate", { endpoint: {
        commandMetadata: { webCommandMetadata: { url: `/watch?v=${id}&t=${t}s`, webPageType: "WEB_PAGE_TYPE_WATCH", rootVe: 3832 } },
        watchEndpoint: { videoId: id, startTimeSeconds: t } } });
    }, VIDEO, Math.floor(START));
    await sleep(8000);
    check("YouTube 内の移動で目的の動画へ", page.url().includes(VIDEO), page.url());
    await page.evaluate(t => { const v = document.querySelector("video"); v.muted = true; v.pause(); v.currentTime = t; }, START);
    await sleep(2000);

    const extTarget = await browser.waitForTarget(t => t.url().startsWith("chrome-extension://"), { timeout: 15000 });
    const extId = new URL(extTarget.url()).host;

    // 2) パネル。本物はサイドパネルで「前面のタブ＝YouTube」だが、自動操作ではタブとして開くので前面タブの問い合わせだけ差し替える
    const panel = await browser.newPage();
    await panel.evaluateOnNewDocument(videoId => {
      const orig = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async q => {
        if (q && q.active) { const all = await orig({ url: "*://www.youtube.com/*" }); return all.filter(t => t.url.includes(videoId)); }
        return orig(q);
      };
    }, VIDEO);
    await panel.setViewport({ width: 343, height: 520 });   // サイドパネルの幅 360 から縦スクロールバーぶんを引いた幅で確認する

    // 「ファイルだけ新しくなり、拡張の更新ボタンは押していない」状態の再現: 部品の版（BUILD）だけ書き換えてパネルを開く。
    // これで「止まらない・囲み枠が効かない・音なしが効かない」が起きた（2026-10-04）。案内と更新ボタンが出て、命令は送られないこと
    if (!/const BUILD = "[^"]+";/.test(COMMON_ORIG)) throw new Error("common.js に BUILD が無い");
    fs.writeFileSync(COMMON, COMMON_ORIG.replace(/const BUILD = "[^"]+";/, 'const BUILD = "e2e-newer";'));
    await panel.goto(`chrome-extension://${extId}/panel.html`);
    await sleep(1500);
    const stale = await panel.evaluate(async () => {
      const n = document.getElementById("needreload");
      const others = [...document.querySelectorAll("button")].filter(b => !b.closest("#needreload"));
      return { notice: n ? n.textContent : null, button: !!(n && n.querySelector("button") && !n.querySelector("button").disabled), othersDisabled: others.length > 0 && others.every(b => b.disabled) };
    });
    check("拡張が古いままのとき、案内と「拡張を更新する」ボタンが出る", stale.notice && stale.notice.includes("拡張を更新する") && stale.button, stale.notice);
    check("拡張が古いままのとき、ほかのボタンは押せない（古い部品に命令を送らない）", stale.othersDisabled);
    restoreCommon();

    await panel.goto(`chrome-extension://${extId}/panel.html`);
    await sleep(2500);
    const p1 = await panel.evaluate(() => {
      const vals = id => [...document.querySelectorAll(`#${id} input`)].map(e => e.value);
      return { start: vals("start"), end: vals("end"), len: document.getElementById("length").value, msg: document.getElementById("msg").textContent };
    });
    check("ふだんは案内が出ない", await panel.evaluate(() => !document.getElementById("needreload")));
    const startSec = Number(p1.start[0]) * 3600 + Number(p1.start[1]) * 60 + Number(p1.start[2]) + Number(p1.start[3]) / 10;
    check("パネル: 開いた時点の再生位置が開始に入る", Math.abs(startSec - START) < 1.5, p1);
    check("パネル: 時間の枠は 時:分:秒.コンマ の 4 つで 0 埋め", p1.start.length === 4 && p1.start[0].length === 2 && p1.start[1].length === 2 && p1.start[2].length === 2 && p1.start[3].length === 1);
    // 長さを変えると終了が追随 / 終了を変えると長さが追随
    const p2 = await panel.evaluate(len => {
      const $ = id => document.getElementById(id);
      const vals = id => [...document.querySelectorAll(`#${id} input`)].map(e => e.value).join(":");
      $("length").value = String(len); $("length").dispatchEvent(new Event("input"));
      const endAfterLen = vals("end");
      const sec = document.querySelector("#end .ts");
      sec.value = String((Number(sec.value) + 2) % 60).padStart(2, "0"); sec.dispatchEvent(new Event("input"));
      const lenAfterEnd = $("length").value;
      $("length").value = String(len); $("length").dispatchEvent(new Event("input"));
      return { endAfterLen, lenAfterEnd, end: vals("end") };
    }, LEN);
    check("パネル: 開始・終了・長さが連動", p2.lenAfterEnd !== String(LEN) && p2.endAfterLen === p2.end, p2);
    await panel.screenshot({ path: path.join(SHOTS, "panel.png") });
    const fits = await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check("パネル: 幅 343（360 − スクロールバー）に横並びで収まる", fits);

    // 3) 吸い出して編集画面を開く
    await page.bringToFront();
    await panel.evaluate(() => document.getElementById("go").click());
    const edTarget = await browser.waitForTarget(t => t.url().includes("/editor.html"), { timeout: 90000 });
    const editor = await edTarget.page();
    await editor.bringToFront();
    await editor.waitForSelector("#ov", { timeout: 10000 });
    await sleep(2500);
    const ed = await editor.evaluate(async () => {
      const { draft } = await chrome.storage.local.get("draft");
      return { cues: draft.captions.cues.length, capErr: draft.captions.error, firstCue: draft.captions.cues[0], chat: draft.chat.messages.length, chatErr: draft.chat.error,
               frames: draft.frames && draft.frames.list ? draft.frames.list.length : (draft.frames && draft.frames.error), title: draft.clip.title };
    });
    check("字幕が取れている（YouTube 内の移動の後でも）", ed.cues > 0, ed);
    check("プレビュー用のコマ画像がある", typeof ed.frames === "number" && ed.frames >= 2, ed.frames);
    check("コメントが取れている", ed.chat > 0, { chat: ed.chat, chatErr: ed.chatErr });
    const over = await editor.evaluate(() => [...document.querySelectorAll("section")].filter(s => s.scrollWidth > s.clientWidth + 1).map(s => s.querySelector("h2").textContent));
    check("編集画面: 枠からはみ出している所が無い", over.length === 0, over);

    // 4) 四角: 1 個目はふつうにドラッグ、2 個目は枠の外まで引っぱって外で離す
    const box = await (await editor.$("#ov")).boundingBox();
    const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
    const countMasks = () => editor.evaluate(() => document.querySelectorAll("#ov .mask:not(.tmp)").length);
    const maskData = () => editor.evaluate(async () => (await chrome.storage.local.get("draft")).draft.clip.masks);
    await editor.mouse.move(...at(0.10, 0.10)); await editor.mouse.down(); await editor.mouse.move(...at(0.30, 0.30), { steps: 6 }); await editor.mouse.up();
    check("四角 1 個目ができる", await countMasks() === 1);
    await editor.mouse.move(...at(0.70, 0.60)); await editor.mouse.down();
    await editor.mouse.move(box.x + box.width + 120, box.y + box.height + 90, { steps: 8 });   // 枠の外へ
    await editor.mouse.up();                                                                      // 外で離す
    await sleep(300);
    let masks = await maskData();
    check("四角 2 個目ができる（複数作れる）", await countMasks() === 2, masks);
    const m2 = masks[1];
    check("枠の外へ出たら端で止まる", m2 && Math.abs(m2.x + m2.w - 1920) <= 2 && Math.abs(m2.y + m2.h - 1080) <= 2, m2);
    await editor.mouse.move(...at(0.50, 0.45), { steps: 4 });   // ボタンを離した後はついてこない
    check("離した後はマウスについてこない", JSON.stringify((await maskData())[1]) === JSON.stringify(m2));
    // 1 個目を掴んで移動
    await editor.mouse.move(...at(0.20, 0.14)); await editor.mouse.down(); await editor.mouse.move(...at(0.40, 0.34), { steps: 6 }); await editor.mouse.up();
    await sleep(300);
    const moved = (await maskData())[0];
    check("作った四角を掴んで移動できる", Math.abs(moved.x - masks[0].x - 384) < 12 && Math.abs(moved.w - masks[0].w) <= 2, { before: masks[0], after: moved });
    // 1 個目の右下の角で大きさ変更
    const h = await (await editor.$('#ov .mask[data-i="0"] .h.se')).boundingBox();
    await editor.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await editor.mouse.down();
    await editor.mouse.move(h.x + h.width / 2 + box.width * 0.10, h.y + h.height / 2 + box.height * 0.10, { steps: 6 }); await editor.mouse.up();
    await sleep(300);
    const resized = (await maskData())[0];
    check("作った四角の大きさを変えられる", resized.w > moved.w + 100 && resized.h > moved.h + 50 && Math.abs(resized.x - moved.x) <= 2, { before: moved, after: resized });
    // 3 個目を作って × で消す
    await editor.mouse.move(...at(0.05, 0.70)); await editor.mouse.down(); await editor.mouse.move(...at(0.20, 0.90), { steps: 6 }); await editor.mouse.up();
    await sleep(200);
    check("四角 3 個目ができる", await countMasks() === 3);
    const x = await (await editor.$("#ov .mask.sel .x")).boundingBox();
    await editor.mouse.click(x.x + x.width / 2, x.y + x.height / 2);
    await sleep(300);
    check("× で四角を消せる", await countMasks() === 2);

    // 4b) 字幕の追加: 間に挟むと、終了が次の字幕の開始に合う
    const addRes = await editor.evaluate(async () => {
      const d = (await chrome.storage.local.get("draft")).draft;
      const cues = d.captions.cues;
      if (cues.length < 2) return { skip: true };
      document.querySelector('.tab[data-tab="captions"]').click();
      const t = +((cues[0].start + cues[0].end) / 2).toFixed(1);
      const s = document.getElementById("pvtime"); s.value = t; s.dispatchEvent(new Event("input"));
      document.getElementById("addcue").click();
      await new Promise(r => setTimeout(r, 300));
      const d2 = (await chrome.storage.local.get("draft")).draft;
      const added = d2.captions.cues.find(c => c.text === "" && Math.abs(c.start - t) < 0.01);
      const next = d2.captions.cues.filter(c => c.start > t + 0.2).sort((a, b) => a.start - b.start)[0];
      // 追加した空の行は消しておく
      const i = d2.captions.cues.indexOf(added); d2.captions.cues.splice(i, 1); await chrome.storage.local.set({ draft: d2 });
      return { t, added, nextStart: next && next.start, wrapH: document.getElementById("cueswrap").clientHeight, scroll: getComputedStyle(document.getElementById("cueswrap")).overflowY };
    });
    if (!addRes.skip) {
      check("字幕を追加すると、開始＝今の時刻・終了＝次の字幕の開始になる", addRes.added && Math.abs(addRes.added.end - addRes.nextStart) < 0.01, addRes);
      check("字幕の一覧は決まった高さで中だけスクロールする", addRes.wrapH <= 190 && addRes.scroll === "auto", { h: addRes.wrapH, scroll: addRes.scroll });
    }

    // 4c) 取り直し: 直した字幕は時間をずらして残り、増えた時間ぶんだけ新しく入る
    const before = await editor.evaluate(async () => {
      await location.reload();   // 4b で storage を直接書き換えたので読み直す
    }).catch(() => {});
    await sleep(1500);
    await editor.waitForSelector("#ov", { timeout: 10000 });
    const edited = await editor.evaluate(async () => {
      document.querySelector('.tab[data-tab="captions"]').click();
      const row = document.querySelector("#cues tbody tr");
      const inp = row.querySelector("input[type=text]");
      inp.value = "EDITED_BY_E2E"; inp.dispatchEvent(new Event("input")); inp.dispatchEvent(new Event("change"));
      await new Promise(r => setTimeout(r, 300));
      const d = (await chrome.storage.local.get("draft")).draft;
      return { start: d.captions.cues[0].start, n: d.captions.cues.length, list: d.captions.cues.map(c => `${c.start}-${c.end} ${c.text.slice(0, 8)}`) };
    });
    await editor.evaluate(async () => {
      document.querySelector('.tab[data-tab="settings"]').click();
      const sec = document.querySelector("#start_sec .ts"), min = document.querySelector("#start_sec .tm");
      let v = Number(sec.value) - 4;   // 開始を 4 秒前に広げる（長さは終了固定で伸びる）
      if (v < 0) { v += 60; min.value = String(Number(min.value) - 1).padStart(2, "0"); min.dispatchEvent(new Event("input")); }
      sec.value = String(v).padStart(2, "0"); sec.dispatchEvent(new Event("input"));
      // 開始を動かすと長さ固定で終了も動くので、終了を元に戻して「前に 4 秒広げる」にする
      const esec = document.querySelector("#end_sec .ts"), emin = document.querySelector("#end_sec .tm");
      let e = Number(esec.value) + 4;
      if (e >= 60) { e -= 60; emin.value = String(Number(emin.value) + 1).padStart(2, "0"); emin.dispatchEvent(new Event("input")); }
      esec.value = String(e).padStart(2, "0"); esec.dispatchEvent(new Event("input"));
      document.getElementById("recap").click();
    });
    await editor.waitForFunction(() => document.getElementById("capmsg").textContent.startsWith("取り直しました"), { timeout: 120000 });
    const after = await editor.evaluate(async () => {
      const d = (await chrome.storage.local.get("draft")).draft;
      const e = d.captions.cues.find(c => c.text === "EDITED_BY_E2E");
      return { editedStart: e && e.start, newHead: d.captions.cues.filter(c => c.start < 3.9).length, n: d.captions.cues.length, msg: document.getElementById("capmsg").textContent,
               list: d.captions.cues.map(c => `${c.start}-${c.end} ${c.text.slice(0, 8)}`) };
    });
    check("取り直しても直した字幕は残り、時間が 4 秒ずれる", after.editedStart !== undefined && Math.abs(after.editedStart - (edited.start + 4)) < 0.05, { before: edited.start, after: after.editedStart });
    check("取り直しで増えた 4 秒ぶんの字幕が足される", after.newHead > 0 && after.n > edited.n, { newHead: after.newHead, n: after.n, before: edited.list, after: after.list });
    // 元の時間に戻す（以降の確認は元の時間で）
    await editor.evaluate(async () => {
      const sec = document.querySelector("#start_sec .ts"), min = document.querySelector("#start_sec .tm");
      let v = Number(sec.value) + 4;
      if (v >= 60) { v -= 60; min.value = String(Number(min.value) + 1).padStart(2, "0"); min.dispatchEvent(new Event("input")); }
      sec.value = String(v).padStart(2, "0"); sec.dispatchEvent(new Event("input"));
      const esec = document.querySelector("#end_sec .ts"), emin = document.querySelector("#end_sec .tm");
      let e = Number(esec.value) - 4;
      if (e < 0) { e += 60; emin.value = String(Number(emin.value) - 1).padStart(2, "0"); emin.dispatchEvent(new Event("input")); }
      esec.value = String(e).padStart(2, "0"); esec.dispatchEvent(new Event("input"));
      document.getElementById("recap").click();
    });
    await editor.waitForFunction(() => document.getElementById("capmsg").textContent.startsWith("取り直しました"), { timeout: 120000 });
    await sleep(500);

    // 5) プレビュー再生
    // プレビュー再生: YouTube のタブが同じ所を再生し（音声はそちらから鳴る）、プレビューの時刻がそれに合う
    await editor.evaluate(() => { const s = document.getElementById("pvtime"); s.value = 0; s.dispatchEvent(new Event("input")); });
    await editor.evaluate(() => document.getElementById("play").click());
    await sleep(3500);
    const pvT = await editor.evaluate(() => Number(document.getElementById("pvtime").value));
    const yt1 = await page.evaluate(() => { const v = document.querySelector("video"); return { t: v.currentTime, paused: v.paused }; });
    check("プレビューを再生すると時間が進む", pvT > 1.5, pvT);
    check("再生中は YouTube のタブが同じ所を再生している（音声が鳴る）", !yt1.paused && Math.abs(yt1.t - (START + pvT)) < 0.6, { pv: pvT, yt: +(yt1.t - START).toFixed(2), paused: yt1.paused });
    await editor.evaluate(() => document.getElementById("play").click());
    await sleep(800);
    const yt2 = await page.evaluate(() => document.querySelector("video").paused);
    check("プレビューを止めると YouTube のタブも止まる", yt2 === true);
    // 終わりまで再生したら、YouTube のタブも終了の位置で止まる
    await editor.evaluate(t => { const s = document.getElementById("pvtime"); s.value = t; s.dispatchEvent(new Event("input")); }, LEN - 2);
    await editor.evaluate(() => document.getElementById("play").click());
    await sleep(4500);
    const yt3 = await page.evaluate(() => { const v = document.querySelector("video"); return { t: v.currentTime, paused: v.paused }; });
    const btn = await editor.evaluate(() => document.getElementById("play").textContent);
    check("終わりまで再生すると YouTube のタブも終了の位置で止まる", yt3.paused && Math.abs(yt3.t - (START + LEN)) < 0.6 && btn === "▶", { yt: +(yt3.t - START).toFixed(2), paused: yt3.paused, btn });
    // コメントが流れている最中の時刻にして見た目を撮る（最初のコメントの 2 秒後）
    const firstChat = await editor.evaluate(async () => { const m = (await chrome.storage.local.get("draft")).draft.chat.messages; return m.length ? m[0].t : 2; });
    await editor.evaluate(t => { const s = document.getElementById("pvtime"); s.value = t; s.dispatchEvent(new Event("input")); }, Math.min(LEN - 0.5, firstChat + 2));
    await editor.screenshot({ path: path.join(SHOTS, "editor_yoko.png"), fullPage: true });

    // 6) 動画を作る。横（音あり）→ 縦（囲み枠を動画の外まで広げる・下より・音なし）。録画中は YouTube タブに表示が出る
    for (const mode of ["landscape", "portrait"]) {
      await editor.bringToFront();
      await editor.evaluate(m => document.querySelector(`input[name=mode][value=${m}]`).click(), mode);
      if (mode === "portrait") {
        await sleep(400);
        const crop = () => editor.evaluate(async () => (await chrome.storage.local.get("draft")).draft.clip.frame.crop);
        const ratioOk = c => Math.abs(c.h / c.w - 16 / 9) < 0.01;
        const c0 = await crop();
        check("縦: 最初の枠は 9:16 で動画の中央", c0 && c0.w === 1080 && c0.h === 1920 && c0.x === 420 && c0.y === -420, c0);
        // 右下の角を引っぱって大きくする。形は 9:16 のまま
        const sb = await (await editor.$("#srcstage")).boundingBox();
        const hb = await (await editor.$("#cropbox .h.se")).boundingBox();
        await editor.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await editor.mouse.down();
        await editor.mouse.move(hb.x + hb.width / 2 + sb.width * 0.12, hb.y + hb.height / 2 + sb.height * 0.02, { steps: 8 }); await editor.mouse.up();
        await sleep(300);
        const c1 = await crop();
        check("縦: 枠の大きさを変えても形は 9:16 のまま", c1.w > c0.w + 100 && ratioOk(c1), c1);
        // 枠を掴んで左へ移動
        const cb = await (await editor.$("#cropbox")).boundingBox();
        await editor.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await editor.mouse.down();
        await editor.mouse.move(cb.x + cb.width / 2 - sb.width * 0.06, cb.y + cb.height / 2, { steps: 6 }); await editor.mouse.up();
        await sleep(300);
        const c2 = await crop();
        check("縦: 枠を掴んで移動できる", c2.x < c1.x - 80 && c2.w === c1.w && ratioOk(c2), c2);
        await editor.evaluate(() => {
          document.querySelector("input[name=valign][value=bottom]").click();
          document.querySelector("input[name=audio][value=off]").click();
          document.querySelector("input[name=quality][value=small]").click();
        });
        const sizeNote = await editor.evaluate(() => document.getElementById("sizenote").textContent);
        check("画質を「軽い」にすると目安の大きさが出る", /約 [\d.]+ MB/.test(sizeNote), sizeNote);
        await sleep(300);
        const c3 = await crop();
        check("縦: 下よりにすると動画の下端と枠の下端がそろう", Math.abs(c3.y + c3.h - 1080) <= 1 && c3.w === c2.w, c3);
        // 出来上がり: 下よりなので、上の端は黒・下の端は黒ではない
        const px = await editor.evaluate(() => {
          const cv = document.getElementById("pv"), g = cv.getContext("2d");
          const sum = y => { const d = g.getImageData(0, y, cv.width, 1).data; let n = 0; for (let i = 0; i < d.length; i += 4) n += d[i] + d[i + 1] + d[i + 2]; return n; };
          return { w: cv.width, h: cv.height, top: sum(20), low: sum(Math.round(cv.height * 0.8)) };
        });
        check("縦: 下よりにすると上が黒い枠になる", px.w === 1080 && px.h === 1920 && px.top === 0 && px.low > 0, px);
        await editor.screenshot({ path: path.join(SHOTS, "editor_tate.png"), fullPage: true });
      }
      const since = Date.now() - 1000;
      await editor.evaluate(() => document.getElementById("save").click());
      let banner = null;
      for (let i = 0; i < 40 && !banner; i++) {
        await sleep(250);
        banner = await page.evaluate(() => { const b = document.getElementById("clip-maker-rec"); return b ? b.textContent : null; });
      }
      check(`録画中の表示が出る（${mode}）`, banner && banner.includes("録画中です。タブ移動しないでください。") && /\d+\.\d \/ \d+\.\d 秒/.test(banner), banner);
      if (mode === "landscape") await page.screenshot({ path: path.join(SHOTS, "recording.png") });
      const file = await waitVideoFile(since, mode === "portrait" ? "short_sound_off" : "horizon_sound_on", (LEN + 60) * 1000);
      await sleep(1000);
      const msg = await editor.evaluate(() => document.getElementById("msg").textContent);
      check(`動画ファイルができる（${mode}）`, !!file, `${file} / ${msg.replace(/\n/g, " ")}`);
      const bannerGone = await page.evaluate(() => !document.getElementById("clip-maker-rec"));
      check(`録画が終わったら表示が消える（${mode}）`, bannerGone);
      files.push(file);
      if (file) {
        check(`コマごとに時刻を指定する方式（WebCodecs）で録画できた（${mode}）`, !msg.includes("揺れる方式") && !msg.includes("コマ落ち"), msg.replace(/\n/g, " "));
        const g = frameGaps(file);
        check(`コマの間隔が揃っている（${mode}）`, g.longGaps === 0 && g.fps >= 29 && g.fps <= 61 && g.frames > LEN * 25, g);
        const st = streamsOf(file);
        if (mode === "landscape") {
          check("音あり: 動画に音声が入っている", st.includes("video") && st.includes("audio"), st);
          // ① 設定ファイルが一緒に保存され、読み込むと同じ字幕で編集画面が開く
          const pj = file.replace(/\.(mp4|webm)$/, "") + ".clipmaker.json";
          const pjOk = fs.existsSync(pj);
          check("動画と一緒に設定ファイル（.clipmaker.json）が保存される", pjOk, pj);
          if (pjOk) {
            files.push(pj);
            const saved = JSON.parse(fs.readFileSync(pj, "utf8"));
            const re = await editor.evaluate(async (p) => {
              const d = draftFromProject(p);
              await chrome.storage.local.set({ draft: d });
              location.reload();
            }, saved).catch(() => {});
            await sleep(2000);
            await editor.waitForFunction(() => document.getElementById("projmsg").textContent.startsWith("読み込みました"), { timeout: 60000 }).catch(() => {});
            const loaded = await editor.evaluate(async () => {
              const d = (await chrome.storage.local.get("draft")).draft;
              return { cues: d.captions.cues.length, frames: d.frames && d.frames.list ? d.frames.list.length : 0, masks: d.clip.masks.length, msg: document.getElementById("projmsg").textContent };
            });
            check("設定ファイルを読み込むと、字幕・四角がそのままでコマ画像が撮り直される", loaded.cues === saved.captions.cues.length && loaded.masks === saved.clip.masks.length && loaded.frames > 0, loaded);
          }
          await editor.evaluate(() => document.querySelector("input[name=quality][value=high]").click());   // 2 本目の比較用に戻す
        }
        else {
          check("音なし: 動画に音声が入っていない", st.includes("video") && !st.includes("audio"), st);
          const mb = fs.statSync(file).size / 1048576, mbHigh = fs.statSync(files[0]).size / 1048576;
          check("画質「軽い」で動画が小さくなる（目安 2Mbps 以内）", mb < LEN * 2000000 / 8 / 1048576 * 1.3 && mb < mbHigh / 2, { light_MB: +mb.toFixed(1), high_MB: +mbHigh.toFixed(1) });
          // 出来た動画そのものが、枠どおり（下より = 上が黒・下に絵）になっている
          const top = bandBrightness(file, 3, 10), low = bandBrightness(file, 3, 1500);
          check("縦: 出来た動画が囲み枠どおりに切り取られている", top < 3 && low > 20, { top: +top.toFixed(1), low: +low.toFixed(1) });
        }
      }
    }
    console.log("FILES=" + JSON.stringify(files));
  } catch (e) {
    check("途中で止まらずに最後まで進む", false, e && e.stack ? e.stack : String(e));
  } finally {
    await browser.close();
    restoreCommon();
    // 自分が作った動画だけ消す（ユーザーの動画と同じフォルダに出るので、名前のパターンでまとめて消してはいけない）。残すなら KEEP=1
    if (!process.env.KEEP) for (const f of files) if (f && fs.existsSync(f)) fs.unlinkSync(f);
  }
  const ng = checks.filter(c => !c.ok);
  console.log(ng.length ? `E2E_FAIL (${ng.length} 件: ${ng.map(c => c.name).join(" / ")})` : `E2E_OK (${checks.length} 件)`);
  process.exit(ng.length ? 1 : 0);
})();
