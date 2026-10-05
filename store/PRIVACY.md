# Clip Maker プライバシーポリシー / Privacy Policy

最終更新: 2026-10-05

## 日本語

Clip Maker は、ユーザーが開いている YouTube の動画ページから、再生位置・字幕・チャットのリプレイ（配信アーカイブのチャット欄に表示される内容）を読み取り、再生中の映像と音声をブラウザ内で録画して、切り抜き動画（mp4）をユーザー自身のダウンロードフォルダに保存します。

- 収集するデータ: ありません。読み取った内容・録画した動画・取り込んだ音声は、ユーザーの PC 内（ブラウザの保存領域とダウンロードフォルダ）にのみ保存され、開発者や第三者のサーバーには一切送信されません。
- 音声認識: 「音声認識」を選んだ場合、字幕を作るための認識モデル（数百 MB）を初回に Hugging Face（huggingface.co）からダウンロードしてブラウザに保存します。音声の認識はユーザーの PC 内で行い、音声を外部に送信することはありません。
- 通信先: YouTube のページ内での読み取りと、上記の認識モデルのダウンロードだけです。それ以外の外部サーバーとの通信はありません。
- アカウント情報・閲覧履歴・個人情報: 取得しません。
- 利用上の注意: 切り抜き動画の公開には、元動画の権利者の許諾が必要です。本拡張は作業を助けるツールであり、利用はユーザーの責任で行ってください。
- 問い合わせ: https://github.com/coconuts-milk/clip-maker-extension/issues

## English

Clip Maker reads the playback position, captions, and live chat replay messages from the YouTube page the user has open, records the playing video and audio inside the browser, and saves the resulting clip (mp4) into the user's own Downloads folder.

- Data collected: none. Everything (captured text, recorded video, captured audio) stays on the user's PC (browser storage and the Downloads folder); nothing is sent to the developer or any third party.
- Speech recognition: when the user chooses "speech recognition" for captions, a recognition model (a few hundred MB) is downloaded once from Hugging Face (huggingface.co) and cached in the browser. Recognition runs on the user's PC; audio is never uploaded.
- Network: only reading the YouTube page and downloading the recognition model described above. No other external communication.
- No account data, browsing history, or personal information is accessed.
- Note: publishing clips requires permission from the rights holder of the original video. This extension is a tool; use it responsibly.
- Contact: https://github.com/coconuts-milk/clip-maker-extension/issues
