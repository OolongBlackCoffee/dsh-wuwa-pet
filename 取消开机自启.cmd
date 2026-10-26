@echo off
chcp 65001 >nul
title Remove autostart for dsh-wuwa-pet
echo Removing the logon autostart entry...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\autostart.ps1" remove
echo.
pause
