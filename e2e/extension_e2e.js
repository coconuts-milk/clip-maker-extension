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

async function waitVideoFile(since, tag, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(OUT)) {
      const hit = fs.readdirSync(OUT)
        .filter(n => n.startsWith(`clip_${VIDEO}_`) && n.includes(tag) && /\.(mp4|webm)$/.test(n))
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
    await panel.setViewport({ width: 360, height: 640 });   // サイドパネルの実際の幅で確認する
    await panel.goto(`chrome-extension://${extId}/panel.html`);
    await sleep(2500);
    const p1 = await panel.evaluate(() => {
      const vals = id => [...document.querySelectorAll(`#${id} input`)].map(e => e.value);
      return { start: vals("start"), end: vals("end"), len: document.getElementById("length").value, msg: document.getElementById("msg").textContent };
    });
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
    check("パネル: 幅 360 に横並びで収まる", fits);

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

    // 5) プレビュー再生
    await editor.evaluate(() => document.getElementById("play").click());
    await sleep(2500);
    const pvT = await editor.evaluate(() => Number(document.getElementById("pvtime").value));
    await editor.evaluate(() => document.getElementById("play").click());
    check("プレビューを再生すると時間が進む", pvT > 1.5, pvT);
    // コメントが流れている最中の時刻にして見た目を撮る（最初のコメントの 2 秒後）
    const firstChat = await editor.evaluate(async () => { const m = (await chrome.storage.local.get("draft")).draft.chat.messages; return m.length ? m[0].t : 2; });
    await editor.evaluate(t => { const s = document.getElementById("pvtime"); s.value = t; s.dispatchEvent(new Event("input")); }, Math.min(LEN - 0.5, firstChat + 2));
    await editor.screenshot({ path: path.join(SHOTS, "editor_yoko.png"), fullPage: true });

    // 6) 動画を作る（横 → 縦）。録画中は YouTube タブに表示が出る
    for (const mode of ["landscape", "portrait"]) {
      await editor.bringToFront();
      await editor.evaluate(m => document.querySelector(`input[name=mode][value=${m}]`).click(), mode);
      if (mode === "portrait") {
        // 動画を上に寄せ、下の黒い所に字幕を置く
        await editor.evaluate(() => {
          document.querySelector("input[name=valign][value=top]").click();
          const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input")); e.dispatchEvent(new Event("change")); };
          set("zoom", 1.6); set("cap_bottom", 60);
        });
        await sleep(300);
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
      const file = await waitVideoFile(since, mode === "portrait" ? "tate" : "yoko", (LEN + 60) * 1000);
      await sleep(1000);
      const msg = await editor.evaluate(() => document.getElementById("msg").textContent);
      check(`動画ファイルができる（${mode}）`, !!file, `${file} / ${msg.replace(/\n/g, " ")}`);
      const bannerGone = await page.evaluate(() => !document.getElementById("clip-maker-rec"));
      check(`録画が終わったら表示が消える（${mode}）`, bannerGone);
      files.push(file);
    }
    console.log("FILES=" + JSON.stringify(files));
  } catch (e) {
    check("途中で止まらずに最後まで進む", false, e && e.stack ? e.stack : String(e));
  } finally {
    await browser.close();
  }
  const ng = checks.filter(c => !c.ok);
  console.log(ng.length ? `E2E_FAIL (${ng.length} 件: ${ng.map(c => c.name).join(" / ")})` : `E2E_OK (${checks.length} 件)`);
  process.exit(ng.length ? 1 : 0);
})();
