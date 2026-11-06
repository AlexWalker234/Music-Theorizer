// Run: node tests/analysis.test.js                  (everything, ~4 min: the note model runs on the CPU in Node)
//      MT_SKIP_MODEL=1 node tests/analysis.test.js  (DSP engine, tuning and unit checks only, a few seconds)
// Renders each demo song and checks that the analysis recovers its key, tempo, sections and riff,
// with the DSP engine (exact riff) and with the note-model engine (riff note F1 >= 0.8), plus tuning detection.
const Theory = require('../js/theory.js');
globalThis.Theory = Theory;
const Analysis = require('../js/analysis.js');
const assert = require('assert');

const SKIP_MODEL = !!process.env.MT_SKIP_MODEL;

// Riff notes as (time, midi) events, using the per-occurrence step length when given.
function riffEvents(r) {
  const out = [];
  for (const o of r.occurrences) for (const n of r.notes) out.push({ t: o.start + n.step * (o.stepSec || r.stepSec), midi: n.midi });
  return out;
}
function writtenRiffEvents(song) {
  const beat = 60 / song.bpm, barSec = beat * 4, tonic = 72 + Theory.mod12(song.keyRoot);
  const barPart = song.form.flatMap((p) => song.parts[p].map(() => p));
  const out = [];
  barPart.forEach((p, bar) => {
    if (!song.riff.parts.includes(p)) return;
    for (const [st, semi] of song.riff.notes) if (Math.floor(st / 8) === bar % song.riff.bars) out.push({ t: bar * barSec + (st % 8) * beat / 2, midi: tonic + semi });
  });
  return out;
}
function f1(pred, truth, tol) {
  const used = new Set();
  let m = 0;
  for (const p of pred) {
    const i = truth.findIndex((e, k) => !used.has(k) && e.midi === p.midi && Math.abs(e.t - p.t) <= tol);
    if (i >= 0) { used.add(i); m++; }
  }
  const P = pred.length ? m / pred.length : 0, R = truth.length ? m / truth.length : 0;
  return P + R ? 2 * P * R / (P + R) : 0;
}
// Pretend the audio was recorded with A4 = a4: same samples, played at a scaled sample rate.
const detuned = (rendered, a4) => ({ samples: rendered.samples, sampleRate: rendered.sampleRate * a4 / 440 });

