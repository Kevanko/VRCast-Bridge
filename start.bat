@echo off
setlocal
title VRCast Bridge
cd /d "%~dp0"
if exist "%~dp0VRCast Bridge.exe" (
  start "" "%~dp0VRCast Bridge.exe"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer.
  pause
  exit /b 1
)
node "src\server.js"
if errorlevel 1 pause
