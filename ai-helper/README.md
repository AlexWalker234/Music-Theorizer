# Music Theorizer AI helper

An optional program that runs trained music models on your own computer. It does two jobs: it splits songs into their instruments for **Jam Mode › Instruments**, and, when you turn it on, Jam Mode gets its **chords, key, beats and tempo** from its models instead of the built-in engine. Notes, the riff, tuning and the song sections still come from the built-in engine (Basic Pitch), which also takes over whenever the helper isn't running.

| Part | Model | What it does |
|---|---|---|
| Chords | **BTC** (Bi-directional Transformer for Chord recognition, ISMIR 2019), large vocabulary | 12 roots × 14 chord types: triads, 6ths, 7ths, maj7, m7, m7♭5, °7, sus2, sus4 |
| Beats, downbeats, tempo | **madmom** RNN + dynamic Bayesian network | beat times, bar starts (3/4 or 4/4) and BPM |
| Key | from BTC's chords, with **madmom's key CNN** as a second opinion | which of the 24 major/minor keys the chords fit best, weighted toward time on the tonic chord |
| Instruments | **Demucs** (htdemucs_6s, Meta, MIT licence) | splits the song into drums & percussion, bass, vocals, guitar, piano & keys, and other for the Instruments mixer; optionally also removes drums and most vocals before the chord model listens |
| Which instruments play | **AST** (Audio Spectrogram Transformer fine-tuned on AudioSet, by MIT CSAIL, BSD-3 licence), installed with Demucs | listens to the song and to the separated stems in 10 s windows and names the instruments in this song from about 35 kinds (drum kit or drum machine, hand percussion, bass guitar or double bass, vocals, choir, rap, electric / acoustic / slide guitar, banjo, mandolin, ukulele, sitar, piano, electric piano, harpsichord, organ, synth, strings, brass, sax, flute, clarinet, woodwinds, harp, mallets, bells, accordion, harmonica, bagpipes, theremin, DJ scratching). Each stem is then labelled by what is in it |
| Split each instrument (optional) | **AudioSep** ("Separate Anything You Describe", Liu et al. 2023, MIT licence) | pulls each recognised instrument out of the stem it shares, by name: strings, brass and synth out of "other", acoustic from electric guitar, organ from piano, percussion from the drum kit. What's left stays as "the rest" / "Everything else". So the mixer gets one fader per instrument this song actually has, not a fixed six |

## Set up (once)