(async () => {
  process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
  let failed = 0;
  const fail = (msg) => { failed++; console.log('  FAIL: ' + msg); };

  // ---- 1. DSP engine (the fallback): the original checks, unchanged --------------------------
  for (const song of Analysis.DEMO_SONGS) {
    const { samples, sampleRate } = Analysis.renderDemoSong(song);
    const expectedSections = song.form.filter((p, i) => p !== song.form[i - 1]).join('');
    const t0 = Date.now();
    const r = await Analysis.analyzeSong(samples, sampleRate, { engine: 'dsp' });
    const ms = Date.now() - t0;
    const keyOk = r.key.rootPc === song.keyRoot && r.key.scaleId === song.scale;
    const bpmOk = r.tempo.bpm && Math.abs(r.tempo.bpm - song.bpm) <= 3;
    console.log(`[dsp] ${song.title}: key=${r.key.label} (${r.keyConfidence.level}) bpm=${r.tempo.bpm} conf=${r.tempo.confidence.toFixed(2)} ` +
      `chords=${r.chords.slice(0, 4).map((c) => c.name + '/' + c.roman).join(' ')} sections=${r.sections.map((s) => s.label).join('')} A4=${r.tuning.a4} ${ms}ms ` +
      `${keyOk ? 'KEY OK' : 'KEY WRONG'} ${bpmOk ? 'BPM OK' : 'BPM WRONG'}`);
    const secOk = r.sections.map((s) => s.label).join('') === expectedSections;
    if (!secOk) console.log(`  sections expected ${expectedSections}`);
    // Riff Mode: the transcribed riff should match the riff written into the demo, note for note.
    const tonic = 72 + Theory.mod12(song.keyRoot);
    const expRiff = song.riff.notes.map(([st, semi]) => st + ':' + (tonic + semi)).join(' ');
    const gotRiff = r.riff ? r.riff.notes.map((n) => n.step + ':' + n.midi).join(' ') : 'none';
    const riffOk = expRiff === gotRiff;
    console.log(`  riff: ${r.riff ? r.riff.bars + ' bars, ' + r.riff.occurrences.length + ' repeats' : 'not found'} ${riffOk ? 'RIFF OK' : 'RIFF WRONG (' + gotRiff + ')'}`);
    const tunOk = Math.abs(r.tuning.cents) < 3 && r.engine === 'dsp';
    if (!tunOk) fail(`tuning ${JSON.stringify(r.tuning)} / engine ${r.engine}`);
    if (!keyOk || !bpmOk || !secOk || !riffOk) failed++;
  }

  // ---- 2. Tuning detection (A=432, +25 cents) and the DSP engine on a detuned song -------------
  const pop = Analysis.DEMO_SONGS[0], popAudio = Analysis.renderDemoSong(pop);
  for (const a4 of [432, 440 * Math.pow(2, 25 / 1200)]) {
    const d = detuned(popAudio, a4);
    const x22 = Analysis.resample(d.samples, d.sampleRate, 22050);
    const t = await Analysis.detectTuning(x22, 22050);
    const errCents = Math.abs(1200 * Math.log2(t.a4 / a4));
    console.log(`[tuning] true A4=${a4.toFixed(1)} detected ${t.a4} Hz (${t.cents} cents, confidence ${t.confidence}) error ${errCents.toFixed(1)} cents`);
    if (errCents > 3 || t.confidence < 0.3) fail('tuning detection');
  }
  {
    const d = detuned(popAudio, 432);
    const r = await Analysis.analyzeSong(d.samples, d.sampleRate, { engine: 'dsp' });
    console.log(`[dsp, A=432] key=${r.key.label} A4=${r.tuning.a4}`);
    if (r.key.rootPc !== pop.keyRoot || r.key.scaleId !== pop.scale || Math.abs(r.tuning.a4 - 432) > 1) fail('DSP engine on the A=432 demo');
  }

  // ---- 3. Units: resampler keeps pitch; note decoding of a clean activation -------------------
  {
    const sr = 44100, x = new Float32Array(sr);
    for (let i = 0; i < sr; i++) x[i] = Math.sin(2 * Math.PI * 1000 * i / sr);
    const y = Analysis.resample(x, sr, 22050);
    let zc = 0;
    for (let i = 1; i < y.length; i++) if (y[i - 1] < 0 && y[i] >= 0) zc++;
    if (y.length !== 22050 || Math.abs(zc - 1000) > 2) fail(`resample: length ${y.length}, ${zc} cycles`);
    const nF = 200, P = 88, fr = new Float32Array(nF * P), on = new Float32Array(nF * P);
    for (let t = 50; t < 120; t++) fr[t * P + 60 - 21] = 0.8;   // C4 held from frame 50 to 120
    on[50 * P + 60 - 21] = 0.9;
    const notes = Analysis.decodeNotes(fr, on, nF);
    if (notes.length !== 1 || notes[0].p + 21 !== 60 || Math.abs(notes[0].f0 - 50) > 1 || Math.abs(notes[0].f1 - 120) > 2) fail('decodeNotes ' + JSON.stringify(notes));
  }

  // ---- 4. Note-model engine (Basic Pitch) -------------------------------------------------------
  if (SKIP_MODEL) console.log('[model] skipped (MT_SKIP_MODEL=1)');
  else {
    const cases = Analysis.DEMO_SONGS.map((song) => ({ song, audio: Analysis.renderDemoSong(song), a4: 440 }));
    cases.push({ song: pop, audio: detuned(popAudio, 432), a4: 432 });
    for (const { song, audio, a4 } of cases) {
      const t0 = Date.now();
      const r = await Analysis.analyzeSong(audio.samples, audio.sampleRate, { modelBudgetSec: Infinity });
      const ms = Date.now() - t0;
      const expectedSections = song.form.filter((p, i) => p !== song.form[i - 1]).join('');
      const keyOk = r.key.rootPc === song.keyRoot && r.key.scaleId === song.scale;
      const bpmOk = r.tempo.bpm && Math.abs(r.tempo.bpm - song.bpm) <= 3;
      const secOk = r.sections.map((s) => s.label).join('') === expectedSections;
      // Riff timing in the detuned copy is stretched by 440/a4 (the samples were played back slower).
      const stretch = 440 / a4;
      const truth = writtenRiffEvents(song).map((e) => ({ t: e.t * stretch, midi: e.midi }));
      const riffF1 = r.riff ? f1(riffEvents(r.riff), truth, 0.45 * 30 / song.bpm * stretch) : 0;
      const tunOk = Math.abs(r.tuning.a4 - a4) <= 1;
      const shapeOk = r.engine === 'basic-pitch + dsp' && Array.isArray(r.notes) && r.notes.length > 50 && r.notes.length <= 6000 &&
        r.notes.every((n) => n.end > n.start && n.midi >= 21 && n.midi <= 108) && Array.isArray(r.beats) && r.melody.length > 0 &&
        r.chords.every((c) => c.name && c.pcs && 'roman' in c) && ['high', 'medium', 'low'].includes(r.keyConfidence.level);
      console.log(`[model] ${song.title}${a4 !== 440 ? ' at A=' + a4 : ''}: key=${r.key.label} bpm=${r.tempo.bpm} sections=${r.sections.map((s) => s.label).join('')} ` +
        `A4=${r.tuning.a4} riff ${r.riff ? r.riff.bars + ' bars x' + r.riff.occurrences.length : 'none'} F1=${riffF1.toFixed(2)} notes=${r.notes.length} ${(ms / 1000).toFixed(1)}s ` +
        `[${r.engine}, ${r.engineInfo.backend}]`);
      if (!keyOk) fail('model key');
      if (!bpmOk) fail('model tempo');
      if (!secOk) fail('model sections, expected ' + expectedSections);
      if (riffF1 < 0.8) fail('model riff F1 ' + riffF1.toFixed(2));
      if (!tunOk) fail('model tuning ' + r.tuning.a4);
      if (!shapeOk) fail('model result shape');
    }
  }

  // Scale identifier: C D E F G A B -> C major (or A minor, its relative) on top.
  const w = new Array(12).fill(0); [0, 2, 4, 5, 7, 9, 11].forEach((pc) => (w[pc] = 1)); w[0] = 3;
  const top = Theory.identifyScales(w)[0];
  assert.strictEqual(top.label, 'C Major (Ionian)');
  // A minor pentatonic notes with A emphasised.
  const w2 = new Array(12).fill(0); [9, 0, 2, 4, 7].forEach((pc) => (w2[pc] = 1)); w2[9] = 4;
  console.log('Pentatonic guess:', Theory.identifyScales(w2).slice(0, 3).map((r) => r.label).join(', '));
  // Errors (both engines check these before any heavy work).
  await assert.rejects(Analysis.analyzeSong(new Float32Array(22050), 22050), (e) => e.code === 'too_short');
  await assert.rejects(Analysis.analyzeSong(new Float32Array(22050 * 10), 22050), (e) => e.code === 'silent');
  await assert.rejects(Analysis.analyzeSong(new Float32Array(22050 * 10), 22050, { engine: 'dsp' }), (e) => e.code === 'silent');
  // Cancelling stops the analysis with code 'cancelled'.
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(Analysis.analyzeSong(popAudio.samples, popAudio.sampleRate, { signal: ctl.signal }), (e) => e.code === 'cancelled');
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
  process.exit(failed ? 1 : 0);
})();
