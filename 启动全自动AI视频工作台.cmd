@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Start-FlowCut.ps1" -Desktop
exit /b %errorlevel%
