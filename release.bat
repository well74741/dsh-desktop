@echo off
rem 一键发版：提交改动 + 升级版本 + 打标签 + 上传，Actions 自动构建发布（双击本文件即可）
cd /d "%~dp0"
echo ============================================
echo  DSH Studio - 一键发版
echo  1) 会先提交未上传的改动
echo  2) 升级版本号并打标签上传
echo  3) GitHub Actions 自动构建发布到 Releases
echo ============================================
call node scripts/do-release.mjs
echo.
pause
