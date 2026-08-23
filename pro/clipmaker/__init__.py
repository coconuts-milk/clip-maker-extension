"""clipmaker PC プロ版: 無料版（Chrome 拡張）が保存した clip.json / srt から切り抜き mp4 を作る。

入力: <base>.clip.json（video_id, start_sec, end_sec）, <base>.srt（任意・編集済み可）
出力: <base>.mp4（字幕焼き込み）
外部: yt-dlp（動画取得）, ffmpeg（切り出し・字幕焼き込み）

失敗は全部例外。黙って字幕無しで出したり、30 秒に丸めたりしない。
"""
__version__ = "0.1.0"
