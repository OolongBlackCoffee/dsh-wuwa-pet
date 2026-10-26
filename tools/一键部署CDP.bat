@echo off
title WuwaTappo CDP 一键部署
cd /d "%~dp0"
echo ============================================
echo   WuwaTappo 调试端口（读账气泡用）
echo   官方更新后双击这个即可，其余不用管
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-cdp.ps1" %*
echo.
pause
