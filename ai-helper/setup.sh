#!/bin/sh
# Music Theorizer AI helper: one-time setup on macOS or Linux (installs into ./.venv).
set -e
cd "$(dirname "$0")"
if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv, a small Python installer, from astral.sh ..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  PATH="$HOME/.local/bin:$PATH"
fi
uv venv --python 3.12 .venv
if command -v nvidia-smi >/dev/null 2>&1; then
  uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cu124
else
  uv pip install --python .venv/bin/python torch
fi
uv pip install --python .venv/bin/python -r requirements.txt
echo "Demucs splits songs into their instruments (Jam Mode's Instruments tab), and an AudioSet model"
echo "names the instruments in each song. They add about 200 MB, and their models (about 400 MB)"
echo "download the first time you use them."
printf "Install Demucs? [Y/n] "
read -r ans || ans=y
case "$ans" in [nN]*) ;; *)
  uv pip install --python .venv/bin/python "demucs>=4.1" "transformers>=4.40" || echo "Demucs did not install. The rest of the helper still works." ;;
esac
echo
echo "AudioSep pulls out any instrument the helper recognises (strings, brass, synth, organ, sax...)"
echo "instead of leaving them together in Other. It downloads about 4 GB and is slow without a GPU."
printf "Install AudioSep? [Y/n] "
read -r ans || ans=y
case "$ans" in [nN]*) ;; *)
  if command -v nvidia-smi >/dev/null 2>&1; then
    uv pip install --python .venv/bin/python torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
  else
    uv pip install --python .venv/bin/python torch torchvision torchaudio
  fi
  uv pip install --python .venv/bin/python -r requirements-audiosep.txt && .venv/bin/python install_audiosep.py \
    || echo "AudioSep did not install. The rest of the helper still works." ;;
esac
echo "Setup finished. Run: sh start.sh"
