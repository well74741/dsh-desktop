@echo off
rem DSH Studio release helper — double-click this, type a version, done.
cd /d "%~dp0"
echo DSH Studio 发布助手
echo 工作区需已提交（未提交的改动会中止）。
set /p NEXT=请输入新版本号（如 0.2.0；直接回车 = 自动补一版）: 
call node scripts/release.mjs %NEXT%
echo.
pause
