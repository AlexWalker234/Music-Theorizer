# Music Theorizer

The Travelling Band's Music Theorizer: a virtual instrument that teaches music theory with AI-guided highlighting on the keyboard. It runs in any modern browser with no install and no build step.

## Run it

Easiest on Windows: double-click `desktop/dist/Music Theorizer.exe`. It opens the app in its own window and connects the AI Coach to Ollama on your computer (or another one you choose in Settings › AI Coach setup › Coach connection), with no `OLLAMA_ORIGINS` or local web server needed. See `desktop/README.md`.

Without the desktop app:

Open `index.html` in Chrome, Edge or Firefox. For the AI coach and MIDI, serve the folder instead of double-clicking:

```
cd music-theorizer
python3 -m http.server 8000      # then open http://localhost:8000
```

To give the coach a real model (the slides' Qwen chatbot), run Qwen locally with Ollama:

```
ollama pull qwen2.5:7b-instruct
OLLAMA_ORIGINS=* ollama serve    # lets the browser page talk to Ollama
```

The coach checks the connection on load. Without Ollama it switches to a built-in offline helper, so nothing breaks. LM Studio, vLLM and llama.cpp work too: pick "OpenAI-compatible" in Settings › AI Coach setup › Coach connection.

## What maps to the slides

| Slide feature | Where it is |
|---|---|
| Functional virtual keyboard (like a VST) | Bottom of every screen. Mouse, touch, computer keys (`A W S E D F T G Y H U J K`, `Z`/`X` for octave, `1`–`9` or the numpad to play the numbered suggested keys) or a USB MIDI keyboard (the Connect MIDI button and its status only show in Advanced mode). |
| Instrument sounds and presets | Instrument menu, 34 synthesised sounds in groups: Keys (grand and electric piano, organ, harpsichord, clavinet), Guitar & plucked (acoustic, nylon, electric, overdrive, banjo, harp, sitar), Bass (bass guitar, synth bass, upright), Strings & orchestra (strings, pizzicato, cello), Brass & winds (brass section, trumpet, sax, flute, clarinet, accordion, harmonica), Mallets & bells (vibraphone, marimba, glockenspiel, FM bell), Voices & synths (choir, synth lead, pad, square lead, pluck), plus volume and reverb. After Jam › Instruments separates a song, Riff Mode plays the riff and your keys with the sound of the instrument the riff came from ("Match the sound" turns it off; picking an instrument by hand does too), and the AI Coach can play examples with a chosen sound (`inst=` in its play block), using the matching sound for a separated instrument's part. |
| Scale identifier | Free Play: play notes and it ranks the scales they fit, says which notes are outside, and tells you which note would separate two close matches. Shown as one fixed-size card with a small lit keyboard of the scale (root brightest, your notes dotted); hover the other matches to preview them. An "On" checkbox switches it off (saved). |
| Scale-only mode | Scale Mode: pick any of 12 scales on any root. "Scale-only mode" locks the keys outside the scale. Shows the chords in the key and plays the scale back; the step pattern and formula show in Advanced detail. |
| AI guided mode / Jam Mode | Jam Mode: analyze a song for key, tempo, chords and sections, then play along. Keys light up for the scale (gold), the current chord (teal), and a numbered suggested phrase (red dots) that advances as you play it. |
| Riff Mode | Jam Mode › Riff Mode: the app finds the repeating melody (riff) in the song, shows it on a piano roll and the keyboard, plays it back, and coaches you through it note by note or in time with the song, at whatever tempo the Tempo slider is set to. |
| Guitar mode | Jam Mode › Guitar: plug a guitar into an audio interface and play over the song. The keyboard turns into a top-down 6-string fretboard that lights every place the key's notes can be played, with the suggested phrase numbered and the notes you play shown live (plus a trail of the last few). Suggestions bend to fit when you play your own in-key notes, on guitar and on the keys. Includes amp sims (clean, jazz, blues, rock, lead, metal, acoustic, direct) with drive, EQ, volume and mono/stereo output, a tuner with a custom reference pitch (400–480 Hz, or "Match the song"), alternate tunings, "Find my guitar" (checks every input of every interface), and a small non-blocking warning when the guitar is out of tune with the song. |
| Metronome | The metronome button (a metronome icon whose pendulum swings on each click, with the BPM) next to the Instrument picker (its ⚙ menu has tempo 30–240 BPM, tap tempo, beats per bar, click volume, click sound on/off and "follow the song"). Accented first beat, scheduled with Web Audio so it stays steady. In Jam Mode it follows the song's own beats and tempo (including the Tempo slider), and a row of beat lights under the transport shows the beat, with the first beat of the bar in red. |
| Tempo | Jam Mode › Tempo slider (50–150%, shown as BPM and %): speeds the song up or slows it down without changing its pitch (SoundTouch time-stretching in an AudioWorklet, `js/vendor/soundtouch-processor.js`, MPL-2.0). Replaces the old Speed menu. If a browser can't run it, the tempo still changes but the pitch moves too, and a note says so. |
| Instruments (stem separation) | Jam Mode › Instruments: the AI helper splits the song with Demucs (htdemucs_6s) into drums & percussion, bass, vocals, guitar, piano & keys, and "other". With "Find the instruments in this song" on (default), an AudioSet model (AST) names the instruments this song has from about 35 kinds (strings, brass, sax, organ, synth, acoustic vs electric guitar, choir, hand percussion…), shown as "Found in this song" with how sure it is, and each stem is labelled by what's in it; with AudioSep installed in the helper, each recognised instrument is split out of its stem and gets its own fader. Each gets mute, solo and a volume fader, played in sync and following the Tempo slider; instruments a song doesn't have are listed as missing. Needs the AI helper running with Demucs installed. After separating, the app re-analyses the song from the instruments (see below), and Play along and Guitar get a "Mute in the song" menu so you can play that part yourself. |
| Accessibility | Settings › Accessibility (Advanced detail level): highlight colour palettes (default, colour-blind safe Okabe–Ito, red-green, blue-yellow, or custom colours for in-scale, chord tone, play next and key root), stripes on chord tones so they don't rely on colour, one calm colour for every mode, high contrast, text size, and reduce motion. |
| Song tuning | Jam Mode shows each song's reference pitch (A4 in Hz) next to key and tempo, in both piano and guitar view. |
| Song library | Songs you upload are kept on this device and listed under "Your songs", with their analysis saved so they open instantly. Re-analyze or remove them from the same row. |
| AI server guide | Settings › AI Coach setup (a dropdown at the bottom of Settings): hardware and software requirements, which Qwen size to pick, step-by-step commands for Windows, macOS and Linux, and the coach connection settings (server, address, model, Test connection), and a "Run checks" button that tests each step live. |
| Keyboard bar toggles | "Note names" and "Key letters" (computer-key letters) checkboxes in the keyboard bar, saved on the device. |
| Keyboard display | A retro synth-style screen at the right of the keyboard bar replaces the colour legend. It's always shown on every tab; its three lines (Chord tone, In scale, Play this next) glow when that function is lighting keys and stay dark otherwise. The keyboard frame and pitch/mod wheel panel use the same dark bezel styling. |
| Pitch and mod wheels | Advanced mode only: two wheels left of the keyboard (in Beginner they are hidden and the arrow keys do nothing). Pitch bends ±2 semitones and springs back to the middle; Mod adds vibrato and stays where you leave it. Drag them, hold ↑/↓ for pitch, tap ←/→ for mod, or use a MIDI keyboard's pitch wheel and mod wheel (CC1). Double-click a wheel to reset it. |
| Fun touches | The "♫ Music Theorizer" title slowly cycles through the mode colours. Clicking it plays a short riff, floats notes up behind the app and sends a colour ripple across the whole screen that drains away. The background is a slow-moving scene of staff lines and drifting notes; notes near the mouse scatter and light up in colour. Notes you play are written on the lower staff in random colours with their letter names and a rippling underline; each new note makes the older ones fade, and the staff adds sheet-music details the same way: a treble or bass clef (picked from the first notes of each line; notes far outside it fold an octave and are marked 8va/8vb), the key signature of the current key (the scale in Scale Mode, the song's key in Jam Mode, C major in Free Play) with notes spelled to match it and ♯/♭/♮ only where a note differs from the signature or an earlier accidental in the bar, the time signature (the song's meter in Jam Mode, otherwise the metronome's beats per bar), a slur with the interval name between notes (M3↑, P5↓…), bar lines, rests for pauses. With the metronome on (or a Jam song playing) notes are placed where they fall in the bar on an 8th-note grid and drawn with the length you held them (8th, quarter, dotted quarter, half, dotted half, whole), with 8th, quarter and whole-bar rests for the gaps; without a beat they are quarter notes with a bar line every bar's worth of notes, interval names only on leaps of a 4th or more (never two in a row), notes held down together stacked as a chord with its name above (power chords, triads, sus, 6ths and 7ths, inversions shown as slash chords); quick separate notes are never stacked. In Jam Mode a second staff underneath shows the suggested phrase in the song's key and meter (next note glowing, played ones fading) and the song's current chord. While you play, every floating note is sent off screen and none come back until 5 s after you stop; new ones start below the bottom edge, out of sight, and drift up. The staff is an Advanced feature: in Beginner it is hidden, and in Advanced it has its own Settings › Staff section with three switches (staff follow-along, theory marks, jam staff); with follow-along off no staves are drawn, with it on only the note staff (and the jam staff) is shown. The large title sits centred at the bottom under the staves, and the mode tabs are centred at the top. The tab edge nearest the mouse lights up, and clicking a tab ripples and slides the new screen in. Motion is skipped when the system asks for reduced motion (the riff still plays). |
| First-run tour | The first time the app opens, a guided tour walks through every screen, the keyboard, the instrument and metronome controls, the AI Coach and the main settings, highlighting each one with a short explanation (Back, Next, → / ← keys, Skip). It shows again until finished or skipped; the "❓ Getting started" button at the top left replays it. |
| Exercises | Exercises tab: a course in five levels. Each lesson has three parts: Read (a short text on the concept), Quiz (3 multiple-choice questions; a wrong pick is crossed out and you try again, and the right one explains why) and Keyboard (a short explanation plus questions answered on the keyboard: one note, notes in order, or a chord held together). Once a quiz is passed, later attempts can skip straight to the keyboard. Stars for first-try answers saved on the device and a "Continue" button for the next lesson. Level 1 The keyboard (find C, white key names, sharps and flats, octaves; note names are hidden while you answer), 2 Steps and intervals (half and whole steps, 3rds to octaves, ear training), 3 Scales (C major, major, natural minor, pentatonic), 4 Chords (major, minor, chords in a key by Roman numeral, ear: major or minor), 5 Going further (seventh chords, inversions, modes, I–V–vi–IV). Hear it, Show me (also after three misses) and Skip on every question. "Practise a scale" makes exercises for any root and scale, with its own reading (its notes, step pattern, degrees and chords) and quiz, then keyboard exercises (going up and down, root, degrees, ear, copy a phrase, 3rds, 1-2-3 patterns, I–IV–V, all its chords, arpeggios), each marked Easy, Medium or Hard; Beginners get the easy ones recommended first and the rest unlock as they earn 2 stars, and a hard scale gets suggestions of easier ones. The AI Coach knows which question you're on and gives hints rather than answers. |
| Settings | Settings tab: detail level (Beginner hides fine controls such as the song map, key correction, amp EQ and audio-driver options; Advanced shows everything), keyboard size (number keys 1–9 always play the numbered suggestions), phrase length, dark mode (on, off or match the system), Advanced-only Staff and Accessibility sections, AI Coach (Reset coach context), and audio input (sample rate, latency, "Check my interface"). Volume, reverb and song volume live in the ⚙ menu next to the Instrument picker; the coach's server settings live in the AI Coach setup dropdown above "Reset all settings". Saved on the device. |
| Qwen assistant chatbot | AI Coach drawer: hidden at start, opened with the "💬 AI Coach" button (✕ or Esc closes it). Drag its title bar to move it; double-click the title bar to put it back. Streams answers and knows your mode, key, current chord, recent notes and the keyboard's range. Ask it to play something ("play me a riff", "show me the scale", "play the chords") and it answers with an example that plays on the keyboard with the keys lit; "▶ Play on the keyboard" replays it. The model writes a hidden play block such as `[[play bpm=90: E4/0.5 G4/0.5 A4 C5+E5+G5/2 R]]`; the offline helper makes them too. |
| Skey-onyx (key detection from audio) | `js/analysis.js`. See the note below. |
| AI song analysis (optional) | `ai-helper/`: a separate program that runs BTC (chords, including 7ths and sus), madmom (beats, downbeats, tempo, a key model) and Demucs (instrument separation for Jam Mode › Instruments) on your computer. Turn its analysis on in Settings › Song analysis (Advanced); Jam Mode then shows both engines' answers side by side. See `ai-helper/README.md`. |

## Note on the audio model

The slides name "Skey-onyx" for detecting the key from audio. The built-in engine uses Spotify's Basic Pitch model (in a background worker) to transcribe notes, then finds the key with chroma features and Krumhansl key profiles re-ranked by which chords appear, the tempo and beats from onsets, and the chords with an HMM over triads. When Basic Pitch can't run it falls back to a pure signal-processing engine; the demo songs always use that fast engine.

For more accurate chords, beats and key on real recordings, the optional AI helper (`ai-helper/`) runs trained models outside the browser and Jam Mode merges its answers in (Settings › Song analysis).

**Separated instruments improve the analysis.** After Jam Mode › Instruments separates a song, the app analyses it again: chords, key, tuning and sections from the pitched instruments only (bass, guitar, piano & keys, other; no drums or vocals), the beat and bar starts from the drums and bass, and the riff from each pitched instrument on its own (and the bass) as well as the whole mix, keeping the clearest one. Riff Mode's "Riff from" menu switches between them. With the AI helper on, it is asked again with its own separation for chords and key. The Instruments tab lists what changed and has "Undo: use the first analysis". Riff Mode also uses a 16th-note grid when a line's notes fall between the 8ths. The coach is told which instruments the song has and which you muted.

The AI Coach asks Ollama for an 8,192-token context window. When the chat since the last reset grows past about 2,000 tokens, or a server reports a context or token limit, the coach's context resets: a divider appears in the chat, the messages above it stay on screen, and the coach starts fresh from the current question. Settings › AI Coach › Reset coach context does the same by hand; "New chat" in the coach window clears the conversation.

The three demo songs are synthesized in the browser, so Jam Mode works without any audio files. Each is a small stereo band with its own timbre, register and place in the stereo field for every instrument, so instrument separation can pull them apart: drums (kick, snare, hi-hats, crash, fills), a picked bass that walks to the next chord, electric-piano comping with 7ths, a plucked-string guitar picking pattern that changes bar to bar, strings, and a synth lead playing the riff (a softer melody elsewhere). The B sections get a bigger arrangement. You can also upload your own MP3, WAV, OGG or M4A.

## AI states (Phase 2 requirement)

Every AI feature has all five states: empty, loading, success, low-confidence and error. Details, the site map, data flow and edge cases are in [docs/phase2-notes.md](docs/phase2-notes.md).

## Tests and spike

```
node tests/analysis.test.js        # renders the demo songs and checks key, tempo and sections are recovered
python3 spike/qwen_spike.py        # Qwen technical spike: 5 calls, latency min/avg/max, 5 failure tests
```

The spike writes `spike/results.md`, which can go straight into the one-page spike summary.

## Note on guitar input and ASIO

Web browsers, and the desktop app's window (which is Edge or Chrome), can't open ASIO drivers. Guitar input goes through the system audio driver (WASAPI on Windows, Core Audio on macOS) with the lowest latency the browser offers, and the app matches its sample rate to the interface so nothing is resampled. Settings › Audio input shows the measured delay. Interfaces with many inputs (for example 8) can appear as one device with several inputs or as several stereo-pair devices; "Find my guitar" checks all of them. Pitch tracking follows one note at a time, so chords are shown by their loudest note.

## Files

```
index.html          app shell
css/styles.css      styles (light and dark)
js/theory.js        notes, scales, chords, scale identifier, key profiles, phrase suggestions
js/analysis.js      song analysis engine and demo songs
js/audio.js         Web Audio synth presets, backing-track player (tempo, stems) and metronome
js/guitar.js        guitar input, amp sims, tuner/pitch tracking, fretboard drawing
js/library.js       saved songs (IndexedDB)
js/exercises.js     the Exercises tab: the course, scale exercises and answer checking
js/coach.js         Qwen client (Ollama / OpenAI-compatible, streaming) and offline helper
js/aihelper.js      client for the optional AI helper: analysis merged into Jam Mode, instrument separation
js/vendor/          tfjs, the Basic Pitch model, SoundTouch time-stretch worklet (MPL-2.0, soundtouch-LICENSE.txt)
ai-helper/          the AI helper (Python: BTC, madmom, Demucs) and its setup scripts
js/app.js           UI and mode logic
tests/              Node test for the analysis engine
spike/              Qwen technical spike
docs/               Phase 2 notes: site map, AI integration points, flows, edge cases
```
