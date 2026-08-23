// 無料版の service worker は常駐処理をしない（拡張審査: 最小権限）。
// インストール時のログだけ出す（E2E が拡張 ID を取るための起動点にもなる）。
chrome.runtime.onInstalled.addListener(() => console.log("[clip-maker] installed"));
