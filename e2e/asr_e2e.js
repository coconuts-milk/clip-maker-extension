// 音声認識の実機確認: パネルで「音声認識」を選んで吸い出し → 音声の取り込み → 編集画面で認識 → 字幕の行が入る。
// 認識モデルは初回にダウンロードされる（数百 MB）。2 回目以降はブラウザの保存領域（e2e/.profile）から読むので速い。
// 使い方: node e2e/asr_e2e.js [videoId] [start秒] [length秒] [small|turbo] [wasm]
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXT = path.resolve(__dirname, "..", "extension");
const PROFILE = process.env.PROFILE || path.join(__dirname, ".profile");   // PROFILE=別フォルダ で「初回」の状態を再現できる
const VIDEO = process.argv[2] || "JnKgfHO_UbU";
const START = process.argv[3] !== undefined ? Number(process.argv[3]) : 1880;
const LEN = process.argv[4] !== undefined ? Number(process.argv[4]) : 14;
const MODEL = process.argv[5] || "small";
const DEVICE = process.argv[6] || "";   // "wasm" で CPU を強制（GPU の無い PC の確認）
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok }); console.log(`${ok ? "OK " : "NG "} ${name}${detail !== undefined ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); };

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, enableExtensions: [EXT], userDataDir: PROFILE,
    args: ["--lang=ja", "--disable-blink-features=AutomationControlled", "--window-size=1600,1000"],
    ignoreDefaultArgs: ["--enable-automation"], defaultViewport: null,
  });
  try {
    const page = await browser.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${VIDEO}&t=${Math.floor(START)}s`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("video", { timeout: 30000 });
    await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; return v.play().catch(() => {}); });
    await sleep(5000);
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
    await panel.setViewport({ width: 360, height: 640 });
    await panel.goto(`chrome-extension://${extId}/panel.html`);
    await sleep(2000);
    await panel.evaluate(async (len, model, device) => {
      await chrome.storage.local.set({ asrModel: model, asrForceDevice: device });   // 編集画面は開いたときにこの設定で認識を始める
      const $ = id => document.getElementById(id);
      $("length").value = String(len); $("length").dispatchEvent(new Event("input"));
      document.querySelector("input[name=subsrc][value=asr]").click();
    }, LEN, MODEL, DEVICE);
    check("パネル: 字幕の作り方を選べる", await panel.evaluate(() => document.querySelector("input[name=subsrc][value=asr]").checked));
    // 音声認識を選んだ時点で認識モデルの取得が始まり、取得済みになる（編集画面に入る前）
    let stat = "", lastStat = "";
    for (let i = 0; i < 1200; i++) {
      await sleep(500);
      stat = await panel.evaluate(() => document.getElementById("modelstat").textContent);
      if (stat !== lastStat) { console.log("  パネル: " + stat); lastStat = stat; }
      if (stat.includes("取得済み") || stat.includes("できませんでした")) break;
    }
    check("パネルで音声認識を選ぶと、その場で認識モデルが取得される", stat.includes("取得済み"), stat);

    await page.bringToFront();
    const tGo = Date.now();
    await panel.evaluate(() => document.getElementById("go").click());
    // 音声の取り込み中は YouTube のタブに表示が出る
    let banner = null;
    for (let i = 0; i < 60 && !banner; i++) { await sleep(250); banner = await page.evaluate(() => { const b = document.getElementById("clip-maker-rec"); return b ? b.textContent : null; }); }
    check("音声の取り込み中の表示が出る", banner && banner.includes("字幕用の音声を取り込み中"), banner);
    const edTarget = await browser.waitForTarget(t => t.url().includes("/editor.html"), { timeout: (LEN + 90) * 1000 });
    const editor = await edTarget.page();
    await editor.bringToFront();
    const a = await editor.evaluate(async () => {
      const d = (await chrome.storage.local.get("draft")).draft;
      // 取り込んだ音声の音量（無音になっていないか）。pcm16 の二乗平均平方根を 0〜1 で
      const bin = atob(d.audio.pcm16), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const i16 = new Int16Array(bytes.buffer);
      let sum = 0, peak = 0;
      for (let i = 0; i < i16.length; i++) { const v = i16[i] / 32768; sum += v * v; peak = Math.max(peak, Math.abs(v)); }
      return { sec: d.audio.sec, rate: d.audio.rate, len: d.audio.pcm16.length, yt: d.captions.cues.length, title: d.clip.title.slice(0, 40), rms: +Math.sqrt(sum / i16.length).toFixed(4), peak: +peak.toFixed(3) };
    });
    check("音声が取り込めている（長さが切り抜きと同じ）", a.rate === 16000 && Math.abs(a.sec - LEN) < 1.0, a);
    check("取り込んだ音声が無音ではない", a.rms > 0.005 && a.peak > 0.05, { rms: a.rms, peak: a.peak });
    console.log("  取り込みにかかった時間:", ((Date.now() - tGo) / 1000).toFixed(1), "秒");

    // 編集画面を開くと、パネルで選んだ設定で認識が始まる
    const t0 = Date.now();
    let note = "", last = "", sawDownload = false;
    for (let i = 0; i < 1200; i++) {   // 最長 10 分（初回のダウンロード込み）
      await sleep(500);
      const s = await editor.evaluate(() => ({ note: document.getElementById("asrnote").textContent, err: document.getElementById("cuesmsg").textContent, dev: document.getElementById("asrdev").textContent }));
      note = s.note;
      if (note !== last) { console.log("  " + s.dev + " / " + note); last = note; }
      if (note.includes("ダウンロード中")) sawDownload = true;
      if (s.err.includes("失敗")) { check("認識が最後まで進む", false, s.err); break; }
      if (note.startsWith("認識しました")) break;
    }
    check("編集画面ではダウンロードし直さない（保存済みのモデルを読み込む）", !sawDownload, sawDownload ? "ダウンロード中の表示が出た" : "");
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const res = await editor.evaluate(async () => { const d = (await chrome.storage.local.get("draft")).draft; return { source: d.captions.source, model: d.captions.model, cues: d.captions.cues }; });
    check("認識結果が字幕に入る", res.source === "asr" && res.cues.length > 0, { model: res.model, rows: res.cues.length, elapsed_s: elapsed });
    for (const c of res.cues) console.log(`  ${c.start.toFixed(2).padStart(6)} - ${c.end.toFixed(2).padStart(6)}  ${c.text}`);
    const inRange = res.cues.every(c => c.start >= 0 && c.end <= LEN + 0.01 && c.end > c.start);
    check("字幕の時刻が切り抜きの中に収まっている", inRange);
    await editor.screenshot({ path: path.join(__dirname, "shots", "editor_asr.png"), fullPage: true });
  } catch (e) {
    check("途中で止まらずに最後まで進む", false, e && e.stack ? e.stack : String(e));
  } finally {
    await browser.close();
  }
  const ng = checks.filter(c => !c.ok);
  console.log(ng.length ? `ASR_FAIL (${ng.length} 件: ${ng.map(c => c.name).join(" / ")})` : `ASR_OK (${checks.length} 件)`);
  process.exit(ng.length ? 1 : 0);
})();
