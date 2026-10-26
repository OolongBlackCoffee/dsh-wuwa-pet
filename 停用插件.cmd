@echo off
chcp 65001 >nul
title Disable dsh-wuwa-pet
echo Disabling dsh-wuwa-pet in DSH profile...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\toggle.ps1" off
echo.
echo Restart DeepSeek Harness to apply.
pause
