@echo off
rem Music Theorizer AI helper: one-time setup on Windows. Downloads Python and the models' packages
rem into this folder (.venv), about 3 GB with GPU support. Run it again any time to repair the install.
setlocal
cd /d "%~dp0"
where uv >nul 2>nul
if errorlevel 1 (
  echo Installing uv, a small Python installer, from astral.sh ...
  powershell -ExecutionPolicy ByPass -NoProfile -Command "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)
where uv >nul 2>nul || (echo Could not install uv. See README.md for the manual steps. & pause & exit /b 1)
uv venv --python 3.12 .venv || (pause & exit /b 1)
where nvidia-smi >nul 2>nul
if errorlevel 1 (
  echo No NVIDIA GPU found: installing the CPU version of PyTorch.
  uv pip install --python .venv\Scripts\python.exe torch || (pause & exit /b 1)
) else (
  echo NVIDIA GPU found: installing PyTorch with CUDA.
  uv pip install --python .venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cu124 || (pause & exit /b 1)
)
uv pip install --python .venv\Scripts\python.exe -r requirements.txt || (pause & exit /b 1)
echo.
echo Demucs splits songs into their instruments (Jam Mode's Instruments tab), and an AudioSet model
echo names the instruments in each song. They add about 200 MB, and their models (about 400 MB)
echo download the first time you use them.
set "DEMUCS=y"
set /p DEMUCS="Install Demucs? [Y/n] "
if /i not "%DEMUCS%"=="n" (
  uv pip install --python .venv\Scripts\python.exe "demucs>=4.1" "transformers>=4.40" || echo Demucs did not install. The rest of the helper still works.
)
echo.
echo AudioSep pulls out any instrument the helper recognises (strings, brass, synth, organ, sax...)
echo instead of leaving them together in Other. It downloads about 4 GB and is slow without a GPU.
set "ASEP=y"
set /p ASEP="Install AudioSep? [Y/n] "
if /i not "%ASEP%"=="n" call :audiosep
echo.
echo Setup finished. Double-click start-windows.bat to run the helper.
pause
exit /b 0

:audiosep
where nvidia-smi >nul 2>nul
if errorlevel 1 (
  uv pip install --python .venv\Scripts\python.exe torch torchvision torchaudio
) else (
  uv pip install --python .venv\Scripts\python.exe torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
)
uv pip install --python .venv\Scripts\python.exe -r requirements-audiosep.txt || (echo AudioSep did not install. The rest of the helper still works. & exit /b 0)
.venv\Scripts\python.exe install_audiosep.py
exit /b 0
