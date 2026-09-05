@echo off
rem DSH Studio Tools - single launcher with a menu UI (double-click me)
cd /d "%~dp0"
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0studio-tool.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0studio-tool.ps1"
)
