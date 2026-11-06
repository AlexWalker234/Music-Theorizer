@echo off
rem Adds AudioSep to an AI helper that is already set up, so every instrument the helper finds gets its own fader.
rem About 4 GB of downloads. Run it again to resume a broken download.
setlocal
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Run setup-windows.bat first. & pause & exit /b 1)
where uv >nul 2>nul || set "PATH=%USERPROFILE%\.local\bin;%PATH%"
where nvidia-smi >nul 2>nul
if errorlevel 1 (
  uv pip install --python .venv\Scripts\python.exe torch torchvision torchaudio || (pause & exit /b 1)
) else (
  uv pip install --python .venv\Scripts\python.exe torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 || (pause & exit /b 1)
)
uv pip install --python .venv\Scripts\python.exe -r requirements-audiosep.txt || (pause & exit /b 1)
.venv\Scripts\python.exe install_audiosep.py
echo.
echo Done. Close the helper window if it is open and start it again with start-windows.bat.
pause