**Windows:** double-click `setup-windows.bat`. It installs [uv](https://docs.astral.sh/uv/) (a small Python installer), downloads Python 3.12 and the packages into a `.venv` folder here, and picks PyTorch with CUDA when it finds an NVIDIA GPU. It needs internet and takes a few minutes (about 3 GB with GPU support). At the end it asks whether to add Demucs (press Enter for yes; it also adds the instrument recogniser); you need it for Jam Mode › Instruments. Then it asks whether to add AudioSep (type y): about 4 GB of downloads, best with an NVIDIA GPU. If you set the helper up before, run the setup again to add them; To add only AudioSep to a helper that is already set up, double-click `add-audiosep-windows.bat` (it also resumes a broken download; on macOS or Linux run `.venv/bin/python install_audiosep.py` after `uv pip install --python .venv/bin/python torchvision torchaudio -r requirements-audiosep.txt`).

**macOS / Linux:** `sh setup.sh`

Nothing is installed outside this folder except uv. To uninstall, delete the folder.

## Use it

1. Start the helper: double-click `start-windows.bat` (or `sh start.sh`). A window says `Models loaded ... Ready.` Leave it open.
2. For the analysis (optional): **Settings › Detail level › Advanced**, then **Settings › Song analysis › Engine › AI helper on this computer**. Press **Check the helper**; it should say *Connected*.
3. Instruments: in Jam Mode load a song, open the **Instruments** tab and press **Separate instruments**. The first time, the Demucs model (about 55 MB) and the recogniser (about 350 MB) download. With "Find the instruments in this song" ticked (the default), the tab then shows **Found in this song** (each instrument with how sure the model is) and one fader per instrument; untick it for the plain six stems. With an NVIDIA GPU a song takes seconds; on the CPU about a minute per minute of song. Then mute, solo or turn down each instrument; the Tempo slider and the metronome work with it too.
4. Analysis: analyse a song in Jam Mode. Under the facts there's a **"Analyzed by the AI helper… Compare with the built-in engine"** row; open it to see both engines' key, tempo and chords side by side.

The desktop app forwards requests to the helper itself, so no browser settings are needed. If the helper runs on another computer, start it with `start-windows.bat --host 0.0.0.0` there and type that computer's address (for example `192.168.1.20:8765`) in **Helper address**.

Options: `--port 8765` (default), `--host 127.0.0.1` (default, this computer only), `--cpu` (don't use the GPU).

## How well it works

On the app's 22 synthetic test songs (made from simple tones, so they're easy for the built-in engine, which was tuned on them):

| | Built-in engine | AI helper |
|---|---|---|
| Key exactly right | 20/22 | 21/22 |
| Chords right (per beat) | 97% | 96% |
| Tempo right | 22/22 | 22/22 |
| Beats within 70 ms | 99.6% | 99.1% |
| Time per song (CPU, 4 cores) | a few seconds | ~12 s |

So on simple audio they're about even. The models were trained on real recordings, which is where they should do better: real instruments, vocals, drums and mixing are what fool the built-in engine. Compare the two on your own songs with the side-by-side view. madmom's key model alone got only 9/22 here (it often picks the key a fifth away), so it's only used as a second opinion.

With an NVIDIA GPU, BTC and Demucs run on the GPU; madmom always runs on the CPU.

## API

`GET /health` → `{"ok", "loading", "device", "demucs", "recognition", "audiosep", "busy", "version"}`. Each stem in `/separate`'s header has `id`, `label`, `family` (drums, bass, vocals or pitched) and `instruments` (the recognised ones it holds); `instruments` at the top lists everything recognised with `confidence`, `share` (of the song) and `separated`.

`POST /analyze?sr=22050[&separate=1]` with the song as raw little-endian float32 mono samples (4 s to 12 min) →
`{key, keyCandidates, keyConfidence, madmomKey, tempo, beats, downbeats, beatsPerBar, chords:[{start, end, root, quality, label}], warnings, device, timingsMs, engine, seconds}`

`POST /separate?sr=44100&ch=2[&auto=0]` (auto, the default: recognise and split the instruments) with the song as little-endian int16 samples, one channel after the other →
binary: a 4-byte little-endian header length, the header JSON `{model, sampleRate, stems:[{id, label, present, levelDb, active, gain, samples}], seconds, device}`, then each stem that has `samples` as int16 mono at `sampleRate` (32 kHz), in header order (multiply by `gain / 32767`). While it runs, `/health` has `job: {kind, progress, stage}`.

Why "Other" holds synths and leads without AudioSep: Demucs and the other openly available stem models are trained on datasets with drums, bass, vocals, guitar, piano and "everything else" stems. AudioSep is trained differently (any sound described in words), so it can split those, but it is slower, needs about 4 GB, and is not as clean as Demucs on the six it knows; that's why it only splits what Demucs leaves shared. Without AudioSep the recogniser still names what is inside each stem ("Other: Synthesizer, Strings"). An instrument the song barely has (quieter than about −30 dB, or playing under 8% of the time) is marked as not present; faint ones are still sent so you can check.

## What's in this folder

- `server.py` (the web server), `analyzer.py` (the pipeline), `btc_chords.py`, `keyfit.py`
- `btc/`: BTC's model code and the large-vocabulary weights (12 MB), from [jayg996/BTC-ISMIR19](https://github.com/jayg996/BTC-ISMIR19), MIT licence. Only change: NumPy 2 and PyYAML 6 compatibility.
- `vendor/madmom/`: [madmom 0.16.1](https://github.com/CPJKU/madmom) (code BSD licence; models CC BY-NC-SA 4.0, so non-commercial use only). Changed so it installs without a C compiler on current Python: the Cython HMM is replaced by a NumPy port (`ml/hmm.py`, results checked identical to the original on test songs), unused Cython parts are stubbed, and old NumPy/collections names are updated. Only the beat, downbeat and key models are included.
- Demucs isn't included; the setup script installs it from PyPI (version 4.1 or later), and its model (about 55 MB) downloads from Hugging Face the first time you separate a song. **The real Demucs model could not be downloaded where this was built**, so separation was tested with a stand-in model (every step from the app to the mixer works); how well it separates is Demucs's own quality. If separation fails, the app says why.
- **Instrument recognition and AudioSep are untested with their real models**: neither the AST weights (Hugging Face) nor AudioSep's code and checkpoints (GitHub, Hugging Face) could be downloaded where this was built. Every step was tested with stand-ins (the recogniser's code with a randomly initialised AST of the real shape and AudioSet's 527 labels; AudioSep through its worker with a stand-in network), so the plumbing works; how well they recognise and split is the models' own quality. The thresholds for "this instrument plays" (`instruments.py`: 0.35 in any window, or 0.15 across a fifth of the song) are a first guess to tune on real songs. AudioSep runs in its own process (`audiosep_worker.py`) because its module names clash with BTC's.
