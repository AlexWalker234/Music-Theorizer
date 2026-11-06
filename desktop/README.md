# Music Theorizer desktop app

`Music Theorizer.exe` is the whole app in one file. Double-click it and the app opens in its own window (Edge or Chrome in app mode, no address bar). Close the window and the program stops by itself shortly after.

It also talks to Ollama for you. The AI Coach's requests go through the program instead of straight from a web page, so:

- you don't need `OLLAMA_ORIGINS`, and you don't need to run `python -m http.server`;
- Ollama can run on this computer (the default, `http://127.0.0.1:11434`) or on another one, like a gaming PC. Type its address in **Settings › AI Coach › Server address**, for example `http://192.168.1.20:11434`. On that computer, set `OLLAMA_HOST=0.0.0.0` and restart Ollama so it accepts connections from the network.

It forwards song-analysis and instrument-separation requests to the optional AI helper the same way (default `http://127.0.0.1:8765`; change it in **Settings › Song analysis › Helper address**). The helper is a separate download: see `ai-helper/README.md` in the source.

The addresses you pick are saved in `%APPDATA%\MusicTheorizer\config.json` (macOS: `~/Library/Application Support/MusicTheorizer`, Linux: `~/.config/MusicTheorizer`). A log of the last run is next to it in `launcher.log`.

## First run on Windows

The program isn't signed, so Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**. It only listens on this computer (127.0.0.1) and refuses requests from other web pages.

## macOS and Linux

Use `music-theorizer-mac-apple-silicon`, `music-theorizer-mac-intel` or `music-theorizer-linux` from `dist/`. On macOS, the first time, right-click the file and choose **Open**, or run `xattr -d com.apple.quarantine <file>` and `chmod +x <file>`.

## Rebuilding

After changing the app, run `sh desktop/build.sh` (needs Go 1.22 or newer). It copies `index.html`, `css/` and `js/` into the program and builds all four files into `desktop/dist/`.
