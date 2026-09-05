@echo off
rem 日常：一键“提交并上传代码”到 GitHub（双击本文件即可）
cd /d "%~dp0"
echo ============================================
echo  DSH Studio - 提交并上传代码
echo ============================================
call node scripts/push-code.mjs
echo.
pause
