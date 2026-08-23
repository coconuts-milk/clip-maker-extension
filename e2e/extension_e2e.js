// 拡張の実機 E2E: 本物の Chrome に拡張を読み込み、YouTube 動画ページで content.js に
// CLIP_CAPTURE を送り、clip / captions / comments が実データで返ることを確認する。
// 使い方: node e2e/extension_e2e.js [videoId]
const puppeteer = require("puppeteer-core");
const path = require("path");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXT = path.resolve(__dirname, "..", "extension");
const VIDEO = process.argv[2] || "jNQXAC9IVRw";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, enableExtensions: [EXT],
    // YouTube は headless・自動操作フラグ付きだと字幕本文を空で返す（2026-08 実測）ので、通常ブラウザと同じ条件にする
    args: ["--mute-audio", "--lang=ja", "--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("video", { timeout: 30000 });
    // 同意ダイアログが出る地域向け
    for (const sel of ['button[aria-label*="同意"]', 'button[aria-label*="Accept"]']) {
      const b = await page.$(sel); if (b) { await b.click(); break; }
    }
    await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; return v.play().catch(() => {}); });
    await new Promise(r => setTimeout(r, 4000));
    await page.evaluate(() => window.scrollBy(0, 2000));   // コメント欄を読み込ませる
    await page.waitForSelector("ytd-comment-view-model, ytd-comment-renderer", { timeout: 20000 });

    // popup と同じ経路（拡張側 → chrome.tabs.sendMessage → content.js）を service worker から叩く
    const extTarget = await browser.waitForTarget(t => t.url().startsWith("chrome-extension://"), { timeout: 15000 });
    const extId = new URL(extTarget.url()).host;
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    const result = await popup.evaluate(async (videoId) => {
      const tabs = await chrome.tabs.query({ url: "*://www.youtube.com/*" });
      const tab = tabs.find(t => t.url.includes(videoId));
      if (!tab) return { error: "YouTube タブが見つからない" };
      return chrome.tabs.sendMessage(tab.id, { type: "CLIP_CAPTURE", length: 10 });
    }, VIDEO);
    console.log(JSON.stringify(result, null, 1).slice(0, 1500));
    // 合格条件: 区間が 30 秒以内・字幕 1 件以上（実データ）・コメント 1 件以上（実データ）
    const ok = result && result.clip && result.clip.video_id === VIDEO &&
               result.clip.end_sec - result.clip.start_sec <= result.clip.max_clip_sec &&
               result.captions && result.captions.cues && result.captions.cues.length > 0 &&
               Array.isArray(result.comments) && result.comments.length > 0;
    // popup の保存ボタン経路: 実際に 3 ファイル（clip.json / srt / comments.json）がダウンロード完了するか
    // 保存先は本物と同じ「ダウンロード/clip-maker/」。CDP で downloadPath を上書きすると名前が download.json に潰れるので触らない
    await page.bringToFront();   // 本物の popup と同じく「アクティブタブ＝YouTube」にする
    await popup.evaluate(() => { document.getElementById("length").value = "10"; document.getElementById("go").click(); });
    const files = await popup.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        const items = await chrome.downloads.search({ state: "complete" });
        if (items.length >= 3) return items.map(it => it.filename);
        await new Promise(r => setTimeout(r, 300));
      }
      return [];
    });
    console.log("popup msg:", await popup.evaluate(() => document.querySelector("#msg, #ok").textContent));
    const fs = require("fs");
    const saved = files.filter(f => fs.existsSync(f) && fs.statSync(f).size > 0);
    console.log("downloaded:", saved);
    const dlOk = saved.some(f => f.endsWith(".clip.json")) && saved.some(f => f.endsWith(".srt")) && saved.some(f => f.endsWith(".comments.json"));
    if (dlOk) console.log("srt head:", fs.readFileSync(saved.find(f => f.endsWith(".srt")), "utf8").split(String.fromCharCode(10)).slice(0, 4).map(l => l.trim()).join(" | "));
    console.log(ok && dlOk ? "E2E_OK" : "E2E_FAILED");
    process.exitCode = ok && dlOk ? 0 : 1;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
