/* Music theory helpers: notes, scales, chords, scale identification.
 * Pure functions, no DOM. Works in the browser (window.Theory) and Node (module.exports). */
(function (root) {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  // Keys conventionally written with flats.
  const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb']);

  // Intervals in semitones from the root, plus a beginner-facing blurb.
  const SCALES = {
    major:           { name: 'Major (Ionian)',   steps: [0, 2, 4, 5, 7, 9, 11], blurb: 'Bright and stable. The reference scale most theory is built on.' },
    minor:           { name: 'Natural Minor (Aeolian)', steps: [0, 2, 3, 5, 7, 8, 10], blurb: 'Darker, sadder sound. Shares its notes with the major scale a minor third above.' },
    harmonicMinor:   { name: 'Harmonic Minor',   steps: [0, 2, 3, 5, 7, 8, 11], blurb: 'Minor with a raised 7th, giving a strong pull back to the root. Common in classical and metal.' },
    melodicMinor:    { name: 'Melodic Minor',    steps: [0, 2, 3, 5, 7, 9, 11], blurb: 'Minor with raised 6th and 7th. Smooth for melodies and jazz lines.' },
    dorian:          { name: 'Dorian',           steps: [0, 2, 3, 5, 7, 9, 10], blurb: 'Minor with a bright 6th. Funk, soul and a lot of rock solos.' },
    phrygian:        { name: 'Phrygian',         steps: [0, 1, 3, 5, 7, 8, 10], blurb: 'Minor with a flat 2nd. Tense, Spanish or metal flavour.' },
    lydian:          { name: 'Lydian',           steps: [0, 2, 4, 6, 7, 9, 11], blurb: 'Major with a raised 4th. Dreamy, film-score sound.' },
    mixolydian:      { name: 'Mixolydian',       steps: [0, 2, 4, 5, 7, 9, 10], blurb: 'Major with a flat 7th. Blues-rock and classic rock riffs.' },
    locrian:         { name: 'Locrian',          steps: [0, 1, 3, 5, 6, 8, 10], blurb: 'Unstable, with a diminished 5th. Rarely used as a home key.' },
    majorPentatonic: { name: 'Major Pentatonic', steps: [0, 2, 4, 7, 9],        blurb: 'Five notes with no clashing half steps. Very hard to play a wrong note.' },
    minorPentatonic: { name: 'Minor Pentatonic', steps: [0, 3, 5, 7, 10],       blurb: 'The go-to scale for rock and blues soloing. Great first scale for improvising.' },
    blues:           { name: 'Blues',            steps: [0, 3, 5, 6, 7, 10],    blurb: 'Minor pentatonic plus the "blue note" (flat 5th) for extra grit.' },
  };

  const STEP_NAMES = { 1: 'H', 2: 'W', 3: 'W+H', 4: '2W' };
  const DEGREE_NAMES = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'];

  const mod12 = (n) => ((n % 12) + 12) % 12;

  function pcName(pc, keyRoot) {
    const useFlats = keyRoot != null && FLAT_KEYS.has(FLAT_NAMES[mod12(keyRoot)]);
    return (useFlats ? FLAT_NAMES : NOTE_NAMES)[mod12(pc)];
  }

  function midiName(midi) {
    return NOTE_NAMES[mod12(midi)] + (Math.floor(midi / 12) - 1);
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function parseNote(name) {
    const m = /^([A-Ga-g])([#b]?)$/.exec(String(name).trim());
    if (!m) return null;
    let pc = NOTE_NAMES.indexOf(m[1].toUpperCase());
    if (m[2] === '#') pc += 1;
    if (m[2] === 'b') pc -= 1;
    return mod12(pc);
  }

  function scalePitchClasses(rootPc, scaleId) {
    return SCALES[scaleId].steps.map((s) => mod12(rootPc + s));
  }

  function scaleFormula(scaleId) {
    const st = SCALES[scaleId].steps;
    const out = [];
    for (let i = 0; i < st.length; i++) {
      const next = i + 1 < st.length ? st[i + 1] : 12;
      out.push(STEP_NAMES[next - st[i]] || String(next - st[i]));
    }
    return out.join(' – ');
  }

  function scaleLabel(rootPc, scaleId) {
    return pcName(rootPc, rootPc) + ' ' + SCALES[scaleId].name;
  }

  // ---- Chords ---------------------------------------------------------
  const TRIADS = {
    maj: { intervals: [0, 4, 7], suffix: '' },
    min: { intervals: [0, 3, 7], suffix: 'm' },
    dim: { intervals: [0, 3, 6], suffix: '°' },
    aug: { intervals: [0, 4, 8], suffix: '+' },
  };
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

  function chordName(rootPc, quality, keyRoot) {
    return pcName(rootPc, keyRoot) + TRIADS[quality].suffix;
  }

  function chordPitchClasses(rootPc, quality) {
    return TRIADS[quality].intervals.map((i) => mod12(rootPc + i));
  }

  // Diatonic triads for 7-note scales (stacked thirds within the scale).
  function diatonicChords(rootPc, scaleId) {
    const steps = SCALES[scaleId].steps;
    if (steps.length !== 7) return [];
    const chords = [];
    for (let d = 0; d < 7; d++) {
      const r = steps[d], t = steps[(d + 2) % 7] + (d + 2 >= 7 ? 12 : 0), f = steps[(d + 4) % 7] + (d + 4 >= 7 ? 12 : 0);
      const third = t - r, fifth = f - r;
      let quality = 'maj';
      if (third === 3 && fifth === 7) quality = 'min';
      else if (third === 3 && fifth === 6) quality = 'dim';
      else if (third === 4 && fifth === 8) quality = 'aug';
      let roman = ROMAN[d];
      if (quality === 'min' || quality === 'dim') roman = roman.toLowerCase();
      if (quality === 'dim') roman += '°';
      if (quality === 'aug') roman += '+';
      const pc = mod12(rootPc + r);
      chords.push({ degree: d, roman, rootPc: pc, quality, name: chordName(pc, quality, rootPc), pcs: chordPitchClasses(pc, quality) });
    }
    return chords;
  }

  // ---- Scale identification from played notes ---------------------------
  /* Input: weights per pitch class (array of 12, e.g. how often each was played).
   * Ranks every root x scale. Score = share of played weight that is inside the scale,
   * with a small penalty for scale notes that were never played and a bonus when the
   * most-played note is the root. These are rule-based fits, not model probabilities,
   * so we report them as "fits N of M notes" rather than as a percentage. */
  function identifyScales(weights, opts) {
    opts = opts || {};
    const scaleIds = opts.scaleIds || Object.keys(SCALES);
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    const playedPcs = weights.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
    let topPc = 0;
    for (let i = 1; i < 12; i++) if (weights[i] > weights[topPc]) topPc = i;
    const lastPc = opts.lastPc;
    const results = [];
    for (const id of scaleIds) {
      for (let r = 0; r < 12; r++) {
        const pcs = scalePitchClasses(r, id);
        const set = new Set(pcs);
        let inside = 0;
        for (let i = 0; i < 12; i++) if (set.has(i)) inside += weights[i];
        const covered = playedPcs.filter((pc) => set.has(pc)).length;
        const unused = pcs.filter((pc) => weights[pc] === 0).length;
        let score = inside / total - 0.03 * unused;
        if (r === topPc) score += 0.04;
        if (lastPc != null && r === lastPc) score += 0.03;
        // Prefer the common parent scales when ties happen.
        if (id === 'major' || id === 'minor') score += 0.005;
        results.push({ rootPc: r, scaleId: id, label: scaleLabel(r, id), score, covered, played: playedPcs.length, outside: playedPcs.filter((pc) => !set.has(pc)) });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, opts.limit || 5);
  }

  // ---- Key detection from a chroma vector (Krumhansl–Kessler profiles) ----
  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  function detectKey(chroma) {
    const cands = [];
    for (let r = 0; r < 12; r++) {
      const rot = (p) => p.map((_, i) => p[mod12(i - r)]);
      cands.push({ rootPc: r, scaleId: 'major', label: scaleLabel(r, 'major'), corr: pearson(chroma, rot(KK_MAJOR)) });
      cands.push({ rootPc: r, scaleId: 'minor', label: scaleLabel(r, 'minor'), corr: pearson(chroma, rot(KK_MINOR)) });
    }
    cands.sort((a, b) => b.corr - a.corr);
    return cands;
  }

  /* Plain-language confidence for key detection. The correlation is a real, meaningful
   * number, but users act on "how sure" not on r = 0.83, so we map it to three bands
   * using both the absolute fit and the gap to the runner-up. Relative major/minor
   * share all their notes, so a near-tie between them is reported as such, not as failure. */
  function keyConfidence(cands) {
    const best = cands[0], second = cands[1];
    const gap = best.corr - second.corr;
    const relative = second.scaleId !== best.scaleId &&
      ((best.scaleId === 'major' && second.rootPc === mod12(best.rootPc + 9)) ||
       (best.scaleId === 'minor' && second.rootPc === mod12(best.rootPc + 3)));
    let level;
    if (best.corr >= 0.75 && (gap >= 0.08 || relative)) level = 'high';
    else if (best.corr >= 0.55) level = 'medium';
    else level = 'low';
    return { level, best: best.corr, gap, relativeTie: relative && gap < 0.08 };
  }

  // ---- Suggested phrases ----------------------------------------------
  /* Builds a short melodic idea over a chord, staying in the scale: starts on a chord tone,
   * moves mostly stepwise, lands on a chord tone. Deterministic given the seed so
   * "regenerate" can step through variations and "undo" can go back. */
  function suggestPhrase(opts) {
    // start: continue from a note the player chose (it becomes the phrase's first note).
    const { scalePcs, chordPcs, lowMidi, highMidi, length = 4, seed = 1, start = null } = opts;
    let s = seed >>> 0 || 1;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const inScale = [];
    for (let m = lowMidi; m <= highMidi; m++) if (scalePcs.includes(mod12(m))) inScale.push(m);
    if (!inScale.length) return [];
    const chordTones = inScale.filter((m) => chordPcs.includes(mod12(m)));
    const mid = (lowMidi + highMidi) / 2;
    const startPool = chordTones.length ? chordTones : inScale;
    // Bias the start towards the middle of the keyboard.
    startPool.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    let idx = inScale.indexOf(startPool[Math.floor(rand() * Math.min(4, startPool.length))]);
    if (start != null) {
      // Nearest in-scale note to the chosen one (same note when it is in the scale).
      idx = inScale.reduce((b, m, i) => (Math.abs(m - start) < Math.abs(inScale[b] - start) ? i : b), 0);
    }
    const out = [inScale[idx]];
    for (let i = 1; i < length; i++) {
      const r = rand();
      const step = r < 0.4 ? 1 : r < 0.8 ? -1 : r < 0.9 ? 2 : -2;
      idx = Math.max(0, Math.min(inScale.length - 1, idx + step));
      if (i === length - 1 && chordTones.length) {
        // Resolve to the nearest chord tone.
        const cur = inScale[idx];
        const nearest = chordTones.reduce((b, m) => (Math.abs(m - cur) < Math.abs(b - cur) ? m : b), chordTones[0]);
        out.push(nearest);
      } else {
        out.push(inScale[idx]);
      }
    }
    return out;
  }

  // ---- Staff notation: key signatures and note spelling ------------------------------------------
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];   // C D E F G A B
  const LETTERS = 'CDEFGAB';
  // Where a key's notes come from: semitones from the parent major's tonic up to this scale's root.
  const MODE_OF_MAJOR = { major: 0, majorPentatonic: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7,
    minor: 9, harmonicMinor: 9, melodicMinor: 9, minorPentatonic: 9, blues: 9, locrian: 11 };
  // Sharps (+) or flats (-) in the key signature of each major key, by tonic pitch class.
  const MAJOR_SIG = [0, -5, 2, -3, 4, -1, -6, 1, -4, 3, -2, 5];   // G♭ rather than F♯, as the key labels name it
  const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6], FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];   // letters, F C G D A E B / B E A D G C F
  /* Key signature for a key: { count (sharps > 0, flats < 0), acc[letter] (+1, -1 or 0), letters (in signature order) }.
   * Modes and minor scales use their parent major's signature (A minor = C major, no accidentals). */
  function keySignature(rootPc, scaleId) {
    const parent = mod12(rootPc - (MODE_OF_MAJOR[scaleId] != null ? MODE_OF_MAJOR[scaleId] : 0));
    const count = MAJOR_SIG[parent];
    const acc = [0, 0, 0, 0, 0, 0, 0];
    const letters = (count >= 0 ? SHARP_ORDER : FLAT_ORDER).slice(0, Math.abs(count));
    letters.forEach((l) => { acc[l] = count > 0 ? 1 : -1; });
    return { count, acc, letters };
  }
  /* Spells a MIDI note in a key: { letter (0 = C … 6 = B), acc (-2…2), octave, dia (diatonic number,
   * octave*7 + letter), name ('F♯') }. Notes in the key take the signature's spelling; others prefer
   * the key's direction (sharps in sharp keys, flats in flat keys), and a natural over a double accidental. */
  function spellNote(midi, sig) {
    sig = sig || keySignature(0, 'major');
    const pc = mod12(midi);
    let best = null, bestScore = Infinity;
    for (let l = 0; l < 7; l++) {
      let a = pc - LETTER_PC[l];
      if (a > 6) a -= 12; if (a < -6) a += 12;
      if (Math.abs(a) > 2) continue;
      let score = Math.abs(a) * 2;
      if (a === sig.acc[l]) score -= 10;                          // what the key signature already says
      else if ((sig.count >= 0 && a < 0) || (sig.count < 0 && a > 0)) score += 1;
      if (score < bestScore) { bestScore = score; best = { letter: l, acc: a }; }
    }
    const octave = Math.floor((midi - best.acc) / 12) - 1;
    const name = LETTERS[best.letter] + (best.acc > 0 ? '♯'.repeat(best.acc) : best.acc < 0 ? '♭'.repeat(-best.acc) : '');
    return { letter: best.letter, acc: best.acc, octave, dia: octave * 7 + best.letter, name };
  }

  const Theory = {
    NOTE_NAMES, FLAT_NAMES, SCALES, DEGREE_NAMES, TRIADS,
    mod12, pcName, midiName, midiToFreq, parseNote,
    scalePitchClasses, scaleFormula, scaleLabel,
    chordName, chordPitchClasses, diatonicChords,
    identifyScales, detectKey, keyConfidence, pearson, suggestPhrase,
    keySignature, spellNote,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Theory;
  else root.Theory = Theory;
})(typeof window !== 'undefined' ? window : globalThis);
