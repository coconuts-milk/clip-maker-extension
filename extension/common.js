// popup / editor / content で共有する定数とユーティリティ（同じロジックを 2 箇所に持たない）。

const MAX_CLIP_SEC = 60;   // 無料版の上限（2026-09-28: 30 → 60 秒。Shorts の上限 60 秒に合わせる）

// 出力レイアウト。landscape=元動画のまま 16:9（1920×1080）、portrait=Shorts 用 9:16（1080×1920）。
// portrait は元動画（1920×1080 基準）から crop で切り出した縦長領域を 1080×1920 に拡大する。
const VIDEO_W = 1920, VIDEO_H = 1080;              // マスク・crop 座標の基準解像度（プロ版 render は height<=1080 で取得）
const PORTRAIT_W = 1080, PORTRAIT_H = 1920;
const PORTRAIT_CROP_W = Math.round(VIDEO_H * PORTRAIT_W / PORTRAIT_H);   // 1080 高で 9:16 → 608 幅
function defaultFrame(mode) {
  if (mode === "portrait") return { mode, crop: { x: Math.round((VIDEO_W - PORTRAIT_CROP_W) / 2), y: 0, w: PORTRAIT_CROP_W, h: VIDEO_H } };
  return { mode: "landscape" };
}

// チャット焼き込みの既定（座標は出力解像度に対する % ・プロ版 core.py の build_ass と同じ意味）。
// 右上に「新しい順で最大 max 件」を積む。show_sec 秒経ったチャットは消える（0 = 消さない）。
const DEFAULT_CHAT_OVERLAY = { enabled: true, max: 5, show_sec: 8, x_pct: 62, y_pct: 6, w_pct: 36, font_pct: 3.2 };

// "5049" / "5049.5" / "1:24:09" / "24:09" を秒に変換。不正なら null、空なら undefined。
function parseTimeStr(raw) {
  const s = String(raw).trim();
  if (s === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  return (Number(m[1] || 0)) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// 秒 → "1:24:09" / "0:05" 表示（0.1 秒単位で端数があるときだけ小数を付ける）
function fmtTime(sec) {
  const t = Math.round(sec * 10) / 10;
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), r = +(t - h * 3600 - m * 60).toFixed(1);
  const rs = (r < 10 ? "0" : "") + (Number.isInteger(r) ? String(r) : r.toFixed(1));
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + rs;
}

// ---- 開始・終了・長さの 3 欄連動（popup と editor の両方で使う。②③） ----
// ルール: 最後に触った 2 つから残り 1 つを計算する。
//   長さを触った → 終了 = 開始 + 長さ　　終了を触った → 長さ = 終了 − 開始
//   開始を触った → 直前に触ったのが終了なら長さを、そうでなければ終了を再計算（長さ固定で区間をずらす方が普通の使い方）
// 返り値: { read(): {start,end,len} | 文字列エラー, set(start,end) }
function setupRangeControl(startEl, endEl, lenEl, onChange) {
  let lastTouched = "len";
  const num = el => parseTimeStr(el.value);
  const fromLen = () => {
    const s = num(startEl), l = Number(lenEl.value);
    if (Number.isFinite(s) && l > 0) endEl.value = fmtTime(s + l);
  };
  const fromEnd = () => {
    const s = num(startEl), e = num(endEl);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) lenEl.value = String(Math.round((e - s) * 10) / 10);
  };
  const fire = () => { if (onChange) onChange(); };
  lenEl.addEventListener("input", () => { lastTouched = "len"; fromLen(); fire(); });
  endEl.addEventListener("input", () => { lastTouched = "end"; fromEnd(); fire(); });
  startEl.addEventListener("input", () => {
    if (lastTouched === "end" && endEl.value) fromEnd(); else if (lenEl.value) fromLen(); else fromEnd();
    fire();
  });
  return {
    // 検証済みの {start, end, len} を返す。不正はメッセージ文字列を throw。
    read() {
      const s = num(startEl), e = num(endEl);
      if (s === null) throw "開始時間は「1:24:09」か「5049」（秒）の形式で入れてください";
      if (e === null) throw "終了時間は「1:24:25」か「5065」（秒）の形式で入れてください";
      if (s === undefined) throw "開始時間を入れてください（▶ 今の位置 で今の再生位置が入ります）";
      let end = e;
      if (end === undefined) {
        const l = Number(lenEl.value);
        if (!(l > 0)) throw "終了時間か長さのどちらかを入れてください";
        end = s + l;
      }
      if (end <= s) throw `終了(${fmtTime(end)}) は開始(${fmtTime(s)}) より後にしてください`;
      if (end - s > MAX_CLIP_SEC) throw `長さ ${(end - s).toFixed(1)} 秒が無料版の上限 ${MAX_CLIP_SEC} 秒を超えています`;
      return { start: s, end, len: end - s };
    },
    // 開始だけ差し替え（▶ 今の位置）。長さがあれば長さ固定で終了をずらす。
    setStart(t) { startEl.value = fmtTime(t); lastTouched = "start"; if (lenEl.value) fromLen(); else fromEnd(); fire(); },
    // 終了だけ差し替え（▶ 今の位置）。開始が無ければ終了−長さ（または 15 秒）を開始にする。
    setEnd(t) {
      endEl.value = fmtTime(t); lastTouched = "end";
      if (num(startEl) === undefined) startEl.value = fmtTime(Math.max(0, t - (Number(lenEl.value) || 15)));
      fromEnd(); fire();
    },
    set(start, end) { startEl.value = fmtTime(start); endEl.value = fmtTime(end); lastTouched = "end"; fromEnd(); fire(); },
  };
}

// 旧バージョン検出時の案内文（「パッケージ化されていない拡張」はファイルを差し替えても
// 🔄を押すまで YouTube タブ側が旧版のまま動く）。
function verErrorMsg(pageVer) {
  return `旧バージョンの部品が動いています（ページ側 ${pageVer || "不明（旧版）"} / 本体 ${chrome.runtime.getManifest().version}）。\n` +
         "chrome://extensions を開いて Clip Maker の更新（🔄）ボタンを押してから、もう一度お試しください（YouTube タブの再読み込みは不要）。";
}

// タブの content script へメッセージを送る。生きた content script が無いタブ
// （拡張を入れる前から開いていた／拡張リロード直後）には inject.js(MAIN)+common.js+content.js を
// その場で注入して 1 回だけ再試行する。応答 undefined（🔄前の旧版がこのメッセージ種別を知らず
// 無応答＝2026-08-28 実機で発生）も同じ扱いにする。popup と editor の両方がこれを使う。
async function messageWithInject(tabId, req) {
  let r;
  try { r = await chrome.tabs.sendMessage(tabId, req); } catch (_) { r = undefined; }
  if (r !== undefined) return r;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["inject.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["common.js", "content.js"] });
    r = await chrome.tabs.sendMessage(tabId, req);
  } catch (_2) { throw "ページと通信できません。YouTube のタブを再読み込み（F5）してからもう一度お試しください。"; }
  if (r === undefined) throw verErrorMsg(undefined);   // 注入後も無応答＝旧版 listener しか居ない
  return r;
}

// content script の応答を検証する。error はそのまま投げ、旧バージョンの部品が動いていたら🔄を案内する。
function assertVer(r) {
  if (r === undefined || r === null) throw verErrorMsg(undefined);
  if (r.error) throw r.error;
  if (r.ver !== chrome.runtime.getManifest().version) throw verErrorMsg(r.ver);
  return r;
}
