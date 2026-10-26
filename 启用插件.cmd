@echo off
chcp 65001 >nul
title Enable dsh-wuwa-pet
echo Enabling dsh-wuwa-pet in DSH profile...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\toggle.ps1" on
echo.
echo Restart DeepSeek Harness to apply.
pause
