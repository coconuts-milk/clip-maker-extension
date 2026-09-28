// 拡張アイコンを押したらサイドパネル（panel.html）を開く。
// ふつうのポップアップはページ側をクリックすると閉じるため、動画を操作しながら時間を決める用途に合わない。
function enablePanel() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(e => console.error("[clip-maker] サイドパネルを設定できません", e));
}
chrome.runtime.onInstalled.addListener(() => { console.log("[clip-maker] installed"); enablePanel(); });
chrome.runtime.onStartup.addListener(enablePanel);
enablePanel();
