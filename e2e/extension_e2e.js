// 拡張の実機 E2E: 本物の Chrome に拡張を読み込み、YouTube 動画ページで
//   吸い出し → 編集画面でマスクをドラッグ → プレビュー再生 → 「④ 動画を作る」→ ダウンロードに動画ファイルが出る
// までを通す（横 → 縦の順に 2 本）。拡張だけで動画ができることの確認。
// 使い方: node e2e/extension_e2e.js [videoId] [start秒] [length秒]
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXT = path.resolve(__dirname, "..", "extension");
const VIDEO = process.argv[2] || "jNQXAC9IVRw";
const START = process.argv[3] !== undefined ? Number(process.argv[3]) : 2;   // 動画内の絶対秒
const LEN = process.argv[4] !== undefined ? Number(process.argv[4]) : 6;
const DOWNLOADS = path.join(os.homedir(), "Downloads", "clip-maker");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ダウンロードフォルダに since 以降に出来た clip_<VIDEO>_* を待つ（.crdownload は書きかけなので除外）
async function waitVideoFile(since, tag, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = fs.readdirSync(DOWNLOADS)
      .filter(n => n.startsWith(`clip_${VIDEO}_`) && n.includes(tag) && /\.(mp4|webm)$/.test(n))
      .map(n => path.join(DOWNLOADS, n))
      .filter(p => fs.statSync(p).mtimeMs >= since && fs.statSync(p).size > 0);
    if (hit.length) return hit.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    await sleep(500);
  }
  return null;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, enableExtensions: [EXT],
    // YouTube は headless・自動操作フラグ付きだと字幕本文を空で返す（2026-08 実測）ので、通常ブラウザと同じ条件にする
    args: ["--mute-audio", "--lang=ja", "--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
    defaultViewport: null,
  });
  let ok = false;
  try {
    const page = await browser.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${VIDEO}&t=${Math.floor(START)}s`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("video", { timeout: 30000 });
    for (const sel of ['button[aria-label*="同意"]', 'button[aria-label*="Accept"]']) {
      const b = await page.$(sel); if (b) { await b.click(); break; }
    }
    await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; return v.play().catch(() => {}); });
    await sleep(4000);
    await page.evaluate(() => { const b = document.querySelector(".ytp-subtitles-button"); if (b && b.getAttribute("aria-pressed") !== "true") b.click(); });
    await sleep(4000);
    await page.evaluate(() => document.querySelector("video").pause());

    const extTarget = await browser.waitForTarget(t => t.url().startsWith("chrome-extension://"), { timeout: 15000 });
    const extId = new URL(extTarget.url()).host;
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await sleep(500);

    // popup: 開始を入れる → 長さを入れると終了が追随する（3 欄連動）
    const sync = await popup.evaluate((start, len) => {
      const $ = id => document.getElementById(id);
      const set = (id, v) => { $(id).value = String(v); $(id).dispatchEvent(new Event("input")); };
      set("start", start); set("length", len);
      const endFromLen = $("end").value;
      set("end", start + len + 2);            // 終了を変えると長さが追随
      const lenFromEnd = $("length").value;
      set("length", len);                      // 戻す
      return { endFromLen, lenFromEnd, rangeview: $("rangeview").textContent, nowstart: !!$("nowstart"), nowend: !!$("nowend") };
    }, START, LEN);
    console.log("popup 3欄連動:", JSON.stringify(sync));

    // popup.js は「アクティブタブ」を見るため、自動操作では同じ処理を直接呼ぶ（経路は同じ messageWithInject → content.js）
    const cap = await popup.evaluate(async (videoId, start, len) => {
      const tabs = await chrome.tabs.query({ url: "*://www.youtube.com/*" });
      const tab = tabs.find(t => t.url.includes(videoId));
      if (!tab) return { error: "YouTube タブが見つからない" };
      const r = assertVer(await messageWithInject(tab.id, { type: "CLIP_CAPTURE", start, end: start + len, withFrames: true }));
      const clip = { ...r.clip, masks: [], frame: defaultFrame("landscape"), chat_overlay: { ...DEFAULT_CHAT_OVERLAY } };
      // チャットリプレイや字幕の無い動画でも描画を確認できるよう、取れなかったときだけ試験用データを入れる
      const chat = r.chat.messages.length ? r.chat : { messages: [{ t: 1, author: "e2e", text: "テストコメント" }, { t: 2, author: "e2e", text: "スパチャ", amount: "¥500" }] };
      const captions = r.captions.cues.length ? r.captions : { cues: [{ start: 0.5, end: len - 0.5, text: "字幕のテストです" }] };
      await chrome.storage.local.set({ draft: { clip, captions, chat, frames: r.frames } });
      return { clip: r.clip, cues: r.captions.cues.length, capErr: r.captions.error, chat: r.chat.messages.length, chatErr: r.chat.error,
               frames: r.frames && r.frames.list ? r.frames.list.length : (r.frames && r.frames.error) };
    }, VIDEO, START, LEN);
    console.log("吸い出し:", JSON.stringify(cap));
    if (cap.error) throw new Error(cap.error);

    const editor = await browser.newPage();
    await editor.goto(`chrome-extension://${extId}/editor.html`);
    await editor.waitForSelector("#overlay", { timeout: 10000 });
    await editor.waitForFunction(() => { const i = document.getElementById("frame"); return i && i.naturalWidth > 0; }, { timeout: 20000 });

    // 隠す四角: 元画面の右上をドラッグ
    const box = await (await editor.$("#overlay")).boundingBox();
    await editor.mouse.move(box.x + box.width * 0.70, box.y + box.height * 0.05);
    await editor.mouse.down();
    await editor.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.25, { steps: 5 });
    await editor.mouse.up();
    const maskRows = await editor.evaluate(() => document.querySelectorAll("#masks tbody tr").length);
    const outMasks = await editor.evaluate(() => document.querySelectorAll("#outmasks .outmask").length);
    console.log("隠す四角: 表", maskRows, "行 / 出来上がりプレビュー上", outMasks, "個");

    // プレビュー: 再生ボタンで時間が進み、字幕・チャットが出る
    await editor.evaluate(() => document.getElementById("play").click());
    await sleep(2500);
    const pv = await editor.evaluate(() => ({
      t: Number(document.getElementById("pvtime").value),
      cue: document.getElementById("cueband").textContent.trim(),
      chat: document.querySelectorAll("#chatbox .cm").length,
    }));
    await editor.evaluate(() => document.getElementById("play").click());
    console.log("プレビュー再生:", JSON.stringify(pv));
    await editor.screenshot({ path: path.join(__dirname, "editor_screenshot.png"), fullPage: true });

    // ④ 動画を作る（横 → 縦）
    const files = [];
    for (const mode of ["landscape", "portrait"]) {
      await editor.bringToFront();
      await editor.evaluate(m => document.querySelector(`input[name=mode][value=${m}]`).click(), mode);
      const since = Date.now() - 1000;
      await editor.evaluate(() => document.getElementById("save").click());
      const file = await waitVideoFile(since, mode === "portrait" ? "tate" : "yoko", (LEN + 40) * 1000);
      await sleep(1500);
      const msg = await editor.evaluate(() => document.getElementById("msg").textContent);
      console.log(`動画を作る(${mode}):`, file || "ファイルが出ない", "/", msg.replace(/\n/g, " "));
      files.push(file);
    }

    ok = maskRows === 1 && outMasks === 1 && pv.t > 1 && files.every(Boolean);
    console.log("FILES=" + JSON.stringify(files));
    console.log(ok ? "E2E_OK" : "E2E_FAIL");
  } catch (e) {
    console.log("E2E_ERROR", e && e.stack ? e.stack : e);
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})();
