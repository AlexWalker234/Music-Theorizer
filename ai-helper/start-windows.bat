@echo off
rem Starts the Music Theorizer AI helper. Leave this window open while you use the app.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Run setup-windows.bat first. & pause & exit /b 1)
.venv\Scripts\python.exe server.py %*
pause
