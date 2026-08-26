@echo off
rem Clip Maker 自動焼き付け: ダウンロード/clip-maker を監視し、拡張で保存すると mp4 を自動生成する。
rem スタートアップ登録用。ウィンドウは進捗表示を兼ねるので閉じない（閉じると自動焼き付けが止まる）。
title Clip Maker 自動焼き付け
cd /d "%~dp0"
python -m clipmaker watch
pause
