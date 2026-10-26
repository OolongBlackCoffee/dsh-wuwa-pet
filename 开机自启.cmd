@echo off
chcp 65001 >nul
title Enable autostart for dsh-wuwa-pet
echo Installing logon autostart (starts WuwaTappo, then DeepSeek Harness)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\autostart.ps1" install
echo.
pause
