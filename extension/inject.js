// Clip Maker main-world script — ページ側（YouTube プレーヤーと同じ世界）で動く。
//  1) プレーヤーが自分で取りに行く字幕（/api/timedtext）の応答を横取りして動画 ID ごとに保持する。
//     拡張から timedtext URL を直接 fetch すると pot トークンが無く 200・空が返る（2026-08 実測）ため、プレーヤーの通信を使う。
//  2) content.js からの依頼（今の動画の情報・字幕本文）に答える。
//     「今の動画」は必ずプレーヤー API から取る。ページ埋め込みの ytInitialPlayerResponse は YouTube 内で
//     ページ移動（再読み込みなし）すると前の動画のままになり、字幕のある動画を「字幕なし」と誤判定する（2026-09-29 実機で再現）。
(() => {
  if (window.__clipMakerInject === 2) return;   // 二重注入（拡張の再読み込み後に executeScript で再注入される）を防ぐ
  window.__clipMakerInject = 2;

  const REQ = "clip-maker-req", RES = "clip-maker-res";
  const WAIT_MS = 8000;       // 字幕の読み直しを頼んでからプレーヤーが取りに行くまでの待ち上限
  const POLL_MS = 200;
  const KEEP = 4;             // 保持する動画数（タブを開きっぱなしで動画を渡り歩いてもメモリを食い続けない）
  const captured = new Map(); // videoId → {url, body}

  const isTimedText = u => typeof u === "string" && u.includes("/api/timedtext");
  const videoOf = url => { try { return new URL(url, location.href).searchParams.get("v"); } catch (_) { return null; } };
  function remember(url, body) {
    if (!body) return;
    const v = videoOf(url);
    if (!v) return;
    captured.delete(v);
    captured.set(v, { url, body });
    while (captured.size > KEEP) captured.delete(captured.keys().next().value);
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.call(this, input, init);
    const url = typeof input === "string" ? input : (input && input.url);
    if (isTimedText(url)) res.clone().text().then(t => remember(url, t)).catch(() => {});
    return res;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isTimedText(url)) this.addEventListener("load", () => { try { remember(url, this.responseText); } catch (_) { /* responseType が text 以外 */ } });
    return origOpen.call(this, method, url, ...rest);
  };

  const player = () => document.getElementById("movie_player");
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function currentVideo() {
    const p = player();
    let id = null, title = "";
    try { const d = p.getVideoData(); id = d.video_id; title = d.title || ""; } catch (_) { /* プレーヤー未初期化 */ }
    if (!id) {
      const u = new URL(location.href);
      id = u.searchParams.get("v") || (location.pathname.startsWith("/shorts/") ? location.pathname.split("/")[2] : null);
    }
    return { id, title: title || document.title.replace(/ - YouTube$/, "") };
  }

  // 今の動画の字幕トラック一覧（プレーヤー API から。無ければ空配列）
  function trackList() {
    const p = player();
    let list = [];
    try { list = p.getOption("captions", "tracklist") || []; } catch (_) { /* 字幕モジュール未読み込み */ }
    if (!list.length) {
      try {
        const tl = p.getPlayerResponse().captions.playerCaptionsTracklistRenderer.captionTracks || [];
        list = tl.map(t => ({ languageCode: t.languageCode, kind: t.kind, vss_id: t.vssId }));
      } catch (_) { /* 字幕なし */ }
    }
    return list;
  }

  async function waitCaptured(id) {
    const t0 = Date.now();
    while (!captured.has(id) && Date.now() - t0 < WAIT_MS) await sleep(POLL_MS);
    return captured.get(id);
  }

  // 今の動画の字幕本文（json3）を取る。取れないときは理由を error で返す。
  async function getCaptions() {
    const { id } = currentVideo();
    if (!id) return { error: "動画を特定できませんでした" };
    let got = captured.get(id);

    // (a) 横取りより前にプレーヤーが取得済みだった場合: 通信履歴に残っている URL（pot 付き）で取り直す
    if (!got) {
      const es = performance.getEntriesByType("resource").filter(e => isTimedText(e.name) && videoOf(e.name) === id);
      if (es.length) {
        try {
          const url = es[es.length - 1].name;
          const body = await (await origFetch.call(window, url, { credentials: "include" })).text();
          if (body) { remember(url, body); got = captured.get(id); }
        } catch (_) { /* 次の手段へ */ }
      }
    }

    // (b) プレーヤーに字幕を読み込ませる
    if (!got) {
      const p = player();
      try { p.loadModule("captions"); } catch (_) { /* 既に読み込み済み */ }
      await sleep(300);
      const list = trackList();
      if (!list.length) return { error: "この動画には字幕がありません（YouTube 側に字幕データが無い動画です）" };
      let cur = null;
      try { cur = p.getOption("captions", "track"); } catch (_) { /* 未選択 */ }
      const want = (cur && cur.languageCode) ? cur : (list.find(t => t.languageCode === "ja") || list[0]);
      try { p.setOption("captions", "track", {}); await sleep(200); p.setOption("captions", "track", want); } catch (_) { /* 次の手段へ */ }
      got = await waitCaptured(id);
    }

    // (c) CC ボタンを OFF→ON（プレーヤー API が効かない場合）
    if (!got) {
      const btn = document.querySelector(".ytp-subtitles-button");
      if (btn) {
        if (btn.getAttribute("aria-pressed") === "true") { btn.click(); await sleep(400); }
        btn.click();
        got = await waitCaptured(id);
      }
    }
    if (!got) return { error: "字幕を読み込めませんでした。動画を少し再生してから、もう一度お試しください" };
    let lang = "";
    try { lang = new URL(got.url, location.href).searchParams.get("lang") || ""; } catch (_) { /* lang 不明でも本文は使える */ }
    return { body: got.body, lang, videoId: id };
  }

  window.addEventListener(REQ, ev => {
    let req;
    try { req = JSON.parse(ev.detail); } catch (_) { return; }
    const reply = data => window.dispatchEvent(new CustomEvent(RES, { detail: JSON.stringify({ rid: req.rid, ...data }) }));
    if (req.type === "info") { reply(currentVideo()); return; }
    if (req.type === "captions") {
      getCaptions().then(reply).catch(e => reply({ error: `字幕の取得中にエラー: ${e && e.message ? e.message : e}` }));
    }
  });
})();
