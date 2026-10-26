@echo off
title WuwaTappo CDP 还原
cd /d "%~dp0"
echo 将把 WuwaTappo.exe 还原成官方原文件（调试端口关闭）
echo.
set /p CONFIRM=确定还原吗？输入 y 回车：
if /i not "%CONFIRM%"=="y" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-cdp.ps1" -Restore
echo.
pause
