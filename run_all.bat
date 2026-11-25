@echo off
title FindPhotos
echo ==============================================
echo           FindPhotos Local Launcher
echo ==============================================
echo [1/2] Starting Backend (FastAPI + InsightFace + Qdrant)...
start "FindPhotos Backend" cmd /k "cd /d %~dp0 && run_backend.bat"

echo [2/2] Starting Frontend (Expo Web)...
timeout /t 3 /nobreak >nul
start "FindPhotos Frontend" cmd /k "cd /d %~dp0 && run_frontend.bat"

echo ==============================================
echo Backend running on:  http://localhost:8000
echo Frontend running on: http://localhost:8081
echo ==============================================
