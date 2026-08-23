// Clip Maker main-world script — YouTube プレーヤーが自分で取りに行く字幕（/api/timedtext）の
// 応答を横取りして content.js に渡す。
// 理由: 拡張から timedtext URL を直接 fetch すると、YouTube の pot トークンが無いので 200・空が返る（2026-08 実測）。
// プレーヤーの通信には pot が付いているので、その応答をそのまま使うのが唯一確実。
(() => {
  const EVENT = "clip-maker-captions";
  const isTimedText = (u) => typeof u === "string" && u.includes("/api/timedtext");
  const publish = (url, body) => {
    if (!body) return;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify({ url, body }) }));
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.call(this, input, init);
    const url = typeof input === "string" ? input : (input && input.url);
    if (isTimedText(url)) {
      res.clone().text().then(t => publish(url, t)).catch(() => {});
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isTimedText(url)) {
      this.addEventListener("load", () => publish(url, this.responseText));
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
