# Music Theorizer: Phase 2 notes from the prototype

These notes describe how the prototype is structured, so they can feed the Phase 2 information architecture, flows and wireframes. Latency numbers for the song analysis were measured on the prototype. Qwen numbers come from running `spike/qwen_spike.py` on the RTX 4080 Super machine; fill them in from `spike/results.md`.

## Site map

```
Music Theorizer
├── Keyboard (always visible)
│   ├── Instrument presets, volume, reverb, note names
│   ├── Octave shift, computer-key map
│   └── MIDI keyboard connection
├── Free Play
│   ├── Notes you played
│   └── Scale identifier (ranked scales → "Use this scale")
├── Scale Mode
│   ├── Root + scale pickers, scale-only lock, degree labels
│   ├── Notes, step pattern, chords in the key
│   └── Practice run (guided up and down)
├── Jam Mode
│   ├── Song source: demo songs, upload, drag and drop
│   ├── Analysis status (empty / loading / success / unsure / error)
│   ├── Song library: uploads saved on the device, re-analyze or remove
│   ├── Song facts: key, tempo, current chord, length, tuning (A4 Hz)
│   ├── Key correction with undo
│   ├── Song map: sections and chord timeline (click to seek)
│   ├── Listen: transport, speed (0.5× / 0.75× / 1×), song volume
│   ├── Play along: guidance toggles, new suggestion / undo
│   ├── Riff Mode: detected riff on a piano roll, hear it, step or in-time practice
│   └── Guitar: interface input + "Find my guitar", amp sim (mono/stereo), tuner with custom Hz,
│       fretboard view replacing the keyboard, live note trail, hit stats, out-of-tune hint
├── AI Setup
│   ├── Requirements and model sizes
│   ├── Steps per system (Windows / macOS / Linux) with copyable commands
│   ├── Live checks: app local, server reachable, model installed, model answers
│   └── Troubleshooting table
├── Settings
│   ├── Sound: instrument, volume, reverb, song volume
│   ├── Keyboard: size, labels, number-key playing
│   ├── Guidance and display: phrase length, dark mode
│   ├── Audio input: sample rate, latency, interface check
│   └── AI Coach: server type, address, model, connection test
└── AI Coach (side panel, all modes)
    ├── Conversation with regenerate, copy, remove
    └── Quick questions per mode
```

## AI integration points

| Feature | Model | Input | Output | Expected time |
|---|---|---|---|---|
| Song analysis (Jam Mode) | Local DSP engine standing in for S-KEY / "Skey-onyx" | Audio file decoded in the browser (mono PCM) | Key + 2 alternatives with confidence band, tempo, chord timeline, sections | 0.15–0.25 s for a 30 s clip (measured in `tests/analysis.test.js`); scales with length |
| AI Coach | Qwen 2.5 7B Instruct via Ollama on the user's PC | Question, last 8 messages, app context (mode, key, chord, recent notes) | Streamed text answer | Fill in from spike: first token and total, min/avg/max |
| Scale identifier (Free Play) | Rule-based scorer (not ML) | Counts of the notes the user played | Ranked scales with "fits N of M notes" | Under 5 ms |
| Phrase suggestions (Jam Mode) | Rule-based generator | Key, current chord, keyboard range, seed | 4-note phrase shown as numbered keys | Under 5 ms |

Confidence: the key detector produces a real correlation score, which is shown only as plain language ("Clear match", "Likely, check by ear", "Unsure, check by ear") plus alternatives. Qwen answers carry no confidence number; the coach shows a "check by ear" note and lets the user regenerate or remove an answer.

## Data flow

```
Keyboard / MIDI ──notes──▶ app.js ──▶ Web Audio synth ──▶ speakers
                              │
                              ├──▶ Scale identifier (in browser)
                              │
Audio file ──decode (browser)──▶ analysis.js ──result──▶ Jam Mode UI + keyboard highlights
                              │
Question + app context ──HTTP──▶ Ollama on localhost (Qwen) ──streamed text──▶ Coach panel
```

Nothing leaves the user's machine. Audio files are decoded and analyzed in the browser. The coach talks to Ollama on `localhost`, so no user data goes to a third-party AI provider. The only stored data is the user's coach settings, chosen instrument and last mode, in browser local storage.

## The five AI states, per feature

| State | Jam Mode analysis | AI Coach |
|---|---|---|
| Empty | "No song loaded" with demo picker and upload; says the file is not uploaded | Welcome message and quick questions for the current mode |
| Loading | Progress bar, six named stages, elapsed seconds, Cancel | "Thinking…" with elapsed seconds, Stop button; streamed text appears as it arrives; after 10 s a "still working" note |
| Success | "Found the key" with runner-up, facts, song map, lit keys | Answer with model name and response time, Regenerate, Copy, "Not helpful, remove" |
| Low confidence | "Not sure about the key" with one-click buttons for the two alternatives; key picker with undo | Standing note: "AI answers can be wrong. Check them by ear on the keyboard." |
| Error | Plain message per cause plus: choose another file, use the demo song, set the key myself (manual mode keeps scale guidance working) | Message per cause plus: Try again, Use offline helper, Open settings. Unreachable server switches to the offline helper automatically |

## Edge cases handled

1. **AI unavailable, timeout or rate limit.** Coach: unreachable server falls back to the offline helper with a "Reconnect to Qwen" link; 60 s timeout; HTTP 429 shows "busy, wait and try again"; missing model names the installed ones.
2. **Poor, wrong or empty result.** Key detection: alternatives and a manual key override with undo; chords outside the key are marked. Coach: empty answers become an error with "try rephrasing"; users can regenerate or remove any answer.
3. **Invalid or unsupported input.** Non-audio files, undecodable formats, files over 60 MB, clips under 4 s and silent audio each get their own message and a way forward. Coach questions over 1000 characters are refused with a reason.
4. **Biased or inappropriate output.** The system prompt keeps Qwen on music and forbids invented facts about songs and artists; the spike includes an off-topic request to record what Qwen does with it.

5. **Guitar input problems.** Blocked microphone permission, no interface found, a device that disappears, and an interface that rejects the chosen input each get a plain message and fall back to the default input. Clipping turns the level meter red. Mismatched sample rates and high delay are flagged in Settings › Audio input. An out-of-tune guitar gets a small pill under the guitar panel, never a pop-up.

## Flows the prototype covers (persona labels to be added from Phase 1)

1. Learn a scale: Scale Mode → pick scale → hear it → see its chords → open the coach for questions.
2. Find the scale of a riff: Free Play → play notes → identifier ranks scales → "Use this scale" → Scale Mode.
3. Jam over a song: Jam Mode → demo or upload → analysis → (fix key if unsure) → Play → follow lit keys and numbered suggestions.
4. Ask for help: any mode → coach quick question or typed question → streamed answer → regenerate or remove.
5. Recover from failure: upload fails → choose another file, demo song, or set key manually.
