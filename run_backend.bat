@echo off
title FindPhotos Backend
echo ==============================================
echo Starting FindPhotos Backend on http://localhost:8000
echo ==============================================
cd /d "%~dp0backend"
call .venv\Scripts\activate.bat
python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
pause
