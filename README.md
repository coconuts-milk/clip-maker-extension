# Clip Maker

YouTube の切り抜きを「どこを・どの字幕で」だけ決めて作るツール。

## 無料版（Chrome 拡張 `extension/`）
1. `chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」→ `extension/`
2. YouTube の動画ページで再生位置を合わせ、拡張アイコン → 長さ（最大 30 秒）→ 保存
3. `ダウンロード/clip-maker/` に 3 ファイル
   - `<id>_<秒>.clip.json` … 開始/終了秒（ここを書き換えれば区間を変えられる）
   - `<id>_<秒>.srt` … 字幕（テキストエディタで自由に編集）
   - `<id>_<秒>.comments.json` … 画面に表示されていたコメント
   動画ファイル自体は作らない（無料版の範囲）。スマホは Kiwi Browser 等の拡張対応ブラウザで同じ手順。

## PC プロ版（`pro/`・500 円）
```
pip install ./pro          # 要 ffmpeg（PATH）
clipmaker render ダウンロード/clip-maker/<id>_<秒>.clip.json   # 同名 .srt があれば字幕を焼き込む
```
→ `out/<id>_<秒>.mp4`。上限 10 分。

## 既知のリスク
- YouTube 規約: 切り抜きの公開は元動画の権利者の許諾が要る（ツールはユーザーの責任で使う）。
- 字幕は動画側にトラックがある場合だけ取れる（無い場合はエラー表示。黙って空にしない）。
- Chrome Web Store 審査: `downloads` 権限の用途説明が必要。

## テスト・実機確認（2026-08-23）
```
python -m pytest tests -q          # プロ版の単体 8 件（ffmpeg/yt-dlp は差し替え）
cd e2e && npm i && node extension_e2e.js   # 拡張の実機 E2E（本物の Chrome + YouTube、窓が一瞬開く）
```
確認済みの範囲:
- 拡張: Chrome 151 で YouTube `jNQXAC9IVRw` を開き、popup の保存ボタン経由で `clip.json` / `srt`（字幕 2 行・実データ）/ `comments.json`（表示中コメント）の 3 ファイルが `ダウンロード/clip-maker/` に落ちる（`E2E_OK`）。
- プロ版: 上で落ちた `clip.json` + `srt` をそのまま `clipmaker render` に通し、10 秒の h264/aac mp4 に字幕が焼き込まれたのを画像で確認。
- 字幕の取り方: 拡張から timedtext を直接 fetch すると YouTube が空を返す（pot トークン必須）ため、プレーヤー自身の字幕通信を `inject.js` で横取りする。headless / 自動操作フラグ付きの Chrome でも空になるので E2E は通常ウィンドウで回す。
