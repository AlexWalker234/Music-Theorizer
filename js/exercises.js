/* Exercises: a step-by-step course from the keyboard's note names to seventh chords, modes and
 * progressions, plus exercises made for any scale the user picks. Every question is answered on the
 * keyboard; the app checks what is played (one note, notes in order, or a chord held together).
 *
 * Exercises.COURSE: levels -> lessons, each { id, title, learn, gen(ctx) -> question, count }.
 * Exercises.forScale(root, scaleId) -> custom exercises with a difficulty (1 easy .. 3 hard).
 * A question: { prompt, kind: 'note' | 'seq' | 'chord', want: [pcs or midis], exact (octave matters),
 *   start (a reference key to mark), bass (pc the lowest note must be), hear: [{ midis, beats }],
 *   ear (play it first and don't show the answer), explain (shown after it is answered), hideNames }. */
(function (root) {
  'use strict';
  const T = root.Theory;
  const mod12 = T.mod12;

  const pick = (rng, a) => a[Math.floor(rng() * a.length)];
  const shuffle = (rng, a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const nm = (pc, key) => T.pcName(pc, key == null ? pc : key);
  const an = (name) => (/^[AEF]/.test(name) ? 'an ' : 'a ') + name;
  const WHITE = [0, 2, 4, 5, 7, 9, 11], BLACK = [1, 3, 6, 8, 10];
  const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
  const INTERVALS = { 1: 'half step', 2: 'whole step', 3: 'minor 3rd', 4: 'major 3rd', 5: 'perfect 4th', 7: 'perfect 5th', 9: 'major 6th', 12: 'octave' };
  const SEVENTHS = { maj7: { iv: [0, 4, 7, 11], suffix: 'maj7', say: 'major 7th' }, dom7: { iv: [0, 4, 7, 10], suffix: '7', say: 'dominant 7th' }, m7: { iv: [0, 3, 7, 10], suffix: 'm7', say: 'minor 7th' } };

  // The key of `pc` closest to `prefer` that fits on the keyboard (and leaves `room` semitones above it).
  function midiIn(ctx, pc, room, prefer) {
    room = room || 0; prefer = prefer == null ? 60 : prefer;
    let best = null;
    for (let m = ctx.lo; m + room <= ctx.hi; m++) if (mod12(m) === mod12(pc) && (best == null || Math.abs(m - prefer) < Math.abs(best - prefer))) best = m;
    return best == null ? ctx.lo + mod12(pc - ctx.lo) : best;
  }
  const ev = (midis, beats) => ({ midis: [].concat(midis), beats: beats || 1 });
  const scaleMidis = (ctx, rootPc, scaleId, octave) => {
    const st = T.SCALES[scaleId].steps, base = midiIn(ctx, rootPc, 12, 60);
    return st.map((s) => base + s).concat(octave === false ? [] : [base + 12]);
  };
  const chordMidis = (ctx, rootPc, iv) => { const b = midiIn(ctx, rootPc, iv[iv.length - 1], 55); return iv.map((i) => b + i); };
  // Each lesson's questions come from `gen(ctx, i)`; this keeps them from repeating back to back.
  function deck(ctx, items) {
    const k = '_deck' + items.length + items[0];
    if (!ctx[k] || !ctx[k].length) ctx[k] = shuffle(ctx.rng, items);
    return ctx[k].pop();
  }

  // ---- The course ---------------------------------------------------------------------------
  const COURSE = [
    { level: 1, title: 'The keyboard', lessons: [
      { id: 'k-c', title: 'Find C', count: 4,
        learn: 'The black keys come in groups of two and three. C is the white key just left of every group of two. Middle C (C4) is the C nearest the middle of the keyboard.',
        gen(ctx, i) {
          if (i === 0) return { prompt: 'Play any C.', kind: 'note', want: [0], hideNames: true, explain: 'Every C sits just left of a pair of black keys.' };
          const m = i === 1 ? midiIn(ctx, 0, 0, 60) : pick(ctx.rng, [midiIn(ctx, 0, 0, 48), midiIn(ctx, 0, 0, 72), midiIn(ctx, 0, 0, 60)]);
          return { prompt: `Play ${T.midiName(m)}${m === 60 ? ' (middle C)' : ''}.`, kind: 'note', want: [m], exact: true, hideNames: true,
            explain: 'The number is the octave: C4 is middle C, C5 is the next C up, C3 the one below.' };
        } },
      { id: 'k-white', title: 'White key names', count: 7,
        learn: 'The white keys are named with the first seven letters, A to G, and then the pattern repeats: C D E F G A B C. Use C as your landmark and count up.',
        gen(ctx) { const pc = deck(ctx, WHITE); return { prompt: `Play ${an(nm(pc))}.`, kind: 'note', want: [pc], hideNames: true, explain: `${nm(pc)} is ${['the C itself', '', 'one white key right of C', '', 'two right of C', 'just left of the group of three black keys', '', 'inside the group of three, after F', '', 'inside the group of three, after G', '', 'just left of the next C'][pc]}.` }; } },
      { id: 'k-black', title: 'Sharps and flats', count: 6,
        learn: 'A sharp (♯) is the key just to the right, a flat (♭) the key just to the left. So the black key between C and D is both C♯ and D♭: two names for the same key.',
        gen(ctx) {
          const pc = deck(ctx, BLACK), flat = ctx.rng() < 0.5;
          const name = flat ? T.FLAT_NAMES[pc] : T.NOTE_NAMES[pc];
          return { prompt: `Play ${name.replace('#', '♯').replace('b', '♭')}.`, kind: 'note', want: [pc], hideNames: true,
            explain: `${T.NOTE_NAMES[pc]} and ${T.FLAT_NAMES[pc]} are the same key.`.replace(/#/g, '♯').replace(/([A-G])b/g, '$1♭') };
        } },
      { id: 'k-oct', title: 'Octaves', count: 5,
        learn: 'An octave is the same note 12 keys (8 white keys) higher or lower. It sounds like the same note, just higher.',
        gen(ctx) {
          const pc = pick(ctx.rng, WHITE.concat(BLACK)), up = ctx.rng() < 0.6;
          const s = midiIn(ctx, pc, 0, up ? 57 : 69), t = up ? s + 12 : s - 12;
          const ok = t >= ctx.lo && t <= ctx.hi ? t : s + (up ? -12 : 12);
          return { prompt: `The marked key is ${nm(pc)}. Play the ${nm(pc)} one octave ${ok > s ? 'higher' : 'lower'}.`, kind: 'note', want: [ok], exact: true, start: s, hear: [ev(s), ev(ok)] };
        } },
    ] },
    { level: 2, title: 'Steps and intervals', lessons: [
      { id: 's-half', title: 'Half steps', count: 6,
        learn: 'A half step is the very next key, black or white. Between E and F, and between B and C, there is no black key, so those white keys are a half step apart.',
        gen(ctx) {
          const s = midiIn(ctx, pick(ctx.rng, [0, 2, 4, 5, 7, 9, 11, 1, 6]), 1, 60 + Math.floor(ctx.rng() * 8)), up = ctx.rng() < 0.6, t = s + (up ? 1 : -1);
          return { prompt: `Play the note a half step ${up ? 'above' : 'below'} the marked ${nm(mod12(s))}.`, kind: 'note', want: [t], exact: true, start: s, hear: [ev(s), ev(t)], explain: `${T.midiName(s)} → ${T.midiName(t)}.` };
        } },
      { id: 's-whole', title: 'Whole steps', count: 6,
        learn: 'A whole step is two half steps: skip one key. From C a whole step up is D; from E it is F♯ (because E to F is only a half step).',
        gen(ctx) {
          const s = midiIn(ctx, pick(ctx.rng, [0, 2, 4, 5, 7, 9, 11]), 2, 62), up = ctx.rng() < 0.7, t = s + (up ? 2 : -2);
          return { prompt: `Play the note a whole step ${up ? 'above' : 'below'} the marked ${nm(mod12(s))}.`, kind: 'note', want: [t], exact: true, start: s, hear: [ev(s), ev(t)], explain: `${T.midiName(s)} → ${T.midiName(t)}.` };
        } },
      { id: 's-int', title: 'Intervals', count: 6,
        learn: 'An interval is the distance between two notes, counted in half steps: a minor 3rd is 3, a major 3rd 4, a perfect 4th 5, a perfect 5th 7 and an octave 12. 3rds and 5ths are what chords are made of.',
        gen(ctx) {
          const n = deck(ctx, [3, 4, 5, 7, 9, 12]), s = midiIn(ctx, pick(ctx.rng, [0, 2, 5, 7, 9]), n, 57), t = s + n;
          return { prompt: `Play a ${INTERVALS[n]} above the marked ${nm(mod12(s))} (${n} half steps).`, kind: 'note', want: [t], exact: true, start: s, hear: [ev(s), ev(t)], explain: `A ${INTERVALS[n]} above ${nm(mod12(s))} is ${T.midiName(t)}.` };
        } },
      { id: 's-ear', title: 'Ear: play it back', count: 6,
        learn: 'Listening is part of theory too. You will hear the marked note and then a second note. Find the second one: is it higher or lower, and by how much?',
        gen(ctx) {
          const s = midiIn(ctx, 0, 12, 60), n = pick(ctx.rng, [2, 4, 5, 7, 9, 12]), t = s + n;
          return { prompt: 'Listen: the marked C, then another note. Play the second note.', kind: 'note', want: [t], exact: true, start: s, ear: true, hear: [ev(s), ev(t)], explain: `It was ${T.midiName(t)}, a ${INTERVALS[n]} above C.` };
        } },
    ] },
    { level: 3, title: 'Scales', lessons: [
      { id: 'sc-c', title: 'The C major scale', count: 2,
        learn: 'A major scale follows the step pattern whole, whole, half, whole, whole, whole, half. Starting on C that gives only white keys: C D E F G A B C.',
        gen(ctx, i) { const m = scaleMidis(ctx, 0, 'major'); return { prompt: i ? 'Now play C major going down, from the high C.' : 'Play the C major scale going up, from C to the next C.', kind: 'seq', want: (i ? m.slice().reverse() : m).map(mod12), hear: (i ? m.slice().reverse() : m).map((x) => ev(x, 0.5)) }; } },
      { id: 'sc-major', title: 'Major scales', count: 3,
        learn: 'Start the same pattern (W W H W W W H) on another note and black keys appear. G major needs F♯, F major needs B♭, D major needs F♯ and C♯.',
        gen(ctx) { const r = deck(ctx, [7, 5, 2]), m = scaleMidis(ctx, r, 'major'); return { prompt: `Play the ${nm(r)} major scale going up (W W H W W W H).`, kind: 'seq', want: m.map(mod12), hear: m.map((x) => ev(x, 0.5)), explain: `${nm(r)} major: ${m.map((x) => nm(mod12(x), r)).join(' ')}.` }; } },
      { id: 'sc-minor', title: 'Natural minor scales', count: 3,
        learn: 'The natural minor pattern is W H W W H W W. It sounds darker. A minor uses the same white keys as C major, just starting on A: they are relative keys.',
        gen(ctx) { const r = deck(ctx, [9, 4, 2]), m = scaleMidis(ctx, r, 'minor'); return { prompt: `Play the ${nm(r)} natural minor scale going up (W H W W H W W).`, kind: 'seq', want: m.map(mod12), hear: m.map((x) => ev(x, 0.5)), explain: `${nm(r)} minor: ${m.map((x) => nm(mod12(x), r)).join(' ')}.` }; } },
      { id: 'sc-pent', title: 'Pentatonic scales', count: 3,
        learn: 'Pentatonic scales have five notes and no half steps, so they are very hard to get wrong. The minor pentatonic is the classic rock and blues solo scale: 1, ♭3, 4, 5, ♭7.',
        gen(ctx) { const r = deck(ctx, [9, 4, 7]), id = r === 7 ? 'majorPentatonic' : 'minorPentatonic', m = scaleMidis(ctx, r, id); return { prompt: `Play the ${nm(r)} ${T.SCALES[id].name.toLowerCase()} scale going up.`, kind: 'seq', want: m.map(mod12), hear: m.map((x) => ev(x, 0.5)), explain: `${m.map((x) => nm(mod12(x), r)).join(' ')}.` }; } },
    ] },
    { level: 4, title: 'Chords', lessons: [
      { id: 'c-maj', title: 'Major chords', count: 5,
        learn: 'A major chord (triad) is a root, the major 3rd above it (4 half steps) and the perfect 5th (7 half steps). Play the three keys together. C major is C E G.',
        gen(ctx) { const r = deck(ctx, [0, 7, 5, 2, 9, 4]), pcs = T.chordPitchClasses(r, 'maj'); return { prompt: `Play ${an(nm(r))} major chord (hold the three notes together).`, kind: 'chord', want: pcs, hear: [ev(chordMidis(ctx, r, [0, 4, 7]), 2)], explain: `${nm(r)} major: ${pcs.map((p) => nm(p, r)).join(' ')}.` }; } },
      { id: 'c-min', title: 'Minor chords', count: 5,
        learn: 'A minor chord lowers the 3rd by a half step: root, minor 3rd (3 half steps), perfect 5th. A minor is A C E. Compare how it sounds with A major (A C♯ E).',
        gen(ctx) { const r = deck(ctx, [9, 2, 4, 0, 7, 5]), pcs = T.chordPitchClasses(r, 'min'); return { prompt: `Play ${an(nm(r))} minor chord (${nm(r)}m).`, kind: 'chord', want: pcs, hear: [ev(chordMidis(ctx, r, [0, 3, 7]), 2)], explain: `${nm(r)}m: ${pcs.map((p) => nm(p, r)).join(' ')}.` }; } },
      { id: 'c-key', title: 'Chords in a key', count: 6,
        learn: 'Stack every other note of a scale and you get its chords. In a major key, I, IV and V are major, ii, iii and vi are minor. Roman numerals name a chord by its place in the key.',
        gen(ctx) {
          const k = pick(ctx.rng, [0, 7, 5]), d = deck(ctx, [0, 3, 4, 5, 1]), c = T.diatonicChords(k, 'major')[d];
          return { prompt: `In ${nm(k)} major, play the ${c.roman} chord.`, kind: 'chord', want: c.pcs, hear: [ev(chordMidis(ctx, c.rootPc, c.quality === 'min' ? [0, 3, 7] : [0, 4, 7]), 2)], explain: `${c.roman} in ${nm(k)} major is ${c.name}: ${c.pcs.map((p) => nm(p, k)).join(' ')}.` };
        } },
      { id: 'c-ear', title: 'Ear: major or minor', count: 6,
        learn: 'Major chords sound bright, minor chords darker. Listen to the chord on the marked root, then play it back: decide whether its middle note is the major or the minor 3rd.',
        gen(ctx) {
          const r = pick(ctx.rng, [0, 2, 5, 7, 9]), q = ctx.rng() < 0.5 ? 'maj' : 'min', iv = q === 'maj' ? [0, 4, 7] : [0, 3, 7], ms = chordMidis(ctx, r, iv);
          return { prompt: `Listen to the chord on ${nm(r)}, then play it back.`, kind: 'chord', want: T.chordPitchClasses(r, q), start: ms[0], ear: true, hear: [ev(ms, 2)], explain: `It was ${nm(r)} ${q === 'maj' ? 'major' : 'minor'}.` };
        } },
    ] },
    { level: 5, title: 'Going further', lessons: [
      { id: 'a-7th', title: 'Seventh chords', count: 6,
        learn: 'Add one more 3rd on top of a triad and you get a seventh chord. maj7 = major triad + major 7th (dreamy), 7 = major triad + minor 7th (bluesy, wants to resolve), m7 = minor triad + minor 7th (smooth).',
        gen(ctx) { const r = pick(ctx.rng, [0, 2, 5, 7, 9]), q = deck(ctx, ['maj7', 'dom7', 'm7']), s = SEVENTHS[q], pcs = s.iv.map((i) => mod12(r + i)); return { prompt: `Play ${nm(r)}${s.suffix} (a ${s.say} chord, four notes).`, kind: 'chord', want: pcs, hear: [ev(chordMidis(ctx, r, s.iv), 2)], explain: `${nm(r)}${s.suffix}: ${pcs.map((p) => nm(p, r)).join(' ')}.` }; } },
      { id: 'a-inv', title: 'Inversions', count: 5,
        learn: 'An inversion is a chord with a note other than the root at the bottom. C/E means a C chord with E as the lowest note (1st inversion); C/G has G at the bottom (2nd inversion). Same notes, smoother movement between chords.',
        gen(ctx) {
          const r = pick(ctx.rng, [0, 5, 7, 2, 9]), q = ctx.rng() < 0.6 ? 'maj' : 'min', pcs = T.chordPitchClasses(r, q), b = pick(ctx.rng, [1, 2]);
          const name = nm(r) + (q === 'min' ? 'm' : '') + '/' + nm(pcs[b], r);
          return { prompt: `Play ${name}: the ${nm(r)}${q === 'min' ? 'm' : ''} chord with ${nm(pcs[b], r)} as the lowest note.`, kind: 'chord', want: pcs, bass: pcs[b], explain: `${name}: ${nm(pcs[b], r)} at the bottom, then ${pcs.filter((_, i) => i !== b).map((p) => nm(p, r)).join(' and ')} above.` };
        } },
      { id: 'a-modes', title: 'Modes', count: 4,
        learn: 'Play the C major scale\'s white keys starting on another note and you get a mode, each with its own mood: D Dorian (minor with a bright 6th), E Phrygian (Spanish), F Lydian (dreamy), G Mixolydian (bluesy major).',
        gen(ctx) { const [r, id] = deck(ctx, [[2, 'dorian'], [4, 'phrygian'], [5, 'lydian'], [7, 'mixolydian']]), m = scaleMidis(ctx, r, id); return { prompt: `Play ${nm(r)} ${T.SCALES[id].name} going up: only white keys, from ${nm(r)} to ${nm(r)}.`, kind: 'seq', want: m.map(mod12), hear: m.map((x) => ev(x, 0.5)), explain: T.SCALES[id].blurb }; } },
      { id: 'a-prog', title: 'Progressions', count: 8,
        learn: 'A progression is a chord sequence. I–V–vi–IV is in countless pop songs. Play each chord when asked; the progression is shown as you go.',
        gen(ctx, i) {
          const k = i < 4 ? 0 : 7, degs = [0, 4, 5, 3], d = degs[i % 4], c = T.diatonicChords(k, 'major')[d];
          return { prompt: `${nm(k)} major, I–V–vi–IV. Chord ${(i % 4) + 1} of 4: ${c.roman} (${c.name}).`, kind: 'chord', want: c.pcs, hear: [ev(chordMidis(ctx, c.rootPc, c.quality === 'min' ? [0, 3, 7] : [0, 4, 7]), 2)], explain: `${c.name}: ${c.pcs.map((p) => nm(p, k)).join(' ')}.` };
        } },
    ] },
  ];
  const LESSONS = COURSE.flatMap((l) => l.lessons.map((x) => Object.assign(x, { level: l.level, levelTitle: l.title,
    text: root.LessonText && root.LessonText[x.id] ? Object.assign({ key: x.id }, root.LessonText[x.id]) : null })));

  // ---- Exercises for any scale --------------------------------------------------------------
  // Easier scales to suggest to beginners, and how hard each scale is to start with.
  const EASY_SCALES = [[0, 'major'], [9, 'minor'], [9, 'minorPentatonic'], [7, 'major'], [0, 'majorPentatonic'], [2, 'minor']];
  function scaleDifficulty(rootPc, scaleId) {
    const black = T.scalePitchClasses(rootPc, scaleId).filter((pc) => BLACK.includes(pc)).length;
    const hardType = ['harmonicMinor', 'melodicMinor', 'phrygian', 'lydian', 'locrian', 'blues'].includes(scaleId) ? 1 : ['dorian', 'mixolydian'].includes(scaleId) ? 0.5 : 0;
    return black + 4 * hardType;   // 0-1 easy, 2-3 medium, 4+ hard
  }

  // Reading and quiz shared by every exercise for one scale.
  function scaleText(rootPc, scaleId) {
    const st = T.SCALES[scaleId].steps, n = st.length, label = T.scaleLabel(rootPc, scaleId);
    const pcs = st.map((x) => mod12(rootPc + x)), names = pcs.map((pc) => nm(pc, rootPc));
    const out = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((pc) => !pcs.includes(pc)).map((pc) => nm(pc, rootPc));
    const rot = (a, k) => a.slice(k).concat(a.slice(0, k));
    const read = [
      `${label} has ${n} notes: ${names.join(' ')}. ${T.SCALES[scaleId].blurb}`,
      `Its step pattern is ${T.scaleFormula(scaleId)} (W is a whole step, H a half step; bigger gaps are written as W+H). Start that pattern on any note and you get the same scale in another key.`,
      `Counting from the root the notes are ${names.map((x, i) => ORD[i] + ' ' + x).join(', ')}. Musicians also name each note by its distance from the root, its degree: ${names.map((x, i) => x + ' = ' + T.DEGREE_NAMES[st[i]]).join(', ')}. The root, ${names[0]}, is home: phrases that end on it sound finished.${st.includes(7) ? ' The note a perfect 5th above it, ' + nm(mod12(rootPc + 7), rootPc) + ', is the next most stable.' : ''}`,
    ];
    if (n === 7) { const dia = T.diatonicChords(rootPc, scaleId); read.push(`Stacking 3rds on each note gives the scale\u2019s chords: ${dia.map((c) => c.name + ' (' + c.roman + ')').join(', ')}.`); }
    const quiz = [
      { q: `How many different notes does ${label} have?`, options: ['5', '6', '7', '8'], answer: ['5', '6', '7', '8'].indexOf(String(n)), why: `${n}: ${names.join(' ')}.` },
      { q: `Which note is the ${ORD[2]} note of ${label}?`, options: [names[2], names[1], names[3] || out[0], out[1] || out[0]].filter((x, i, a) => a.indexOf(x) === i), answer: 0, why: `Counting from the root: ${names.slice(0, 3).join(', ')}.` },
      { q: `Which note is NOT in ${label}?`, options: [out[Math.floor(out.length / 2)], names[1], names[3], names[n - 1]], answer: 0, why: `${label} is ${names.join(' ')}, so ${out[Math.floor(out.length / 2)]} is not in it.` },
      { q: `What is ${label}\u2019s step pattern?`, options: [T.scaleFormula(scaleId)].concat(Object.keys(T.SCALES).filter((k) => k !== scaleId && T.scaleFormula(k) !== T.scaleFormula(scaleId) && T.SCALES[k].steps.length === n).slice(0, 2).map(T.scaleFormula)), answer: 0, why: T.scaleFormula(scaleId) + '.' },
    ];
    if (n === 7) { const dia = T.diatonicChords(rootPc, scaleId); quiz.push({ q: `Which chord is built on the root (the I chord) of ${label}?`, options: [dia[0].name, dia[4].name, dia[3].name, dia[1].name], answer: 0, why: `${dia[0].name}: ${dia[0].pcs.map((p) => nm(p, rootPc)).join(' ')}.` }); }
    void rot;
    return { key: 'scale:' + rootPc + ':' + scaleId, read, quiz: quiz.filter((x) => x.options.length >= 2 && x.answer >= 0) };
  }

  function forScale(rootPc, scaleId) {
    const st = T.SCALES[scaleId].steps, n = st.length, label = T.scaleLabel(rootPc, scaleId), seven = n === 7;
    const names = (ms) => ms.map((m) => nm(mod12(m), rootPc)).join(' ');
    const list = [
      { id: 'up', diff: 1, title: 'Scale going up', learn: `${label}: ${st.map((s) => nm(mod12(rootPc + s), rootPc)).join(' ')}. Play it from the root up to the next root.`, count: 2,
        gen(ctx) { const m = scaleMidis(ctx, rootPc, scaleId); return { prompt: `Play ${label} going up.`, kind: 'seq', want: m.map(mod12), hear: m.map((x) => ev(x, 0.5)), explain: names(m) }; } },
      { id: 'root', diff: 1, title: 'Find the root', learn: `The root, ${nm(rootPc)}, is home: melodies in this scale feel finished when they land on it.`, count: 3,
        gen(ctx, i) { const m = midiIn(ctx, rootPc, 0, [60, 48, 72][i % 3]); return { prompt: `Play the root of ${label} in this octave: ${T.midiName(m)}${m === 60 ? ' (middle C)' : ''}.`, kind: 'note', want: [m], exact: true }; } },
      { id: 'down', diff: 1, title: 'Scale going down', learn: 'Now the other way, from the high root down. Going down is often harder to remember: say the note names as you go.', count: 2,
        gen(ctx) { const m = scaleMidis(ctx, rootPc, scaleId).reverse(); return { prompt: `Play ${label} going down.`, kind: 'seq', want: m.map(mod12), hear: m.map((x) => ev(x, 0.5)), explain: names(m) }; } },
      { id: 'degree', diff: 2, title: 'Scale degrees', learn: 'Every note of a scale has a number, its degree: the root is 1. Musicians say "play the 5th" instead of a note name, so ideas work in any key.', count: 6,
        gen(ctx) { const d = deck(ctx, Array.from({ length: n - 1 }, (_, i) => i + 1)), pc = mod12(rootPc + st[d]); return { prompt: `Play the ${ORD[d]} note of ${label}.`, kind: 'note', want: [pc], hideNames: true, explain: `The ${ORD[d]} note is ${nm(pc, rootPc)}.` }; } },
      { id: 'ear', diff: 2, title: 'Ear: which note?', learn: 'You will hear the root, then another note from the scale. Play the second note back. Sing it first if that helps.', count: 6,
        gen(ctx) { const m = scaleMidis(ctx, rootPc, scaleId, false), t = m[1 + Math.floor(ctx.rng() * (m.length - 1))]; return { prompt: 'Listen: the marked root, then a note of the scale. Play the second note.', kind: 'note', want: [mod12(t)], start: m[0], ear: true, hear: [ev(m[0]), ev(t)], explain: `It was ${nm(mod12(t), rootPc)}, the ${ORD[m.indexOf(t)]} note.` }; } },
      { id: 'echo', diff: 2, title: 'Ear: copy the phrase', learn: 'Three notes of the scale are played. Play them back in the same order.', count: 4,
        gen(ctx) { const m = scaleMidis(ctx, rootPc, scaleId), a = Math.floor(ctx.rng() * (m.length - 2)), ph = ctx.rng() < 0.5 ? [m[a], m[a + 1], m[a + 2]] : [m[a + 2], m[a + 1], m[a]]; return { prompt: 'Listen, then play the three notes back in order.', kind: 'seq', want: ph.map(mod12), ear: true, hear: ph.map((x) => ev(x, 0.75)), explain: names(ph) }; } },
      { id: 'thirds', diff: 3, title: 'In 3rds', learn: 'Play the scale in pairs that skip a note: 1-3, 2-4, 3-5 … This is a classic finger and ear exercise, and it is how the scale\'s chords are built.', count: 1, minNotes: 5,
        gen(ctx) { const m = scaleMidis(ctx, rootPc, scaleId), seq = []; for (let i = 0; i + 2 < m.length; i++) seq.push(m[i], m[i + 2]); return { prompt: `Play ${label} in 3rds going up: ${names(seq.slice(0, 6))} …`, kind: 'seq', want: seq.map(mod12), hear: seq.map((x) => ev(x, 0.5)), explain: names(seq) }; } },
      { id: 'pattern', diff: 3, title: 'Pattern 1-2-3', learn: 'Groups of three going up the scale: 1-2-3, 2-3-4, 3-4-5 … Patterns like this are the building blocks of solos.', count: 1, minNotes: 5,
        gen(ctx) { const m = scaleMidis(ctx, rootPc, scaleId), seq = []; for (let i = 0; i + 2 < m.length; i++) seq.push(m[i], m[i + 1], m[i + 2]); return { prompt: `Play ${label} in groups of three: ${names(seq.slice(0, 6))} …`, kind: 'seq', want: seq.map(mod12), hear: seq.map((x) => ev(x, 0.4)), explain: names(seq) }; } },
    ];
    if (seven) {
      const dia = T.diatonicChords(rootPc, scaleId), main = [0, 3, 4].map((d) => dia[d]);
      const iv = (c) => ({ maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8] }[c.quality]);
      list.push(
        { id: 'chords145', diff: 2, title: 'Main chords (I, IV, V)', learn: `The chords on the 1st, 4th and 5th notes carry most songs. In ${label} they are ${main.map((c) => c.name + ' (' + c.roman + ')').join(', ')}.`, count: 3,
          gen(ctx, i) { const c = main[i % 3]; return { prompt: `Play ${c.name}, the ${c.roman} chord of ${label}.`, kind: 'chord', want: c.pcs, hear: [ev(chordMidis(ctx, c.rootPc, iv(c)), 2)], explain: `${c.name}: ${c.pcs.map((p) => nm(p, rootPc)).join(' ')}.` }; } },
        { id: 'chordsAll', diff: 3, title: 'All the chords of the scale', learn: `Every note of ${label} has its own chord: ${dia.map((c) => c.roman).join(' ')}. Find each one from its Roman numeral.`, count: 7,
          gen(ctx) { const c = dia[deck(ctx, [0, 1, 2, 3, 4, 5, 6])]; return { prompt: `Play the ${c.roman} chord of ${label}.`, kind: 'chord', want: c.pcs, hear: [ev(chordMidis(ctx, c.rootPc, iv(c)), 2)], explain: `${c.roman} is ${c.name}: ${c.pcs.map((p) => nm(p, rootPc)).join(' ')}.` }; } },
        { id: 'arp', diff: 3, title: 'Arpeggios', learn: 'An arpeggio plays a chord one note at a time. Play the I, IV and V chords as 1-3-5 going up.', count: 3,
          gen(ctx, i) { const c = main[i % 3], ms = chordMidis(ctx, c.rootPc, iv(c)); return { prompt: `Play ${c.name} as an arpeggio: its three notes one at a time, going up.`, kind: 'seq', want: ms.map(mod12), hear: ms.map((x) => ev(x, 0.5)), explain: names(ms) }; } });
    }
    const text = scaleText(rootPc, scaleId);
    return list.filter((x) => !x.minNotes || n >= x.minNotes).map((x) => Object.assign(x, { id: 'scale-' + x.id, custom: true, scale: [rootPc, scaleId], text }));
  }

  // ---- The Exercises screen -----------------------------------------------------------------
  /* api: { $, el, engine, keyEls, range() -> [lo, hi], renderKeys(), flashWrong(midi), settings, store, held (Set), scaleNow() -> [root, id] } */
  function create(api) {
    const { $, el } = api;
    const progress = Object.assign({ done: {}, quiz: {} }, api.store.get('exercises', {}));
    const save = () => api.store.set('exercises', progress);
    const S = { ex: null, q: null, i: 0, misses: 0, firstTry: 0, got: [], hint: false, timers: [], chordMiss: false, answered: false, scale: null };
    const beginner = () => api.settings.level !== 'advanced';
    const stars = (id) => (progress.done[id] || 0);

    function clearTimers() { S.timers.forEach(clearTimeout); S.timers = []; stopSound(); }
    function stopSound() { (S.sound || []).forEach(clearTimeout); S.sound = []; }
    function play(events, bpm, light) {
      stopSound();
      const beat = 60000 / (bpm || 100); let t = 50;
      for (const e of events) {
        const at = t, len = e.beats * beat;
        S.sound.push(setTimeout(() => e.midis.forEach((m) => { api.engine.noteOn(m, 0.75); if (light) { const k = api.keyEls.get(m); if (k) k.classList.add('down'); } }), at));
        S.sound.push(setTimeout(() => e.midis.forEach((m) => { if (!api.held.has(m)) api.engine.noteOff(m); const k = api.keyEls.get(m); if (k && !api.held.has(m)) k.classList.remove('down'); }), at + len * 0.9));
        t += len;
      }
    }
    function ctx() { const [lo, hi] = api.range(); return { lo, hi, rng: Math.random }; }

    /* Each exercise: read about the idea, a short quiz on it, then the keyboard questions. Once a
     * quiz has been passed the reading can be skipped next time. */
    const passed = (ex) => !!(ex.text && progress.quiz && progress.quiz[ex.text.key] != null);
    function start(ex, phase) {
      clearTimers();
      S.ex = ex; S.i = 0; S.misses = 0; S.firstTry = 0; S.ctx = ctx(); S.q = null; S.result = null; S.quizScore = null;
      S.phase = ex.text && phase !== 'play' ? 'read' : 'play';
      if (S.phase === 'play') return next(true);
      render(); api.renderKeys();
      const b = $('ex-body'); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
    }
    function startQuiz() {
      const qs = S.ex.text.quiz.map((x) => {
        const order = shuffle(Math.random, x.options.map((_, i) => i));
        return { q: x.q, why: x.why, options: order.map((i) => x.options[i]), answer: order.indexOf(x.answer) };
      });
      S.phase = 'quiz'; S.quiz = { qs, i: 0, tried: new Set(), solved: false, first: 0 };
      render();
    }
    function pickAnswer(k) {
      const z = S.quiz, x = z.qs[z.i];
      if (z.solved || z.tried.has(k)) return;
      z.tried.add(k);
      if (k === x.answer) { z.solved = true; if (z.tried.size === 1) z.first++; }
      render();
    }
    function nextQuiz() {
      const z = S.quiz;
      if (z.i + 1 < z.qs.length) { z.i++; z.tried = new Set(); z.solved = false; return render(); }
      progress.quiz = progress.quiz || {};
      progress.quiz[S.ex.text.key] = Math.max(progress.quiz[S.ex.text.key] || 0, z.first); save();
      S.quizScore = { first: z.first, total: z.qs.length };
      S.phase = 'play'; next(true);
    }
    function next(first) {
      clearTimers();
      if (!first) S.i++;
      if (S.i >= S.ex.count) return finish();
      S.q = S.ex.gen(S.ctx, S.i); S.got = []; S.hint = false; S.qMiss = 0; S.answered = false; S.chordMiss = false;
      render(); api.renderKeys();
      if (S.q.ear) S.timers.push(setTimeout(() => play(S.q.hear, 90, false), 350));
    }
    function finish() {
      const total = S.ex.count, score = S.firstTry;
      const st = score === total ? 3 : score >= total - 2 ? 2 : 1;
      progress.done[S.ex.id] = Math.max(stars(S.ex.id), st); save();
      S.result = { score, total, stars: st, quiz: S.quizScore || null };
      S.q = null;
      render(); api.renderKeys();
    }
    function stop() { clearTimers(); S.ex = null; S.q = null; S.result = null; render(); api.renderKeys(); }
    function correct() {
      if (S.answered) return;
      S.answered = true;
      if (S.qMiss === 0 && !S.hint) S.firstTry++;
      render('ok'); api.renderKeys();
      S.timers.push(setTimeout(() => next(false), S.q.explain ? 1500 : 800));
    }
    function wrong(midi) {
      api.flashWrong(midi);
      S.qMiss++; S.misses++;
      if (S.qMiss >= 3) S.hint = true;
      render('miss'); api.renderKeys();
    }

    // Keyboard input.
    function onNote(midi) {
      const q = S.q; if (!q || S.answered) return;
      const pc = mod12(midi);
      const match = (want) => (q.exact ? midi === want : pc === mod12(want));
      if (q.kind === 'note') return match(q.want[0]) ? correct() : wrong(midi);
      if (q.kind === 'seq') {
        if (match(q.want[S.got.length])) { S.got.push(midi); if (S.got.length === q.want.length) correct(); else { render(); api.renderKeys(); } }
        else if (S.got.length && match(q.want[S.got.length - 1]) && !q.exact) { /* repeated the last note: fine */ }
        else wrong(midi);
        return;
      }
      if (q.kind === 'chord') {
        const want = new Set(q.want.map(mod12));
        if (!want.has(pc)) { if (!S.chordMiss) { S.chordMiss = true; wrong(midi); } else api.flashWrong(midi); return; }
        const held = Array.from(api.held), pcs = new Set(held.map(mod12));
        if (held.every((m) => want.has(mod12(m))) && [...want].every((p) => pcs.has(p))) {
          // Right notes, wrong bottom note: not a miss (the bass may simply not be down yet), just a nudge.
          if (q.bass != null && mod12(Math.min(...held)) !== mod12(q.bass)) { render('bass'); return; }
          correct();
        } else { render(); }
      }
    }
    function onRelease() { if (S.q && S.q.kind === 'chord' && api.held.size === 0) S.chordMiss = false; }

    // What the keyboard shows: the reference key, the notes got so far, and the answer once "Show me" is on.
    function highlights(h) {
      const q = S.q; if (!q) return h;
      h.hideNames = !!q.hideNames && !S.hint && !S.answered;
      const done = new Set(S.got.map(mod12));
      if (q.start != null) { h.badges.set(q.start, { n: '★', ns: ['★'], next: false }); }
      if (done.size) { h.scale = done; h.root = null; }
      if (S.hint || S.answered) {
        if (q.exact) q.want.forEach((m, i) => { if (q.kind !== 'seq' || i >= S.got.length) h.badges.set(m, { n: q.kind === 'seq' ? i + 1 : '✓', ns: [q.kind === 'seq' ? i + 1 : '✓'], next: true }); });
        else h.chord = new Set(q.kind === 'seq' ? q.want.slice(S.got.length).map(mod12) : q.want.map(mod12));
        if (q.bass != null) { const [lo] = api.range(), m = lo + mod12(q.bass - lo); h.badges.set(m, { n: 'low', ns: ['low'], next: true }); }
      }
      return h;
    }

    // ---- Rendering ----
    function starRow(n) { return el('span', { class: 'ex-stars', 'aria-label': n + ' of 3 stars' }, '★'.repeat(n) + '☆'.repeat(3 - n)); }
    function card(ex, tag, highlight) {
      const s = stars(ex.id);
      return el('button', { class: 'ex-card' + (s ? ' done' : '') + (highlight ? ' rec' : ''), onclick: () => start(ex) },
        el('b', {}, ex.title), tag ? el('span', { class: 'ex-tag' + (tag === 'Challenge' ? ' hard' : '') }, tag) : null, el('small', {}, (ex.text ? 'Read, quiz, ' : '') + ex.count + (ex.text ? ' on the keyboard' : ex.count === 1 ? ' question' : ' questions')), starRow(s));
    }
    function nextLesson() { return LESSONS.find((l) => !stars(l.id)) || null; }
    function listView() {
      const nl = nextLesson();
      const levels = COURSE.map((lv) => el('div', { class: 'ex-level' },
        el('h3', {}, `Level ${lv.level}: ${lv.title}`, el('span', { class: 'note' }, ' ' + lv.lessons.filter((l) => stars(l.id)).length + ' of ' + lv.lessons.length + ' done')),
        el('div', { class: 'ex-grid' }, ...lv.lessons.map((l) => card(l, nl === l ? 'Next up' : null, nl === l)))));
      return [
        el('p', { class: 'lead' }, 'Short exercises you answer on the keyboard. The course starts with the basics and builds up to seventh chords, modes and progressions; "Practise a scale" makes exercises for any scale you choose.'),
        nl ? el('div', { class: 'row', style: 'margin:6px 0 12px' }, el('button', { class: 'btn primary', onclick: () => start(nl) }, '▶ Continue: ' + nl.title), el('span', { class: 'note' }, `Level ${nl.level}, ${nl.levelTitle}`)) : el('p', { class: 'state' }, 'You have finished the whole course. Try "Practise a scale" below with a new scale.'),
        el('h2', { class: 'ex-h' }, 'Course'), ...levels,
        el('h2', { class: 'ex-h' }, 'Practise a scale'), scaleView(),
        el('div', { class: 'row', style: 'margin-top:14px' }, el('button', { class: 'btn small', onclick: () => { if (confirm('Clear your exercise stars and quiz results?')) { progress.done = {}; progress.quiz = {}; save(); render(); } } }, 'Reset progress')),
      ];
    }
    function scaleView() {
      if (!S.scale) S.scale = api.scaleNow();
      const [r, id] = S.scale;
      const rootSel = el('select', { 'aria-label': 'Root' }, ...T.NOTE_NAMES.map((n, i) => el('option', { value: i }, T.pcName(i, i))));
      const typeSel = el('select', { 'aria-label': 'Scale' }, ...Object.entries(T.SCALES).map(([k, s]) => el('option', { value: k }, s.name)));
      rootSel.value = r; typeSel.value = id;
      rootSel.onchange = typeSel.onchange = () => { S.scale = [+rootSel.value, typeSel.value]; render(); };
      const diff = scaleDifficulty(r, id), list = forScale(r, id);
      // Beginners are pointed at the easy exercises first; harder ones unlock as the easy ones get stars.
      const easyDone = list.filter((x) => x.diff === 1).every((x) => stars(x.id) >= 2);
      const maxRec = beginner() ? (easyDone ? 2 : 1) : (list.filter((x) => x.diff <= 2).every((x) => stars(x.id) >= 2) ? 3 : 2);
      const rec = list.filter((x) => x.diff <= maxRec), later = list.filter((x) => x.diff > maxRec);
      const kids = [el('div', { class: 'row' }, el('label', {}, 'Root ', rootSel), el('label', {}, 'Scale ', typeSel),
        el('span', { class: 'note' }, ['', 'Easy scale', 'Medium scale', 'Harder scale'][diff <= 1 ? 1 : diff <= 3 ? 2 : 3]))];
      if (beginner() && diff > 3) {
        kids.push(el('div', { class: 'state uncertain' }, el('strong', {}, 'This scale is a harder one to start with. '), 'Easier scales with fewer black keys: ',
          ...EASY_SCALES.slice(0, 4).map(([er, eid]) => el('button', { class: 'btn small', style: 'margin:2px 4px', onclick: () => { S.scale = [er, eid]; render(); } }, T.scaleLabel(er, eid)))));
      }
      kids.push(el('h3', {}, beginner() ? 'Recommended for you' : 'Exercises'), el('div', { class: 'ex-grid' }, ...rec.map((x, i) => card(x, ['', 'Easy', 'Medium', 'Hard'][x.diff], i === rec.findIndex((y) => !stars(y.id))))));
      if (later.length) kids.push(el('h3', {}, 'When you’re ready', el('span', { class: 'note' }, beginner() ? ' Get 2 stars on the exercises above first, or try one now.' : ' Harder ones, after the others.')),
        el('div', { class: 'ex-grid later' }, ...later.map((x) => card(x, 'Challenge'))));
      return el('div', { class: 'ex-scale' }, ...kids);
    }
    function exView(flash) {
      const ex = S.ex, q = S.q;
      const head = el('div', { class: 'row ex-head' }, el('button', { class: 'btn small', onclick: stop }, '← All exercises'),
        el('strong', {}, ex.title), el('span', { class: 'note' }, ex.custom ? T.scaleLabel(ex.scale[0], ex.scale[1]) : `Level ${ex.level}, ${ex.levelTitle}`));
      if (S.result) {
        const nl = ex.custom ? null : nextLesson();
        return [head, el('div', { class: 'ex-done' }, starRow(S.result.stars),
          el('h3', {}, S.result.stars === 3 ? 'Perfect!' : S.result.stars === 2 ? 'Nicely done.' : 'Done. Practice makes it easier.'),
          el('p', {}, (S.result.quiz ? `Quiz: ${S.result.quiz.first} of ${S.result.quiz.total} on the first try. ` : '') + `Keyboard: ${S.result.score} of ${S.result.total} right on the first try.`),
          el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => start(ex, passed(ex) ? 'play' : null) }, passed(ex) ? 'Keyboard part again' : 'Again'),
            ex.text ? el('button', { class: 'btn', onclick: () => start(ex) }, 'Read and quiz again') : null,
            nl ? el('button', { class: 'btn primary', onclick: () => start(nl) }, 'Next: ' + nl.title) : null,
            el('button', { class: 'btn', onclick: stop }, 'All exercises')))];
      }
      if (S.phase === 'read') {
        const t = ex.text;
        return [head, el('div', { class: 'ex-steps' }, stepper(0)),
          el('div', { class: 'ex-read' }, ...t.read.map((p) => el('p', {}, p))),
          el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: startQuiz }, 'I\u2019ve read it: start the quiz'),
            passed(ex) ? el('button', { class: 'btn small', onclick: () => { S.phase = 'play'; S.quizScore = null; S.quiz = null; next(true); } }, 'Skip to the keyboard (quiz already passed)') : null)];
      }
      if (S.phase === 'quiz') {
        const z = S.quiz, x = z.qs[z.i];
        return [head, el('div', { class: 'ex-steps' }, stepper(1)),
          el('div', { class: 'ex-dots', 'aria-label': `Quiz question ${z.i + 1} of ${z.qs.length}` }, ...z.qs.map((_, i) => el('i', { class: i < z.i ? 'past' : i === z.i ? 'now' : '' }))),
          el('div', { class: 'ex-q' }, x.q),
          el('div', { class: 'ex-opts', role: 'group' }, ...x.options.map((o, k) => el('button', {
            class: 'btn ex-opt' + (z.tried.has(k) ? (k === x.answer ? ' right' : ' wrongopt') : ''), disabled: z.solved && k !== x.answer || (z.tried.has(k) && k !== x.answer),
            onclick: () => pickAnswer(k) }, o))),
          el('p', { class: 'ex-fb' + (z.solved ? ' ok' : z.tried.size ? ' miss' : ''), 'aria-live': 'polite' },
            z.solved ? '✓ ' + x.why : z.tried.size ? 'Not quite. Have another look at the reading, or try another answer.' : ''),
          el('div', { class: 'row' },
            el('button', { class: 'btn small', onclick: () => { S.phase = 'read'; render(); } }, '← Back to the reading'),
            z.solved ? el('button', { class: 'btn primary', onclick: nextQuiz }, z.i + 1 < z.qs.length ? 'Next question' : 'On to the keyboard') : null)];
      }
      const dots = el('div', { class: 'ex-dots', 'aria-label': `Question ${S.i + 1} of ${ex.count}` }, ...Array.from({ length: ex.count }, (_, i) => el('i', { class: i < S.i ? 'past' : i === S.i ? 'now' : '' })));
      const fb = S.answered ? (q.explain ? '✓ Right. ' + q.explain : '✓ Right!')
        : flash === 'bass' ? 'Right notes. Now put ' + nm(mod12(q.bass)) + ' at the bottom.'
        : flash === 'miss' ? (S.hint ? 'Not quite: the answer is lit on the keyboard.' : 'Not quite, try again.' + (S.qMiss === 2 ? ' One more miss and I’ll show you.' : ''))
        : q.kind === 'seq' ? (S.got.length ? `${S.got.length} of ${q.want.length} notes.` : '') : q.kind === 'chord' ? 'Hold the notes down together.' : '';
      return [head, ex.text ? el('div', { class: 'ex-steps' }, stepper(2)) : null,
        S.i === 0 || ex.alwaysLearn ? el('div', { class: 'ex-learn' }, el('strong', {}, 'Learn: '), ex.learn) : el('details', { class: 'ex-learn' }, el('summary', {}, 'Learn'), ex.learn),
        dots,
        el('div', { class: 'ex-q' }, q.prompt),
        el('div', { class: 'row' },
          q.hear ? el('button', { class: 'btn small', onclick: () => play(q.hear, 90, !q.ear) }, q.ear ? '▶ Hear it again' : '▶ Hear it') : null,
          el('button', { class: 'btn small', disabled: S.hint || S.answered, onclick: () => { S.hint = true; render(); api.renderKeys(); } }, 'Show me'),
          el('button', { class: 'btn small', onclick: () => next(false) }, 'Skip')),
        el('p', { class: 'ex-fb' + (S.answered ? ' ok' : flash === 'miss' ? ' miss' : '') , 'aria-live': 'polite' }, fb)];
    }
    function stepper(at) {
      return ['Read', 'Quiz', 'Keyboard'].map((t, i) => el('span', { class: 'ex-step' + (i === at ? ' now' : i < at ? ' past' : '') }, (i < at ? '✓ ' : (i + 1) + ' ') + t));
    }
    function render(flash) {
      const box = $('ex-body'); if (!box) return;
      box.replaceChildren(...(S.ex ? exView(flash) : listView()).filter(Boolean));
    }
    function context() {
      if (S.ex && S.phase === 'read') return `Exercises tab: reading about "${S.ex.title}". Answer questions about the reading if asked.`;
      if (S.ex && S.phase === 'quiz') return `Exercises tab: quiz on "${S.ex.title}", question: ${S.quiz.qs[S.quiz.i].q} Give hints, not the answer.`;
      if (!S.q) return null;
      return `Exercises tab: "${S.ex.title}" (${S.ex.custom ? T.scaleLabel(S.ex.scale[0], S.ex.scale[1]) : 'course level ' + S.ex.level}), question ${S.i + 1} of ${S.ex.count}: ${S.q.prompt}${S.q.ear ? ' (an ear exercise: do not give the answer away, give hints)' : ' Help with hints rather than the full answer unless asked.'}`;
    }
    return { render, onNote, onRelease, highlights, context, stop, state: S, progress, start };
  }

  root.Exercises = { COURSE, LESSONS, forScale, scaleDifficulty, EASY_SCALES, create };
})(window);
