// 拡張の実機 E2E: 本物の Chrome に拡張を読み込み、YouTube 動画ページで content.js に
// CLIP_CAPTURE を送り、clip / captions / chat（チャットリプレイ）が実データで返ることを確認する。
// さらに 2 段階フロー本線（popup → 編集画面タブ → マスクをドラッグ描画 → 3 ファイル保存）を通す。
// 使い方: node e2e/extension_e2e.js [videoId] [start秒] [length秒]
const puppeteer = require("puppeteer-core");
const path = require("path");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXT = path.resolve(__dirname, "..", "extension");
const VIDEO = process.argv[2] || "jNQXAC9IVRw";
const START = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;   // 動画内の絶対秒
const LEN = process.argv[4] !== undefined ? Number(process.argv[4]) : 10;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, enableExtensions: [EXT],
    // YouTube は headless・自動操作フラグ付きだと字幕本文を空で返す（2026-08 実測）ので、通常ブラウザと同じ条件にする
    args: ["--mute-audio", "--lang=ja", "--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  try {
    const page = await browser.newPage();
    const tParam = START !== undefined ? `&t=${Math.floor(START)}s` : "";   // 該当区間の字幕をプレーヤーに読み込ませる
    await page.goto(`https://www.youtube.com/watch?v=${VIDEO}${tParam}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("video", { timeout: 30000 });
    // 同意ダイアログが出る地域向け
    for (const sel of ['button[aria-label*="同意"]', 'button[aria-label*="Accept"]']) {
      const b = await page.$(sel); if (b) { await b.click(); break; }
    }
    await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; return v.play().catch(() => {}); });
    await new Promise(r => setTimeout(r, 4000));
    // チャットリプレイは content.js（collectChat）が自前で開いて同期待ちするのでページ側の仕込みは不要。
    // 字幕はプレーヤー初期化直後だと CC ON でも timedtext を取りに行かないことがある（実測フレーキー）
    // → 先にページ側で CC を入れて取得を済ませておく
    await page.evaluate(() => { const b = document.querySelector(".ytp-subtitles-button"); if (b && b.getAttribute("aria-pressed") !== "true") b.click(); });
    await new Promise(r => setTimeout(r, 5000));

    // popup と同じ経路（拡張側 → chrome.tabs.sendMessage → content.js）を service worker から叩く
    const extTarget = await browser.waitForTarget(t => t.url().startsWith("chrome-extension://"), { timeout: 15000 });
    const extId = new URL(extTarget.url()).host;
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    // 字幕は本物のユーザーも「CC を押してもう一度」で回復する運用（popup の案内文どおり）→ E2E も同じく数回やり直す
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await popup.evaluate(async (videoId, start, len) => {
        const tabs = await chrome.tabs.query({ url: "*://www.youtube.com/*" });
        const tab = tabs.find(t => t.url.includes(videoId));
        if (!tab) return { error: "YouTube タブが見つからない" };
        return chrome.tabs.sendMessage(tab.id, { type: "CLIP_CAPTURE", start, length: len });
      }, VIDEO, START, LEN);
      if (result && result.captions && result.captions.cues && result.captions.cues.length > 0) break;
      console.log(`captions empty (attempt ${attempt}): ${result && result.captions ? result.captions.error || "" : "no result"}`);
      await new Promise(r => setTimeout(r, 4000));
    }
    console.log(JSON.stringify(result, null, 1).slice(0, 1500));
    // 合格条件: 区間が 30 秒以内・字幕 1 件以上（実データ）・チャット 1 件以上（実データ・チャットリプレイ）
    const ok = result && result.clip && result.clip.video_id === VIDEO &&
               result.clip.end_sec - result.clip.start_sec <= result.clip.max_clip_sec &&
               result.captions && result.captions.cues && result.captions.cues.length > 0 &&
               result.chat && Array.isArray(result.chat.messages) && result.chat.messages.length > 0;
    if (result && result.chat && result.chat.error) console.log("chat error:", result.chat.error);
    // 2 段階フロー本線: popup「吸い出して編集画面を開く」→ 編集タブでマスクをドラッグ描画 → 保存 → 3 ファイル
    // 保存先は本物と同じ「ダウンロード/clip-maker/」。CDP で downloadPath を上書きすると名前が download.json に潰れるので触らない
    const before = await popup.evaluate(async () => (await chrome.downloads.search({ state: "complete" })).length);
    await page.bringToFront();   // 本物の popup と同じく「アクティブタブ＝YouTube」にする
    await popup.evaluate((start, len) => {
      if (start !== undefined && start !== null) document.getElementById("start").value = String(start);
      document.getElementById("length").value = String(len);
      document.getElementById("go").click();
    }, START === undefined ? null : START, LEN);
    const edTarget = await browser.waitForTarget(t => t.url().includes("/editor.html"), { timeout: 15000 });
    const editor = await edTarget.page();
    await editor.bringToFront();
    await editor.waitForSelector("#overlay", { timeout: 10000 });
    // プレビュー（実際のコマ画像）が読み込まれるまで待つ（iframe 埋め込みはエラー 153 で使えないため画像方式）
    await editor.waitForFunction(() => {
      const i = document.getElementById("frame");
      return i && i.naturalWidth > 0;
    }, { timeout: 20000 });
    const frameBtns = await editor.evaluate(() => document.querySelectorAll("#framebtns button").length);
    const startDisp = await editor.evaluate(() => document.getElementById("start_sec").value);
    console.log("frame buttons:", frameBtns, "/ start display:", startDisp);
    // 右上にマスクを 1 個ドラッグで描く（スパチャ名エリア相当・描画モード切替は廃止＝常時ドラッグ可）
    const box = await (await editor.$("#overlay")).boundingBox();
    await editor.mouse.move(box.x + box.width * 0.70, box.y + box.height * 0.05);
    await editor.mouse.down();
    await editor.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.17, { steps: 5 });
    await editor.mouse.up();
    const maskRows = await editor.evaluate(() => document.querySelectorAll("#masks tbody tr").length);
    await editor.screenshot({ path: path.join(__dirname, "editor_screenshot.png"), fullPage: true });   // 見た目確認用
    await editor.click("#save");
    const files = await editor.evaluate(async (before) => {
      for (let i = 0; i < 50; i++) {
        const items = await chrome.downloads.search({ state: "complete" });
        if (items.length >= before + 3) return items.map(it => it.filename);
        await new Promise(r => setTimeout(r, 300));
      }
      return [];
    }, before);
    console.log("editor msg:", await editor.evaluate(() => document.getElementById("msg").textContent));
    const fs = require("fs");
    // downloads.search が complete を返してもディスクへの書き出しが一瞬遅れることがある（実測でフレーキー）→ リトライ
    let saved = [];
    for (let i = 0; i < 20 && saved.length < 3; i++) {
      saved = files.filter(f => fs.existsSync(f) && fs.statSync(f).size > 0);
      if (saved.length < 3) await new Promise(r => setTimeout(r, 300));
    }
    console.log("downloaded:", saved);
    // 同名ファイルが既にあると Chrome が「name (1).ext」にリネームするので endsWith では判定しない
    const dlOk = saved.some(f => /\.clip[^\\]*\.json$/.test(f)) && saved.some(f => /\.srt$/.test(f)) && saved.some(f => /\.chat[^\\]*\.json$/.test(f));
    let maskOk = false;
    if (dlOk) {
      // 最新の clip.json にドラッグしたマスクが入っているか
      const clips = saved.filter(f => /\.clip[^\\]*\.json$/.test(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      const clip = JSON.parse(fs.readFileSync(clips[0], "utf8"));
      maskOk = Array.isArray(clip.masks) && clip.masks.length === 1 && clip.masks[0].w > 0 && clip.masks[0].h > 0;
      console.log("masks in clip.json:", JSON.stringify(clip.masks));
      console.log("srt head:", fs.readFileSync(saved.find(f => f.endsWith(".srt")), "utf8").split(String.fromCharCode(10)).slice(0, 4).map(l => l.trim()).join(" | "));
    }
    console.log("mask rows in editor:", maskRows);
    // frameOk: コマ 3 枚のボタンが出て、開始時刻が「1:24:09」形式（コロン入り）で表示されている
    const frameOk = frameBtns === 3 && /:/.test(startDisp);
    const pass = ok && dlOk && maskOk && maskRows === 1 && frameOk;
    console.log(pass ? "E2E_OK" : "E2E_FAILED");
    process.exitCode = pass ? 0 : 1;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
