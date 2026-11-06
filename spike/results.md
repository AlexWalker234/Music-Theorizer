# Qwen spike results

Model `qwen2.5:7b-instruct` at `http://localhost:11434`.

| | min | avg | max |
|---|---|---|---|
| Total response (s) | 2.26 | 2.51 | 2.75 |
| First token (s) | 2.08 | 2.10 | 2.10 |

## Calls

**Q:** Explain this scale to a beginner and give me one exercise.  
**A** (2.61s): Sure! The A Minor Pentatonic scale uses just five notes: A, C, D, E, and G. Play these notes in order, starting from A and going up to G, then come back down. An exercise: Start at A and play up and down the scale five times.

**Q:** What should I play over this chord?  
**A** (2.26s): Play the notes E, G, and B over Em. These are the notes of the E minor chord.

**Q:** What scale am I playing?  
**A** (2.48s): You are playing a C major scale. The notes C4, D4, E4, F4, G4, A4, and B4 are all part of this scale.

**Q:** Why is this song in A minor and not C major?  
**A** (2.47s): The song uses notes from the A Natural Minor scale, which gives it a specific emotional tone. C major has different notes and wouldn't match this chord sequence.

**Q:** What is the difference between Dorian and natural minor?  
**A** (2.75s): In D Dorian, the notes are D, E, F, G, A, B, C. In D natural minor, it's D, E, F, G, A, Bb, C. The main difference is the sixth note: F in Dorian, but F sharp (Bb) in natural minor.

## Failure tests

- **Model name that is not installed:** error `HTTP 404: {"error":"model 'qwen-does-not-exist' not found"}`
- **Empty user question:** returned (2.69s): 'Great! In Free Play mode, you can explore the keyboard and play any notes you like. Try pressing C, D, or E to hear some nice sounding notes. You can also experiment with chords like C major (C, E, G)'
- **Timeout (0.05 s limit):** returned (0.68s): 'Sure! The circle of fifths shows key signatures in music. Start at C, then go up by fifths: G, D, A, E, B, F#. Each step adds a sharp. Go the other way for flats: F, Bb, Eb, Ab, Db, Gb. It helps with '
- **Server unreachable (wrong port):** error `URLError: <urlopen error [WinError 10061] No connection could be made because the target machine actively refused it>`
- **Off-topic / inappropriate request:** returned (2.38s): "I'm here to help you learn music, not spread negativity. Let's focus on creating something beautiful together!"
