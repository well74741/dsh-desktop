@echo off
rem 重试发布：推送 main 与最新标签，触发 Actions 构建 exe（双击本文件）
cd /d "%~dp0"
call node scripts/push-last-tag.mjs
echo.
pause
