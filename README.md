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

## テスト
```
python -m pytest tests -q
```
