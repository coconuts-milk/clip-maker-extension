// 拡張アイコンを押すとサイドパネルが開く設定になっているかを、拡張の本体（service worker）に問い合わせて確認する。
const puppeteer = require("puppeteer-core");
const path = require("path");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXT = path.resolve(__dirname, "..", "extension");

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, enableExtensions: [EXT], defaultViewport: null,
    ignoreDefaultArgs: ["--enable-automation"] });
  let ok = false;
  try {
    const t = await browser.waitForTarget(x => x.type() === "service_worker" && x.url().startsWith("chrome-extension://"), { timeout: 15000 });
    const w = await t.worker();
    await new Promise(r => setTimeout(r, 1500));
    const r = await w.evaluate(async () => ({
      behavior: await chrome.sidePanel.getPanelBehavior(),
      options: await chrome.sidePanel.getOptions({}),
      popup: await chrome.action.getPopup({}),
    }));
    console.log(JSON.stringify(r));
    ok = r.behavior.openPanelOnActionClick === true && /panel\.html$/.test(r.options.path || "") && r.popup === "";
  } catch (e) { console.log("ERROR", e && e.stack ? e.stack : e); }
  finally { await browser.close(); }
  console.log(ok ? "PANEL_OK" : "PANEL_FAIL");
  process.exit(ok ? 0 : 1);
})();
