@echo off
title FindPhotos Frontend
echo ==============================================
echo Starting FindPhotos Frontend on http://localhost:8081
echo ==============================================
cd /d "%~dp0frontend"
npx expo start --web
pause
