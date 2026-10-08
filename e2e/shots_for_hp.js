// HP 掲載用のスクリーンショットを撮る（自分の動画で撮り直せるように、動画 ID と時間を引数で渡す）。
//   node e2e/shots_for_hp.js <videoId> <start秒> <length秒> [出力フォルダ]
// 出来るもの（幅 1280px）: panel.png（パネル）、editor.png（横の編集画面）、editor_short.png（縦）、recording.png（録画中の YouTube）
// 隠す四角は作らない。字幕は YouTube の字幕、コメントは流す設定のまま。
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXT = path.resolve(__dirname, "..", "extension");
const VIDEO = process.argv[2], START = Number(process.argv[3]), LEN = Number(process.argv[4] || 20);
const OUT = path.resolve(process.argv[5] || path.join(__dirname, "..", "..", "chatani-moka-site", "img", "clip-maker"));
if (!VIDEO || !Number.isFinite(START)) { console.log("使い方: node e2e/shots_for_hp.js <videoId> <start秒> <length秒> [出力フォルダ]"); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, enableExtensions: [EXT],
    args: ["--mute-audio", "--lang=ja", "--disable-blink-features=AutomationControlled", "--window-size=1600,1000"],
    ignoreDefaultArgs: ["--enable-automation"], defaultViewport: null,
  });
  const files = [];
  try {
    const page = await browser.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${VIDEO}&t=${Math.floor(START)}s`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("video", { timeout: 30000 });
    await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; return v.play().catch(() => {}); });
    await sleep(4000);
    await page.evaluate(() => { const b = document.querySelector(".ytp-subtitles-button"); if (b && b.getAttribute("aria-pressed") !== "true") b.click(); });
    await sleep(3000);
    await page.evaluate(t => { const v = document.querySelector("video"); v.pause(); v.currentTime = t; }, START);
    await sleep(1500);

    const extTarget = await browser.waitForTarget(t => t.url().startsWith("chrome-extension://"), { timeout: 15000 });
    const extId = new URL(extTarget.url()).host;
    const panel = await browser.newPage();
    await panel.evaluateOnNewDocument(videoId => {
      const orig = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async q => {
        if (q && q.active) { const all = await orig({ url: "*://www.youtube.com/*" }); return all.filter(t => t.url.includes(videoId)); }
        return orig(q);
      };
    }, VIDEO);
    await panel.setViewport({ width: 360, height: 520 });
    await panel.goto(`chrome-extension://${extId}/panel.html`);
    await sleep(2000);
    await panel.evaluate(len => {
      const $ = id => document.getElementById(id);
      $("length").value = String(len); $("length").dispatchEvent(new Event("input"));
      document.querySelector("input[name=subsrc][value=youtube]").click();
      document.getElementById("msg").textContent = "";
    }, LEN);
    await panel.screenshot({ path: path.join(OUT, "panel.png") });
    files.push("panel.png");

    await page.bringToFront();
    await panel.evaluate(() => document.getElementById("go").click());
    const edTarget = await browser.waitForTarget(t => t.url().includes("/editor.html"), { timeout: 120000 });
    const editor = await edTarget.page();
    await editor.setViewport({ width: 1280, height: 860 });
    await editor.bringToFront();
    await editor.waitForSelector("#ov", { timeout: 10000 });
    await editor.waitForFunction(() => document.getElementById("pvtimedisp").textContent.includes("/"), { timeout: 20000 });
    await sleep(800);
    // コメントが流れている時刻（最初のコメントの 2 秒後）か、字幕のある時刻にする
    const t = await editor.evaluate(async len => {
      const d = (await chrome.storage.local.get("draft")).draft;
      const m = d.chat.messages[0], c = d.captions.cues[0];
      return Math.min(len - 0.5, m ? m.t + 2 : c ? (c.start + c.end) / 2 : 2);
    }, LEN);
    await editor.evaluate(t => { const s = document.getElementById("pvtime"); s.value = t; s.dispatchEvent(new Event("input")); }, t);
    await sleep(300);
    await editor.screenshot({ path: path.join(OUT, "editor.png") });
    files.push("editor.png");

    await editor.evaluate(() => document.querySelector("input[name=mode][value=portrait]").click());
    await sleep(600);
    await editor.screenshot({ path: path.join(OUT, "editor_short.png") });
    files.push("editor_short.png");
    await editor.evaluate(() => document.querySelector("input[name=mode][value=landscape]").click());

    // 録画中の YouTube（録画は最後まで行かせず、表示が出た所で撮って止める）
    await editor.evaluate(() => document.getElementById("save").click());
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if (await page.evaluate(() => !!document.getElementById("clip-maker-rec"))) break;
    }
    await sleep(1500);
    await page.setViewport({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(OUT, "recording.png") });
    files.push("recording.png");
    // 録画が終わるのを待ってから閉じる（途中で閉じると YouTube 側の状態が戻らない）
    await sleep((LEN + 8) * 1000);
    // 撮影のために作った動画は消す
    const dl = path.join(require("os").homedir(), "Downloads", "clip-maker");
    if (fs.existsSync(dl)) for (const n of fs.readdirSync(dl)) {
      const p = path.join(dl, n);
      if (/^\d{8}_\d{6}_(horizon|short)_sound_(on|off)\.mp4$/.test(n) && Date.now() - fs.statSync(p).mtimeMs < (LEN + 60) * 1000) fs.unlinkSync(p);
    }
  } catch (e) {
    console.log("ERROR", e && e.stack ? e.stack : String(e));
  } finally {
    await browser.close();
  }
  console.log("出力:", OUT);
  for (const f of files) console.log("  " + f);
})();
