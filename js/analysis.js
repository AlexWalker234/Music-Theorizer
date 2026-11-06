/* Song analysis ("Jam Mode" engine): tuning, key, tempo/beats, chords, sections and the riff from raw audio.
 *
 * Two engines share one result shape:
 *  - "basic-pitch + dsp" (default): Spotify's Basic Pitch polyphonic note-transcription model
 *    (Apache-2.0, run with TensorFlow.js from js/vendor/tfjs.min.js + js/ml/basic-pitch-model.js)
 *    turns the song into notes; key, chords and the riff are derived from those notes together with
 *    tuning-corrected chroma, a dynamic-programming beat tracker and an HMM (Viterbi) chord decoder.
 *    In the browser it runs in a Web Worker (js/analysis-worker.js) so the page stays responsive.
 *  - "dsp (fallback)": the original signal-processing engine (chroma + Krumhansl key profiles,
 *    spectral-flux tempo, triad matching, monophonic riff transcription). Used whenever the model
 *    cannot load (no worker on file://, no WebGL on the main thread, scripts missing, errors).
 * Both detect the tuning reference (A4 in Hz) first and analyse relative to it.
 *
 * No DOM needed. Works in the browser (window.Analysis), in a worker (self.Analysis) and Node (module.exports). */
(function (root) {
  'use strict';
  const Theory = root.Theory || (typeof require !== 'undefined' ? require('./theory.js') : null);
  const mod12 = Theory.mod12;

  class AnalysisError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  // ---- FFT (in-place radix-2) -----------------------------------------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  // Box-filter downsample by an integer factor (enough for chroma up to ~2 kHz).
  function downsample(samples, sr, targetSr) {
    const factor = Math.max(1, Math.floor(sr / targetSr));
    if (factor === 1) return { data: samples, sr };
    const out = new Float32Array(Math.floor(samples.length / factor));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let k = 0; k < factor; k++) s += samples[i * factor + k];
      out[i] = s / factor;
    }
    return { data: out, sr: sr / factor };
  }

  const SECTION_SIMILARITY = 0.9;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /* Short-time spectra -> chroma per frame + spectral flux (onset strength). */
  async function spectralFrames(x, sr, opts, onProgress, signal) {
    const N = opts.frameSize, hop = opts.hop, win = hann(N);
    const nFrames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
    const re = new Float32Array(N), im = new Float32Array(N);
    const a4 = opts.a4 || 440;
    const binPc = new Int8Array(N / 2).fill(-1), bassBin = new Uint8Array(N / 2);
    for (let k = 1; k < N / 2; k++) {
      const f = k * sr / N;
      if (f >= 55 && f <= 2100) binPc[k] = mod12(Math.round(12 * Math.log2(f / a4)) + 9);
      if (f >= 38 && f <= 260) bassBin[k] = 1;
    }
    const chroma = [], bass = opts.bass ? [] : null, flux = new Float32Array(nFrames), energy = new Float32Array(nFrames);
    let prev = new Float32Array(N / 2);
    for (let f = 0; f < nFrames; f++) {
      if (signal && signal.aborted) throw new AnalysisError('cancelled', 'Analysis cancelled.');
      const off = f * hop;
      let e = 0;
      for (let i = 0; i < N; i++) { const v = x[off + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
      energy[f] = Math.sqrt(e / N);
      fft(re, im);
      const c = new Float32Array(12), mag = new Float32Array(N / 2), cb = bass ? new Float32Array(12) : null;
      let fl = 0;
      for (let k = 1; k < N / 2; k++) {
        const m = Math.log1p(100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        mag[k] = m;
        const d = m - prev[k];
        if (d > 0) fl += d;
        if (binPc[k] >= 0) c[binPc[k]] += m;
        if (cb && bassBin[k] && binPc[k] >= 0) cb[binPc[k]] += m;
      }
      prev = mag;
      flux[f] = fl;
      chroma.push(c);
      if (bass) bass.push(cb);
      if (f % 64 === 0) { onProgress && onProgress(f / nFrames); await tick(); }
    }
    return { chroma, bass, flux, energy, frameSec: hop / sr };
  }

  /* Tempo from autocorrelation of the onset envelope, with a mild preference for 80–160 BPM
   * to avoid half/double-time errors. Confidence is how much the winning lag stands out. */
  function estimateTempo(flux, frameSec) {
    const n = flux.length;
    if (n < 64) return { bpm: null, confidence: 0 };
    // Remove slow trend, keep positive onsets.
    const env = new Float32Array(n);
    const w = 16;
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { s += flux[k]; c++; }
      env[i] = Math.max(0, flux[i] - s / c);
    }
    const minLag = Math.floor(60 / 200 / frameSec), maxLag = Math.ceil(60 / 55 / frameSec);
    let best = -1, bestLag = 0, sum = 0, count = 0;
    const scores = [];
    for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
      s /= (n - lag);
      const bpm = 60 / (lag * frameSec);
      const weight = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2));
      const ws = s * weight;
      scores.push({ lag, ws });
      sum += ws; count++;
      if (ws > best) { best = ws; bestLag = lag; }
    }
    if (!bestLag || best <= 0) return { bpm: null, confidence: 0 };
    // Parabolic refinement of the peak lag.
    const i = scores.findIndex((s) => s.lag === bestLag);
    let lag = bestLag;
    if (i > 0 && i < scores.length - 1) {
      const a = scores[i - 1].ws, b = scores[i].ws, c = scores[i + 1].ws;
      const d = (a - 2 * b + c);
      if (d !== 0) lag += 0.5 * (a - c) / d;
    }
    const mean = sum / count;
    return { bpm: Math.round(600 / (lag * frameSec)) / 10, confidence: Math.min(1, (best / mean - 1) / 3) };
  }

  function normalize(v) {
    const m = Math.max(...v);
    return m > 0 ? Array.from(v, (x) => x / m) : Array.from(v);
  }

  // Template-match a chroma vector against 24 major/minor triads (optionally boosting diatonic ones).
  function bestChord(chroma, keyPcs) {
    let best = null;
    for (let r = 0; r < 12; r++) {
      for (const q of ['maj', 'min']) {
        const pcs = Theory.chordPitchClasses(r, q);
        const tmpl = new Array(12).fill(0);
        pcs.forEach((pc, i) => { tmpl[pc] = i === 0 ? 1.2 : 1; });
        let s = Theory.pearson(chroma, tmpl);
        if (keyPcs && pcs.every((pc) => keyPcs.includes(pc))) s += 0.08;
        if (!best || s > best.score) best = { rootPc: r, quality: q, score: s };
      }
    }
    return best;
  }


  // ---- Riff Mode: melody transcription + repeating-riff detection ---------------
  const MELODY_LO = 64, MELODY_HI = 96;   // E4..C7: where lead lines and riffs usually sit
  const HARM_W = [1, 0.6, 0.4, 0.3];
  const RIFF_MATCH = 0.6;   // share of notes two bars must have in common to count as the same riff

  /* Note-level transcription of the lead line. A finer STFT finds note onsets in the
   * upper spectrum; at each onset the spectrum *change* (after minus before) isolates the
   * new note from sustained chords, and harmonic summation picks its pitch. */
  async function transcribeMelody(x, sr, signal, tune) {
    tune = tune || 1;   // detected tuning: A4 / 440
    const N = 1024, hop = 256, win = hann(N), frameSec = hop / sr;
    const kMax = Math.min(N / 2 - 2, Math.ceil(3200 * N / sr));
    const kHi = Math.floor(300 * N / sr);
    const nFrames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
    const re = new Float32Array(N), im = new Float32Array(N);
    const mags = [], lins = [], hf = new Float32Array(nFrames);
    let prev = null;
    for (let f = 0; f < nFrames; f++) {
      if (signal && signal.aborted) throw new AnalysisError('cancelled', 'Analysis cancelled.');
      const off = f * hop;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      const mag = new Float32Array(kMax + 2), lin = new Float32Array(kMax + 2);
      for (let k = 1; k <= kMax + 1; k++) { lin[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]); mag[k] = Math.log1p(100 * lin[k]); }
      if (prev) { let fl = 0; for (let k = kHi; k <= kMax; k++) { const d = mag[k] - prev[k]; if (d > 0) fl += d; } hf[f] = fl; }
      prev = mag; mags.push(mag); lins.push(lin);
      if (f % 256 === 0) await tick();
    }
    // Onsets: local peaks of the high-band flux above an adaptive threshold.
    let gmax = 0; for (let f = 0; f < nFrames; f++) gmax = Math.max(gmax, hf[f]);
    const onsets = [];
    for (let f = 1; f < nFrames - 3; f++) {
      let isPeak = true;
      for (let d = -2; d <= 2; d++) if (d && f + d >= 0 && hf[f + d] > hf[f]) { isPeak = false; break; }
      if (!isPeak) continue;
      let m = 0, c = 0;
      for (let k = Math.max(0, f - 20); k < Math.min(nFrames, f + 20); k++) { m += hf[k]; c++; }
      m /= c;
      if (hf[f] > m * 1.4 && hf[f] > gmax * 0.08 && (!onsets.length || f - onsets[onsets.length - 1] >= 3)) onsets.push(f);
    }
    const notes = [];
    const diff = new Float32Array(kMax + 2);
    const bin = (freq) => Math.round(freq * N / sr);
    for (let i = 0; i < onsets.length; i++) {
      const f = onsets[i];
      // Linear magnitudes here: log compression would make every harmonic look equally strong.
      const a = lins[Math.min(nFrames - 1, f + 2)], b = lins[Math.max(0, f - 1)];
      for (let k = 1; k <= kMax; k++) diff[k] = Math.max(0, a[k] - b[k]);
      const peakAt = (k) => (k >= 1 && k <= kMax ? Math.max(diff[k - 1] || 0, diff[k], diff[k + 1] || 0) : 0);
      const sal = [];
      let best = -1, bestM = 0, sum = 0;
      for (let m = MELODY_LO; m <= MELODY_HI; m++) {
        const f0 = Theory.midiToFreq(m) * tune;
        let v = 0;
        for (let h = 0; h < HARM_W.length; h++) v += HARM_W[h] * peakAt(bin(f0 * (h + 1)));
        // Energy an octave below means this is probably that note's 2nd harmonic.
        if (f0 / 2 > 150) v -= 0.8 * peakAt(bin(f0 / 2));
        sal.push(v); sum += v;
        if (v > best) { best = v; bestM = m; }
      }
      const mean = sum / sal.length;
      if (best <= 0 || best / (Math.abs(mean) || 1e-9) < 2.5) continue;   // noise burst or drum hit, not a pitched note
      // A real new note makes its fundamental jump; a hi-hat on top of a held chord does not.
      const k0 = bin(Theory.midiToFreq(bestM) * tune);
      const before = Math.max(b[k0 - 1], b[k0], b[k0 + 1]), after = Math.max(a[k0 - 1], a[k0], a[k0 + 1]);
      if (after < 1.6 * before) continue;
      const start = (f * hop + N / 2) / sr;   // a frame's time is its centre
      const nextT = i + 1 < onsets.length ? onsets[i + 1] * frameSec : start + 0.6;
      notes.push({ start, dur: Math.min(0.6, nextT - start), midi: bestM, strength: best });
    }
    // Drop faint detections (a chord change leaking into the lead range).
    const strengths = notes.map((n) => n.strength).sort((a, b) => a - b);
    const med = strengths[Math.floor(strengths.length / 2)] || 0;
    return notes.filter((n) => n.strength >= med * 0.2);
  }

  /* Finds the riff: the 1-, 2- or 4-bar note pattern (on an eighth-note grid) that repeats most.
   * Notes are compared as (position in pattern, pitch); occurrences need 60% overlap. The
   * shown riff is the consensus of all occurrences, so one mis-heard note doesn't stick. */
  function findRiff(notes, bpm, duration, keyPcs) {
    if (!bpm || notes.length < 6) return null;
    // The tempo estimate is only good to about 1%, which drifts a whole eighth note within a minute,
    // so search step length (±3%) and grid offset together for the best fit to the note starts.
    const step0 = 30 / bpm;
    let step = step0, phase = 0, bestFit = -1;
    for (let si = -60; si <= 60; si++) {
      const st = step0 * (1 + si * 0.0005);
      for (let i = -8; i < 8; i++) {
        const ph = (i / 16) * st;
        let fit = 0;
        for (const n of notes) {
          const r = (n.start - ph) / st, d = Math.abs(r - Math.round(r));
          if (d < 0.2) fit += 1 - d * 5;
        }
        if (fit > bestFit) { bestFit = fit; step = st; phase = ph; }
      }
    }
    const beat = step * 2, barSec = beat * 4;
    while (phase > step / 2) phase -= step;
    while (phase < -step / 2) phase += step;
    const nBars = Math.ceil((duration - phase) / barSec);
    const bars = Array.from({ length: nBars }, () => []);
    for (const n of notes) {
      const pos = Math.round((n.start - phase) / step);   // eighth-note index from the start
      if (pos < 0) continue;
      const bar = Math.floor(pos / 8);
      if (bar < nBars) bars[bar].push({ step: pos % 8, midi: n.midi, dur: Math.max(1, Math.round(n.dur / step)) });
    }
    const keyOf = (L, s) => {
      const set = new Set();
      for (let b = 0; b < L; b++) for (const n of bars[s + b] || []) set.add((b * 8 + n.step) + ':' + n.midi);
      return set;
    };
    const sim = (A, B) => { if (!A.size || !B.size) return 0; let c = 0; for (const x of A) if (B.has(x)) c++; return c / Math.max(A.size, B.size); };
    let best = null;
    for (const L of [1, 2, 4]) {
      for (let s = 0; s + L <= nBars; s++) {
        const P = keyOf(L, s);
        if (P.size < 3) continue;
        const occ = [];
        for (let t = 0; t + L <= nBars;) {
          const v = sim(P, keyOf(L, t));
          if (v >= RIFF_MATCH) { occ.push({ bar: t, sim: v }); t += L; } else t++;
        }
        if (occ.length < 2) continue;
        const score = occ.length * P.size - L * 0.01;
        if (!best || score > best.score) best = { L, s, occ, score };
      }
    }
    if (!best) return null;
    // Consensus pattern over all occurrences.
    const votes = new Map();
    for (const o of best.occ) for (let b = 0; b < best.L; b++) for (const n of bars[o.bar + b] || []) {
      const st = b * 8 + n.step;
      if (!votes.has(st)) votes.set(st, new Map());
      const vm = votes.get(st);
      const e = vm.get(n.midi) || { count: 0, dur: [] };
      e.count++; e.dur.push(n.dur); vm.set(n.midi, e);
    }
    const riffNotes = [];
    for (const [st, vm] of votes) {
      let top = null;
      for (const [midi, e] of vm) if (!top || e.count > top.count) top = { midi, count: e.count, dur: e.dur };
      if (top.count >= Math.ceil(best.occ.length / 2)) {
        const d = top.dur.sort((a, b) => a - b)[Math.floor(top.dur.length / 2)];
        riffNotes.push({ step: st, midi: top.midi, dur: d, agree: top.count / best.occ.length, inKey: !keyPcs || keyPcs.includes(mod12(top.midi)) });
      }
    }
    riffNotes.sort((a, b) => a.step - b.step);
    // A note can't ring past the next one.
    riffNotes.forEach((n, i) => { const nx = riffNotes[i + 1]; const lim = (nx ? nx.step : best.L * 8) - n.step; n.dur = Math.max(1, Math.min(n.dur, lim)); });
    if (riffNotes.length < 3) return null;
    const confidence = best.occ.reduce((a, o) => a + o.sim, 0) / best.occ.length;
    return {
      bars: best.L, stepSec: step, barSec, phase,
      notes: riffNotes,
      occurrences: best.occ.map((o) => ({ start: phase + o.bar * barSec, end: phase + (o.bar + best.L) * barSec, match: o.sim })),
      confidence,
      offKey: riffNotes.filter((n) => !n.inKey).length,
      unsure: riffNotes.filter((n) => n.agree < 0.75).length,
    };
  }

  /* The original DSP engine (also the fallback when the model can't run). samples: mono Float32Array.
   * opts.a4 / opts.tuning: detected tuning (chroma and melody pitches are measured relative to it). */
  async function analyzeDsp(samples, sampleRate, opts) {
    opts = opts || {};
    const onStage = opts.onStage || (() => {});
    const signal = opts.signal;
    const duration = samples.length / sampleRate;
    if (!samples.length || duration < 4) throw new AnalysisError('too_short', 'This clip is shorter than 4 seconds, which is not enough to hear a key.');

    onStage('prepare', 0);
    const { data: x, sr } = downsample(samples, sampleRate, 11025);
    let rms = 0;
    for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
    rms = Math.sqrt(rms / x.length);
    if (rms < 0.003) throw new AnalysisError('silent', 'The audio is silent or almost silent.');
    await tick();

    onStage('listen', 0);
    const a4 = opts.a4 || 440;
    const frames = await spectralFrames(x, sr, { frameSize: 2048, hop: 512, a4 }, (p) => onStage('listen', p), signal);

    onStage('key', 0);
    await tick();
    const total = new Array(12).fill(0);
    frames.chroma.forEach((c, i) => { const w = frames.energy[i]; for (let k = 0; k < 12; k++) total[k] += c[k] * w; });
    const profileCands = Theory.detectKey(normalize(total));

    onStage('tempo', 0);
    await tick();
    const tempo = estimateTempo(frames.flux, frames.frameSec);

    onStage('chords', 0);
    await tick();
    // One chord per bar when the tempo is believable, otherwise every 2 seconds.
    const segSec = tempo.bpm && tempo.confidence > 0.15 ? (60 / tempo.bpm) * 4 : 2;
    const perSeg = Math.max(1, Math.round(segSec / frames.frameSec));
    const segs = [];
    for (let f = 0; f < frames.chroma.length; f += perSeg) {
      const c = new Array(12).fill(0);
      let e = 0;
      for (let k = f; k < Math.min(frames.chroma.length, f + perSeg); k++) {
        for (let p = 0; p < 12; p++) c[p] += frames.chroma[k][p];
        e += frames.energy[k];
      }
      const start = f * frames.frameSec, end = Math.min(duration, (f + perSeg) * frames.frameSec);
      if (e / perSeg < rms * 0.15) { segs.push({ start, end, chroma: c, silent: true }); continue; }
      const ch = bestChord(c, null);
      segs.push({ start, end, chroma: c, rootPc: ch.rootPc, quality: ch.quality });
    }
    const voiced = segs.filter((s) => !s.silent);

    /* Key profiles alone often confuse relative major/minor (same notes). Re-rank the
     * closest candidates with harmonic evidence: how much of the song's chords fit the key,
     * how long the tonic chord sounds, and whether the song starts or ends on it. */
    const voicedDur = voiced.reduce((a, s) => a + (s.end - s.start), 0) || 1;
    const cands = profileCands.slice(0, 8).map((k) => {
      const pcs = Theory.scalePitchClasses(k.rootPc, k.scaleId);
      const tq = k.scaleId === 'major' ? 'maj' : 'min';
      let dia = 0, tonic = 0;
      for (const s of voiced) {
        const cp = Theory.chordPitchClasses(s.rootPc, s.quality);
        if (cp.every((pc) => pcs.includes(pc))) dia += s.end - s.start;
        if (s.rootPc === k.rootPc && s.quality === tq) tonic += s.end - s.start;
      }
      const isTonic = (s) => s && s.rootPc === k.rootPc && s.quality === tq;
      const score = k.corr + 0.3 * (dia / voicedDur) + 0.25 * (tonic / voicedDur) +
        (isTonic(voiced[0]) ? 0.06 : 0) + (isTonic(voiced[voiced.length - 1]) ? 0.04 : 0);
      return Object.assign({}, k, { score });
    }).sort((a, b) => b.score - a.score);
    const conf = Theory.keyConfidence(cands.map((c) => ({ rootPc: c.rootPc, scaleId: c.scaleId, corr: c.corr + (c.score - c.corr) * 0.5 })));
    const key = cands[0];

    const chords = [];
    for (const s of voiced) {
      const last = chords[chords.length - 1];
      if (last && last.rootPc === s.rootPc && last.quality === s.quality && Math.abs(last.end - s.start) < 0.01) { last.end = s.end; continue; }
      chords.push({ start: s.start, end: s.end, rootPc: s.rootPc, quality: s.quality,
        name: Theory.chordName(s.rootPc, s.quality, key.rootPc), pcs: Theory.chordPitchClasses(s.rootPc, s.quality) });
    }
    // Roman numerals relative to the detected key.
    const dia = Theory.diatonicChords(key.rootPc, key.scaleId);
    chords.forEach((c) => {
      const d = dia.find((x) => x.rootPc === c.rootPc && x.quality === c.quality);
      c.roman = d ? d.roman : null;
    });

    onStage('sections', 0);
    await tick();
    // Sections: group 4-bar blocks by chroma similarity and label them A, B, C...
    const blockSegs = 4, blocks = [];
    for (let i = 0; i < segs.length; i += blockSegs) {
      const c = new Array(12).fill(0);
      for (let k = i; k < Math.min(segs.length, i + blockSegs); k++) for (let p = 0; p < 12; p++) c[p] += segs[k].chroma[p];
      blocks.push({ start: segs[i].start, end: segs[Math.min(segs.length, i + blockSegs) - 1].end, chroma: c });
    }
    const protos = [];
    const sections = [];
    // A short trailing block (e.g. the fade-out) belongs to the section before it.
    if (blocks.length > 1 && blocks[blocks.length - 1].end - blocks[blocks.length - 1].start < (blocks[0].end - blocks[0].start) / 2) {
      blocks[blocks.length - 2].end = blocks.pop().end;
    }
    for (const b of blocks) {
      let label = null;
      for (const p of protos) if (Theory.pearson(p.chroma, b.chroma) > SECTION_SIMILARITY) { label = p.label; break; }
      if (!label) { label = String.fromCharCode(65 + Math.min(protos.length, 25)); protos.push({ label, chroma: b.chroma }); }
      const last = sections[sections.length - 1];
      if (last && last.label === label) last.end = b.end; else sections.push({ start: b.start, end: b.end, label });
    }

    onStage('riff', 0);
    await tick();
    const melody = await transcribeMelody(x, sr, signal, a4 / 440);
    const riff = findRiff(melody, tempo.confidence > 0.15 ? tempo.bpm : null, duration, Theory.scalePitchClasses(key.rootPc, key.scaleId));

    onStage('done', 1);
    return {
      duration,
      key: { rootPc: key.rootPc, scaleId: key.scaleId, label: key.label },
      keyCandidates: cands.slice(0, 3).map((c) => ({ rootPc: c.rootPc, scaleId: c.scaleId, label: c.label, corr: c.corr })),
      keyConfidence: conf,
      tempo,
      chords,
      sections,
      melody,
      riff,
      tuning: opts.tuning || { a4: 440, cents: 0, confidence: 0 },
      notes: melody.slice(0, MAX_NOTES).map((n) => ({ start: r3(n.start), end: r3(n.start + n.dur), midi: n.midi, velocity: 0.5 })),
      engine: opts.engineName || 'dsp (fallback)',
    };
  }

  // =====================================================================================
  // Model-based engine: Basic Pitch note transcription + beat tracking + HMM chords + riff
  // =====================================================================================
  const MAX_NOTES = 6000;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const ENV = (() => {
    const worker = typeof importScripts === 'function' && typeof window === 'undefined';
    const node = !worker && typeof window === 'undefined' && typeof process !== 'undefined' && !!(process.versions && process.versions.node);
    let base = '';
    try {
      if (worker) base = String(self.location.href).replace(/[^/]*([?#].*)?$/, '');
      else if (node) base = __dirname + '/';
      else if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) base = document.currentScript.src.replace(/[^/]*([?#].*)?$/, '');
      else base = 'js/';
    } catch (e) { base = 'js/'; }
    return { worker, node, page: !worker && !node, base };
  })();
  const cancelled = () => new AnalysisError('cancelled', 'Analysis cancelled.');
  const checkAbort = (signal) => { if (signal && signal.aborted) throw cancelled(); };

  // ---- Resampling (windowed sinc; also used to undo detuning before the model) -------------
  function resample(x, srIn, srOut) {
    if (Math.abs(srIn - srOut) < 1e-6) return x;
    const ratio = srOut / srIn, step = srIn / srOut;
    const fc = Math.min(1, ratio) * 0.92, zc = 6, hw = Math.ceil(zc / fc), RES = 128;
    const table = new Float32Array(hw * RES + 2);
    for (let i = 0; i < table.length; i++) {
      const t = i / RES, a = Math.PI * fc * t;
      const w = t >= hw ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * t / hw) + 0.08 * Math.cos(2 * Math.PI * t / hw);
      table[i] = fc * (t === 0 ? 1 : Math.sin(a) / a) * w;
    }
    const nOut = Math.floor(x.length * ratio), y = new Float32Array(nOut), last = x.length - 1;
    for (let n = 0; n < nOut; n++) {
      const c = n * step, ci = Math.floor(c);
      const lo = Math.max(0, ci - hw + 1), hi = Math.min(last, ci + hw);
      let acc = 0;
      for (let i = lo; i <= hi; i++) { const d = i - c; acc += x[i] * table[((d < 0 ? -d : d) * RES + 0.5) | 0]; }
      y[n] = acc;
    }
    return y;
  }

  // ---- Tuning: where the song's notes sit relative to the A=440 equal-tempered grid ---------
  /* Stable spectral peaks (present in two overlapping frames, sharp, not a 5th/7th/... harmonic of
   * a lower peak, which equal temperament puts off-grid) vote with their cents offset; the
   * weighted circular mean of those offsets is the tuning, its resultant length the confidence.
   * Drum noise gives scattered offsets that cancel out; vibrato averages out. */
  async function detectTuning(x, sr, signal) {
    const N = 8192, hop = N / 2, win = hann(N);
    const nFr = Math.floor((x.length - N) / hop) + 1;
    if (nFr < 2) return { a4: 440, cents: 0, confidence: 0 };
    const stride = Math.max(2, 2 * Math.ceil(nFr / 2 / 300));
    const kLo = Math.ceil(70 * N / sr), kHi = Math.min(N / 2 - 8, Math.floor(1700 * N / sr));
    const re = new Float32Array(N), im = new Float32Array(N), db = new Float32Array(N / 2);
    const peaksOf = (off) => {
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let mx = -999;
      for (let k = 1; k < N / 2; k++) { db[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12); if (k >= kLo && k <= kHi && db[k] > mx) mx = db[k]; }
      const out = [];
      if (mx < -60) return out;
      for (let k = kLo; k <= kHi; k++) {
        const v = db[k];
        if (!(v > db[k - 1] && v >= db[k + 1] && v > db[k - 2] && v >= db[k + 2]) || v < mx - 42) continue;
        let l = v, r = v;
        for (let j = 1; j <= 6; j++) { l = Math.min(l, db[k - j]); r = Math.min(r, db[k + j]); }
        const prom = v - Math.max(l, r);
        if (prom < 12) continue;
        const a = db[k - 1], c = db[k + 1], den = a - 2 * v + c;
        const d = den !== 0 ? 0.5 * (a - c) / den : 0;
        out.push({ f: (k + d) * sr / N, w: Math.min(prom, 40) / 40 * (v - (mx - 42)) / 42 });
      }
      return out;
    };
    let S = 0, C = 0, Wt = 0, n = 0;
    for (let fr = 0; fr + 1 < nFr; fr += stride) {
      checkAbort(signal);
      const A = peaksOf(fr * hop), B = peaksOf((fr + 1) * hop);
      for (const p of A) {
        // Stable: the next frame has a peak within 8 cents.
        let q = null;
        for (const b of B) if (Math.abs(1200 * Math.log2(b.f / p.f)) < 8) { q = b; break; }
        if (!q) continue;
        // Skip partials that equal temperament can't place on the grid (5th, 7th, 9th... harmonics).
        let harm = false;
        for (const o of A) {
          if (o.f >= p.f / 2.5) break;
          const h = p.f / o.f, hr = Math.round(h);
          if (hr >= 5 && [6, 8, 12, 16].indexOf(hr) < 0 && Math.abs(h - hr) / hr < 0.004) { harm = true; break; }
        }
        if (harm) continue;
        const f = Math.sqrt(p.f * q.f);
        const cents = 1200 * Math.log2(f / 440), dev = cents - 100 * Math.round(cents / 100);
        const w = Math.min(p.w, q.w) * (f < 700 ? 1 : 0.6);
        const th = 2 * Math.PI * dev / 100;
        S += w * Math.sin(th); C += w * Math.cos(th); Wt += w; n++;
      }
      if (fr % 40 === 0) await tick();
    }
    if (!Wt) return { a4: 440, cents: 0, confidence: 0 };
    const cents = Math.atan2(S, C) * 100 / (2 * Math.PI);
    const R = Math.sqrt(S * S + C * C) / Wt;
    const confidence = Math.max(0, Math.min(1, R * Math.min(1, n / 60)));
    return { a4: Math.round(4400 * Math.pow(2, cents / 1200)) / 10, cents: Math.round(cents * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
  }

  // ---- Loading the model (worker: importScripts, page: <script> tags, Node: fs) ---------------
  const BP = { SR: 22050, HOP: 256, WIN: 43844, FRAMES: 172, PAD_FR: 15, KEEP: 142, MIDI0: 21, P: 88 };
  BP.HOP_WIN = BP.KEEP * BP.HOP;          // 36352 samples between windows: kept frames tile exactly
  BP.PAD = BP.PAD_FR * BP.HOP;            // 3840 samples of context before the first kept frame
  BP.TIME_OFFSET = 0;                     // seconds; calibrated against synthetic notes (see tests)
  const vendorFiles = () => [ENV.base + 'vendor/tfjs.min.js', ENV.base + 'ml/basic-pitch-model.js'];
  function loadScriptTag(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = () => resolve(); s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  async function ensureVendor() {
    if (root.MTtf && root.BasicPitchModel) return;
    if (ENV.worker) { importScripts(...vendorFiles()); return; }
    if (ENV.node) {
      const fs = require('fs');
      // The bundle is a browser build: hide Node's globals so it doesn't try Node-only paths.
      // eslint-disable-next-line no-new-func
      if (!root.MTtf) new Function('process', 'require', 'module', 'exports', fs.readFileSync(vendorFiles()[0], 'utf8'))(undefined, undefined, undefined, undefined);
      if (!root.BasicPitchModel) require(vendorFiles()[1]);
      return;
    }
    for (const f of vendorFiles()) if (!(f.indexOf('tfjs') >= 0 ? root.MTtf : root.BasicPitchModel)) await loadScriptTag(f);
  }
  function b64ToBuffer(b64) {
    if (ENV.node) { const b = Buffer.from(b64, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    const bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  /* CPU fused convolution (NHWC, ReLU/linear, bias) that walks the filter contiguously and skips
   * zero inputs after ReLU: same results as TF.js's kernel (same summation order), ~12% faster on
   * this model. Anything it doesn't handle goes to the original kernel. */
  function installFastConv(tf) {
    if (installFastConv.done) return;
    const orig = tf.getKernel('FusedConv2D', 'cpu');
    if (!orig) return;
    installFastConv.done = true;
    const fast = (args) => {
      const { inputs, backend, attrs } = args;
      const { x, filter, bias, preluActivationWeights } = inputs;
      const act = attrs.activation || 'linear';
      const st = Array.isArray(attrs.strides) ? attrs.strides : [attrs.strides, attrs.strides];
      const dl = Array.isArray(attrs.dilations) ? attrs.dilations : [attrs.dilations || 1, attrs.dilations || 1];
      if (preluActivationWeights || (act !== 'linear' && act !== 'relu') || attrs.dataFormat !== 'NHWC' || dl[0] !== 1 || dl[1] !== 1 ||
          (attrs.pad !== 'same' && attrs.pad !== 'valid') || x.shape.length !== 4 || x.dtype !== 'float32') return orig.kernelFunc(args);
      const [N, H, Wd, Ci] = x.shape, [KH, KW, , Co] = filter.shape, [sh, sw] = st;
      const same = attrs.pad === 'same';
      const OH = same ? Math.ceil(H / sh) : Math.ceil((H - KH + 1) / sh), OW = same ? Math.ceil(Wd / sw) : Math.ceil((Wd - KW + 1) / sw);
      const pt = same ? Math.floor(Math.max(0, (OH - 1) * sh + KH - H) / 2) : 0, pl = same ? Math.floor(Math.max(0, (OW - 1) * sw + KW - Wd) / 2) : 0;
      const xv = backend.data.get(x.dataId).values, fv = backend.data.get(filter.dataId).values;
      const bv = bias ? backend.data.get(bias.dataId).values : null;
      const out = new Float32Array(N * OH * OW * Co);
      for (let n = 0; n < N; n++) {
        const xb = n * H * Wd * Ci, ob = n * OH * OW * Co;
        for (let oy = 0; oy < OH; oy++) {
          for (let ky = 0; ky < KH; ky++) {
            const iy = oy * sh + ky - pt;
            if (iy < 0 || iy >= H) continue;
            for (let ox = 0; ox < OW; ox++) {
              const o0 = ob + (oy * OW + ox) * Co;
              for (let kx = 0; kx < KW; kx++) {
                const ix = ox * sw + kx - pl;
                if (ix < 0 || ix >= Wd) continue;
                const i0 = xb + (iy * Wd + ix) * Ci, f0 = (ky * KW + kx) * Ci * Co;
                for (let ci = 0; ci < Ci; ci++) {
                  const v = xv[i0 + ci];
                  if (v === 0) continue;
                  const fr = f0 + ci * Co;
                  for (let co = 0; co < Co; co++) out[o0 + co] += v * fv[fr + co];
                }
              }
            }
          }
        }
      }
      if (bv || act === 'relu') {
        for (let i = 0; i < out.length; i += Co) for (let co = 0; co < Co; co++) {
          let v = out[i + co] + (bv ? bv[co] : 0);
          if (act === 'relu' && v < 0) v = 0;
          out[i + co] = v;
        }
      }
      return backend.makeTensorInfo([N, OH, OW, Co], 'float32', out);
    };
    tf.unregisterKernel('FusedConv2D', 'cpu');
    tf.registerKernel(Object.assign({}, orig, { kernelFunc: fast }));
  }

  let modelPromise = null;
  function getModel(opts) {
    if (!modelPromise) {
      modelPromise = (async () => {
        await ensureVendor();
        const { tf, loadGraphModel } = root.MTtf, M = root.BasicPitchModel;
        if (!tf || !M) throw new Error('model scripts missing');
        if (ENV.node && !tf.env().platform) {
          tf.setPlatform('mt-node', { now, fetch: (...a) => fetch(...a), encode: (s) => new TextEncoder().encode(s), decode: (b, e) => new TextDecoder(e).decode(b) });
        }
        let prefs = opts.backend ? [opts.backend] : ENV.node ? ['cpu'] : ['webgl', 'cpu'];
        if (ENV.worker && prefs[0] === 'webgl') {
          // Ask for a context first, so a worker without WebGL doesn't make TF.js log init failures.
          let ok = false;
          try {
            const attrs = { failIfMajorPerformanceCaveat: true }, c = new OffscreenCanvas(1, 1);   // same test TF.js makes
            const gl = c.getContext('webgl2', attrs) || new OffscreenCanvas(1, 1).getContext('webgl', attrs);
            ok = !!gl;
            const lose = gl && gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
          } catch (e) { ok = false; }
          if (!ok) prefs = ['cpu'];
        }
        // TF.js 3.x's browser platform reads `window` while polling WebGL fences; in a worker that
        // throws and the read never resolves. A plain setTimeout does the same job there.
        if (ENV.worker && tf.env().platform && tf.env().platform.setTimeoutCustom) tf.env().platform.setTimeoutCustom = (f, ms) => setTimeout(f, ms);
        let backend = null;
        for (const b of prefs) { try { if (await tf.setBackend(b)) { backend = b; break; } } catch (e) { /* try the next */ } }
        if (!backend) throw new Error('no TensorFlow.js backend');
        await tf.ready();
        if (backend === 'cpu') { try { installFastConv(tf); } catch (e) { /* keep TF.js's own kernel */ } }
        const model = await loadGraphModel(tf.io.fromMemory({ modelTopology: M.modelTopology, weightSpecs: M.weightSpecs, weightData: b64ToBuffer(M.weightsBase64) }));
        const t0 = now();
        const z = tf.zeros([1, BP.WIN, 1]);
        const outs = model.execute(z, ['Identity_1', 'Identity_2']);
        await outs[0].data();
        outs.forEach((t) => t.dispose()); z.dispose();
        return { tf, model, backend, warmMs: now() - t0 };
      })();
      modelPromise.catch(() => { modelPromise = null; });
    }
    return modelPromise;
  }

  /* Runs Basic Pitch over y (22.05 kHz, already shifted to A=440) in 2-second windows.
   * Returns frame/onset activations (86 frames/s x 88 keys). If the backend is too slow for the
   * time budget, only part of the song is transcribed (opts.pickFocus chooses where). */
  async function runModel(M, y, opts) {
    const { tf, model, backend } = M;
    const nFrames = Math.ceil(y.length / BP.HOP), nWin = Math.max(1, Math.ceil(nFrames / BP.KEEP));
    const frames = new Float32Array(nWin * BP.KEEP * BP.P), onsets = new Float32Array(nWin * BP.KEEP * BP.P);
    const covered = new Uint8Array(nWin * BP.KEEP);
    let B = 1;   // the first window measures the speed; a fast GPU then takes 4 at a time
    let plan = Array.from({ length: nWin }, (_, i) => i);
    const done = [];
    const t0 = now();
    let replanned = false;
    for (let pi = 0; pi < plan.length;) {
      checkAbort(opts.signal);
      const batch = plan.slice(pi, pi + B);
      const buf = new Float32Array(batch.length * BP.WIN);
      batch.forEach((w, i) => {
        const s0 = w * BP.HOP_WIN - BP.PAD;
        const from = Math.max(0, s0), to = Math.min(y.length, s0 + BP.WIN);
        if (to > from) buf.set(y.subarray(from, to), i * BP.WIN + (from - s0));
      });
      const inp = tf.tensor3d(buf, [batch.length, BP.WIN, 1]);
      const outs = model.execute(inp, ['Identity_1', 'Identity_2']);
      inp.dispose();
      const [fr, on] = await Promise.all([outs[0].data(), outs[1].data()]);
      outs.forEach((t) => t.dispose());
      batch.forEach((w, i) => {
        const src = (i * BP.FRAMES + BP.PAD_FR) * BP.P, len = BP.KEEP * BP.P;
        frames.set(fr.subarray(src, src + len), w * BP.KEEP * BP.P);
        onsets.set(on.subarray(src, src + len), w * BP.KEEP * BP.P);
        covered.fill(1, w * BP.KEEP, (w + 1) * BP.KEEP);
        done.push(w);
      });
      pi += batch.length;
      const spent = (now() - t0) / 1000, perWin = spent / done.length;
      if (backend === 'webgl' && !ENV.page && done.length >= 2) B = perWin < 0.5 ? 4 : 1;
      if (spent > opts.budgetSec * 1.15 && pi < plan.length) break;   // hard stop: keep what's done
      // On a page's main thread a slow GPU would freeze the UI: give up and let the DSP engine run.
      if (ENV.page && perWin > 0.4) throw new Error('model too slow for the main thread');
      if (!replanned && pi < plan.length && spent + perWin * (plan.length - pi) > opts.budgetSec) {
        // Too slow for the whole song: keep what's done, transcribe the most useful stretch.
        replanned = true;
        const focus = opts.pickFocus ? await opts.pickFocus() : null;
        const afford = Math.max(0, Math.floor((opts.budgetSec - (now() - t0) / 1000) / perWin));
        plan = done.concat(pickWindows(nWin, afford, new Set(done), focus == null ? null : Math.floor(focus / (BP.HOP_WIN / BP.SR * opts.ratio))));
      }
      opts.onProgress && opts.onProgress(Math.min(1, pi / plan.length));
      if (!(backend === 'webgl' && !ENV.page)) await tick();
    }
    return { frames, onsets, covered, nFrames: nWin * BP.KEEP, windows: done.length, windowsTotal: nWin, partial: done.length < nWin, seconds: (now() - t0) / 1000 };
  }
  // A contiguous block from the focus window (riff region), or evenly spread blocks.
  function pickWindows(nWin, count, skip, focusWin) {
    const out = [];
    const take = (w) => { if (w >= 0 && w < nWin && !skip.has(w) && out.indexOf(w) < 0 && out.length < count) out.push(w); };
    if (focusWin != null) {
      const start = Math.max(0, Math.min(nWin - count, focusWin));
      for (let w = start; w < nWin && out.length < count; w++) take(w);
      for (let w = start - 1; w >= 0 && out.length < count; w--) take(w);
    } else {
      const blocks = count >= 12 ? 3 : count >= 6 ? 2 : 1, len = Math.ceil(count / blocks);
      for (let b = 0; b < blocks; b++) {
        const c = Math.round((b + 0.5) * nWin / blocks - len / 2);
        for (let w = c; w < c + len; w++) take(w);
      }
      for (let w = 0; w < nWin && out.length < count; w++) take(w);
    }
    return out.sort((a, b) => a - b);
  }

  /* Model activations -> note events. A port of Basic Pitch's output_to_notes_polyphonic
   * (Apache-2.0, Spotify), rewritten over flat typed arrays so a 4-minute song decodes in well
   * under a second: onset peaks start notes that last while the frame activation stays up, then
   * leftover activation ("melodia trick") becomes further notes, strongest first. */
  function decodeNotes(frames, onsets, nF, opt) {
    opt = opt || {};
    const P = BP.P, onTh = opt.onsetThresh || 0.5, frTh = opt.frameThresh || 0.3, minLen = opt.minLen || 5, tol = 11;
    const n = nF * P;
    let onMax = 0, fdMax = 0;
    for (let i = 0; i < n; i++) if (onsets[i] > onMax) onMax = onsets[i];
    const inf = new Float32Array(n);
    for (let t = 2; t < nF; t++) for (let p = 0; p < P; p++) {
      const i = t * P + p, v = Math.min(frames[i] - frames[i - P], frames[i] - frames[i - 2 * P]);
      if (v > 0) { inf[i] = v; if (v > fdMax) fdMax = v; }
    }
    const sc = fdMax > 0 ? onMax / fdMax : 0;
    for (let i = 0; i < n; i++) inf[i] = Math.max(onsets[i], inf[i] * sc);
    const starts = [];
    for (let t = 0; t < nF; t++) for (let p = 0; p < P; p++) {
      const i = t * P + p, v = inf[i];
      if (v > onTh && (t === 0 || v > inf[i - P]) && (t === nF - 1 || v > inf[i + P])) starts.push(i);
    }
    const rem = Float32Array.from(frames.subarray(0, n));
    const notes = [];
    const clear = (j, p) => { rem[j * P + p] = 0; if (p < P - 1) rem[j * P + p + 1] = 0; if (p > 0) rem[j * P + p - 1] = 0; };
    const meanAmp = (a, b, p) => { let s = 0; for (let j = a; j < b; j++) s += frames[j * P + p]; return s / Math.max(1, b - a); };
    for (let s = starts.length - 1; s >= 0; s--) {
      const t0 = Math.floor(starts[s] / P), p = starts[s] % P;
      if (t0 >= nF - 1) continue;
      let i = t0 + 1, k = 0;
      while (i < nF - 1 && k < tol) { if (rem[i * P + p] < frTh) k++; else k = 0; i++; }
      i -= k;
      if (i - t0 <= minLen) continue;
      for (let j = t0; j < i; j++) clear(j, p);
      notes.push({ f0: t0, f1: i, p, amp: meanAmp(t0, i, p), onset: true });
    }
    if (opt.melodia !== false) {
      const cells = [];
      for (let i = 0; i < n; i++) if (rem[i] > frTh) cells.push(i);
      const vals = Float32Array.from(cells, (i) => rem[i]);
      const order = Array.from(cells.keys()).sort((a, b) => vals[b] - vals[a]);
      for (const oi of order) {
        const c = cells[oi];
        if (rem[c] <= frTh) continue;
        const tMid = Math.floor(c / P), p = c % P;
        rem[c] = 0;
        let i = tMid + 1, k = 0;
        while (i < nF - 1 && k < tol) { if (rem[i * P + p] < frTh) k++; else k = 0; clear(i, p); i++; }
        const iEnd = i - 1 - k;
        i = tMid - 1; k = 0;
        while (i > 0 && k < tol) { if (rem[i * P + p] < frTh) k++; else k = 0; clear(i, p); i--; }
        const iStart = i + 1 + k;
        if (iEnd - iStart <= minLen) continue;
        notes.push({ f0: iStart, f1: iEnd, p, amp: meanAmp(iStart, iEnd, p) });
      }
    }
    return notes;
  }

  // ---- Onset envelope, tempo and beat tracking ---------------------------------------------
  /* Log band-energy flux at 86 frames/s: full band (beats), low band (kick/snare/bass, for
   * telling the beat from the 8th-note level and finding the downbeat). */
  async function onsetEnvelope(x, sr, signal) {
    const N = 1024, hop = 256, win = hann(N), fps = sr / hop;
    const nF = Math.max(0, Math.floor((x.length - N) / hop) + 1);
    const nb = 30, edges = [];
    for (let b = 0; b <= nb; b++) edges.push(Math.max(1, Math.round(40 * Math.pow(8000 / 40, b / nb) * N / sr)));
    const lowB = edges.findIndex((k) => k * sr / N > 250), midB = edges.findIndex((k) => k * sr / N > 3000);
    const re = new Float32Array(N), im = new Float32Array(N);
    let prev = new Float32Array(nb), cur = new Float32Array(nb);
    const full = new Float32Array(nF), low = new Float32Array(nF), mid = new Float32Array(nF), rms = new Float32Array(nF);
    for (let f = 0; f < nF; f++) {
      if (f % 512 === 0) { checkAbort(signal); await tick(); }
      const off = f * hop;
      let e = 0;
      for (let i = 0; i < N; i++) { const v = x[off + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
      rms[f] = Math.sqrt(e / N);
      fft(re, im);
      for (let b = 0; b < nb; b++) {
        let s = 0;
        for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) s += re[k] * re[k] + im[k] * im[k];
        cur[b] = Math.log1p(1000 * Math.sqrt(s));
      }
      if (f) {
        let fl = 0, lo = 0, mi = 0;
        for (let b = 0; b < nb; b++) { const d = cur[b] - prev[b]; if (d > 0) { fl += d; if (b < lowB) lo += d; else if (b < midB) mi += d; } }
        full[f] = fl; low[f] = lo; mid[f] = mi;
      }
      const t = prev; prev = cur; cur = t;
    }
    return { full: normEnv(full, fps), low: normEnv(low, fps), mid: normEnv(mid, fps), rms, fps, t0: N / 2 / sr };
  }
  // Remove the slow trend, keep positive onsets, unit variance.
  function normEnv(e, fps) {
    const n = e.length, out = new Float32Array(n), w = Math.round(fps * 0.25);
    let s = 0, c = 0, lo = 0, hi = -1;
    for (let i = 0; i < n; i++) {
      while (hi < Math.min(n - 1, i + w)) { hi++; s += e[hi]; c++; }
      while (lo < i - w) { s -= e[lo]; lo++; c--; }
      out[i] = Math.max(0, e[i] - s / c);
    }
    let m2 = 0; for (let i = 0; i < n; i++) m2 += out[i] * out[i];
    const sd = Math.sqrt(m2 / Math.max(1, n)) || 1;
    for (let i = 0; i < n; i++) out[i] /= sd;
    return out;
  }
  function acfAt(env, lag) {
    const L = Math.floor(lag), fr = lag - L, n = env.length;
    const at = (l) => { let s = 0; for (let i = 0; i + l < n; i++) s += env[i] * env[i + l]; return s / Math.max(1, n - l); };
    return fr < 1e-6 ? at(L) : (1 - fr) * at(L) + fr * at(L + 1);
  }
  /* Tempo: autocorrelation of the onset envelope weighted by a log-normal prior around 120 BPM,
   * then a check of which metrical level carries the kick/snare/bass accents (to avoid the
   * classic double/half-time error). Beats: Ellis' dynamic-programming tracker, which follows
   * gradual tempo changes. */
  function trackBeats(oe, extraEnv) {
    const fps = oe.fps, n = oe.full.length;
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) env[i] = oe.full[i] + 0.6 * oe.low[i] + (extraEnv ? 0.6 * extraEnv[i] : 0);
    if (n < fps * 4) return { bpm: null, confidence: 0, beats: [] };
    const minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 50);
    const acf = new Float32Array(maxLag + 2);
    for (let l = minLag - 1; l <= maxLag + 1; l++) acf[l] = acfAt(env, l);
    let best = -1, bestLag = 0, sum = 0, cnt = 0;
    for (let l = minLag; l <= maxLag; l++) {
      const bpm = 60 * fps / l;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.55, 2));
      const s = acf[l] * prior;
      sum += acf[l]; cnt++;
      if (s > best && acf[l] >= acf[l - 1] && acf[l] >= acf[l + 1]) { best = s; bestLag = l; }
    }
    if (!bestLag) return { bpm: null, confidence: 0, beats: [] };
    const a = acf[bestLag - 1], b = acf[bestLag], c = acf[bestLag + 1], den = a - 2 * b + c;
    let period = bestLag + (den !== 0 ? 0.5 * (a - c) / den : 0);
    const confidence = Math.max(0, Math.min(1, (acf[bestLag] / (sum / cnt) - 1) / 1.5));
    let beats = dpBeats(env, period, fps);
    // Metrical level: a drum hit (kick or snare: low + mid band) lands on nearly every beat. If only
    // every other tracked beat has one, we're following 8th notes (hats, arpeggios): halve. If the
    // midpoints between slow beats have them too, double.
    const pulse = new Float32Array(n);
    for (let i = 0; i < n; i++) pulse[i] = oe.low[i] + oe.mid[i];
    const strength = (times) => times.map((t) => { const i = Math.round(t * fps); let m = 0; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n) m = Math.max(m, pulse[k]); return m; });
    const hitShare = (st, ref) => st.filter((v) => v >= 0.35 * ref).length / Math.max(1, st.length);
    let maybeHalf = false;
    if (beats.length > 16) {
      const st = strength(beats), ref = st.slice().sort((x, y) => x - y)[Math.floor(st.length * 0.9)];
      const bpmNow = 60 * fps / period, share = hitShare(st, ref);
      // Decided later from the chord rhythm (one chord per 8 tracked beats = we're on 8th notes).
      if (bpmNow / 2 >= 58 && share < 0.6) maybeHalf = true;
      else if (bpmNow < 84) {
        const mids = beats.slice(1).map((t, i) => (t + beats[i]) / 2);
        if (hitShare(strength(mids), ref) >= 0.7) { period /= 2; beats = dpBeats(env, period, fps); }
      }
    }
    beats = beats.map((t) => t + oe.t0).filter((t) => t > -0.1).map((t) => Math.max(0, t));
    const ibis = beats.slice(1).map((t, i) => t - beats[i]).sort((x, y) => x - y);
    const med = ibis.length ? ibis[Math.floor(ibis.length / 2)] : period / fps;
    // Mean tempo over the song (robust to a few doubled/missed beats): span / beats in the core.
    let bpm = 60 / med;
    if (beats.length > 8) {
      const core = beats.slice(2, -2), steps = core.length - 1;
      const meanIbi = (core[core.length - 1] - core[0]) / steps;
      if (Math.abs(meanIbi / med - 1) < 0.08) bpm = 60 / meanIbi;
    }
    return { bpm: Math.round(bpm * 10) / 10, confidence, beats, maybeHalf };
  }
  function dpBeats(env, period, fps) {
    const n = env.length, alpha = 100;
    const score = new Float32Array(n), back = new Int32Array(n).fill(-1);
    const lo = Math.round(period / 2), hi = Math.round(period * 2);
    for (let t = 0; t < n; t++) {
      let bs = 0, bi = -1;
      for (let tau = t - hi; tau <= t - lo; tau++) {
        if (tau < 0) continue;
        const d = Math.log((t - tau) / period), s = score[tau] - alpha * d * d;
        if (bi < 0 || s > bs) { bs = s; bi = tau; }
      }
      score[t] = env[t] + (bi >= 0 && bs > 0 ? bs : 0);
      back[t] = bi >= 0 && bs > 0 ? bi : -1;
    }
    // Start from the best-scoring frame in the last period.
    let t = n - 1, bs = -Infinity;
    for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > bs) { bs = score[i]; t = i; }
    const out = [];
    while (t >= 0) { out.push(t / fps); t = back[t]; }
    out.reverse();
    // Fill in beats before the first tracked one and after the last at the local period.
    const per = period / fps;
    while (out.length && out[0] - per > -0.15 * per) out.unshift(out[0] - per);
    while (out.length && out[out.length - 1] + per < n / fps) out.push(out[out.length - 1] + per);
    return out;
  }

  // ---- Beat-synchronous features -------------------------------------------------------------
  /* Chroma per beat from the model (note activations: cleaner than the spectrum because it has
   * no overtones) blended with tuning-corrected spectral chroma; plus a bass chroma. */
  function beatFeatures(beats, duration, dsp, mdl, ratio) {
    const nb = beats.length, cells = [];
    for (let i = 0; i < nb; i++) cells.push({ start: beats[i], end: i + 1 < nb ? beats[i + 1] : Math.min(duration, 2 * beats[i] - (beats[i - 1] || 0)), chroma: new Float32Array(12), bass: new Float32Array(12) });
    const idx = (t) => { let lo = 0, hi = nb - 1; if (t < beats[0]) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (beats[m] <= t) lo = m; else hi = m - 1; } return lo; };
    const dC = cells.map(() => new Float32Array(12)), dB = cells.map(() => new Float32Array(12)), dN = new Float32Array(nb), dE = new Float32Array(nb);
    dsp.chroma.forEach((c, f) => {
      const b = idx((f + 2) * dsp.frameSec);   // frame centre (2048-sample frames, 512 hop)
      if (b < 0) return;
      for (let k = 0; k < 12; k++) { dC[b][k] += c[k]; dB[b][k] += dsp.bass[f][k]; }
      dE[b] += dsp.energy[f]; dN[b]++;
    });
    const mC = cells.map(() => new Float32Array(12)), mB = cells.map(() => new Float32Array(12)), mN = new Float32Array(nb);
    if (mdl) {
      const P = BP.P, fsec = BP.HOP / BP.SR * ratio;
      for (let j = 0; j < mdl.nFrames; j++) {
        if (!mdl.covered[j]) continue;
        const b = idx(j * fsec + BP.TIME_OFFSET * ratio);
        if (b < 0) continue;
        mN[b]++;
        let lowest = -1;
        for (let p = 0; p < P; p++) {
          const v = mdl.frames[j * P + p];
          if (v < 0.15) continue;
          const midi = p + BP.MIDI0, pc = midi % 12;
          mC[b][pc] += v * (midi < 48 ? 0.5 : 1);
          if (lowest < 0 && midi < 60 && v > 0.3) lowest = midi;
        }
        if (lowest >= 0) mB[b][lowest % 12] += 1;
      }
    }
    const nrm = (v) => { let s = 0; for (const x of v) s += x; const o = new Float32Array(12); if (s > 0) for (let k = 0; k < 12; k++) o[k] = v[k] / s; return o; };
    const maxE = Math.max(1e-9, ...Array.from(dE, (e, i) => (dN[i] ? e / dN[i] : 0)));
    cells.forEach((c, i) => {
      const dc = nrm(dC[i]), db = nrm(dB[i]);
      // Spectral chroma is broad (every bin adds), so sharpen it before blending.
      const dcs = nrm(dc.map((v) => Math.pow(Math.max(0, v - 1 / 24), 1.5)));
      const hasM = mN[i] > 0 && mC[i].some((v) => v > 0);
      const mc = nrm(mC[i]), mb = nrm(mB[i]);
      for (let k = 0; k < 12; k++) {
        c.chroma[k] = hasM ? 0.75 * mc[k] + 0.25 * dcs[k] : dcs[k];
        c.bass[k] = hasM && mB[i].some((v) => v > 0) ? 0.7 * mb[k] + 0.3 * db[k] : db[k];
      }
      c.chroma = nrm(c.chroma); c.bass = nrm(c.bass);
      c.dsp = dC[i];
      c.energy = dN[i] ? dE[i] / dN[i] / maxE : 0;
      c.model = hasM;
    });
    return cells;
  }

  // ---- Key -----------------------------------------------------------------------------------
  // Profile correlation on a pitch-class histogram (notes weighted by length and loudness, bass
  // counted extra), then re-ranked by harmonic evidence once the chords are known.
  function keyProfileCands(hist) { return Theory.detectKey(Array.from(hist)); }
  function rerankKey(cands, chords, cells, downbeats) {
    const voiced = chords.filter((c) => c.rootPc != null);
    const total = voiced.reduce((a, s) => a + (s.end - s.start), 0) || 1;
    // Bass notes on downbeats point at the tonic.
    const dbBass = new Float32Array(12);
    downbeats.forEach((i) => { if (cells[i]) for (let k = 0; k < 12; k++) dbBass[k] += cells[i].bass[k]; });
    const dbs = dbBass.reduce((a, v) => a + v, 0) || 1;
    return cands.slice(0, 10).map((k) => {
      const pcs = Theory.scalePitchClasses(k.rootPc, k.scaleId), tq = k.scaleId === 'major' ? 'maj' : 'min';
      let dia = 0, tonic = 0, dom = 0;
      for (const s of voiced) {
        const cp = Theory.chordPitchClasses(s.rootPc, s.quality), d = s.end - s.start;
        if (cp.every((pc) => pcs.includes(pc))) dia += d;
        else if (k.scaleId === 'minor' && s.rootPc === mod12(k.rootPc + 7) && s.quality === 'maj') dia += 0.8 * d;   // harmonic-minor V
        if (s.rootPc === k.rootPc && s.quality === tq) tonic += d;
        if (s.rootPc === mod12(k.rootPc + 7)) dom += d;
      }
      const isTonic = (s) => s && s.rootPc === k.rootPc && s.quality === tq;
      const score = k.corr + 0.35 * (dia / total) + 0.45 * (tonic / total) + 0.05 * (dom / total) + 0.35 * (dbBass[k.rootPc] / dbs) +
        (isTonic(voiced[0]) ? 0.05 : 0) + (isTonic(voiced[voiced.length - 1]) ? 0.04 : 0);
      return Object.assign({}, k, { score });
    }).sort((a, b) => b.score - a.score);
  }

  // ---- Chords: HMM over 24 major/minor triads + "no chord", decoded with Viterbi -------------------
  const CHORDS = [];
  for (let r = 0; r < 12; r++) for (const q of ['maj', 'min']) CHORDS.push({ rootPc: r, quality: q, pcs: Theory.chordPitchClasses(r, q) });
  function decodeChords(cells, downbeatPhase, keyPcs) {
    const nb = cells.length, S = CHORDS.length + 1, NC = CHORDS.length;
    const em = cells.map((c) => {
      const out = new Float32Array(S);
      if (c.energy < 0.06) { out.fill(-3); out[NC] = 0; return out; }
      CHORDS.forEach((ch, s) => {
        let inS = 0;
        ch.pcs.forEach((pc, i) => { inS += c.chroma[pc] * (i === 0 ? 1.1 : i === 1 ? 1.0 : 0.85); });
        const outS = 1 - ch.pcs.reduce((a, pc) => a + c.chroma[pc], 0);
        const bassS = c.bass[ch.rootPc] + 0.25 * (c.bass[ch.pcs[1]] + c.bass[ch.pcs[2]]);
        let v = inS - 0.55 * outS + 0.45 * bassS;
        if (keyPcs && ch.pcs.every((pc) => keyPcs.includes(pc))) v += 0.04;
        out[s] = 9 * v;
      });
      out[NC] = 9 * 0.05;
      return out;
    });
    const change = (i) => { const pos = mod12(i - downbeatPhase) % 4; return pos === 0 ? 0.9 : pos === 2 ? 1.6 : 2.6; };
    let prev = em[0].slice();
    const bp = [];
    for (let i = 1; i < nb; i++) {
      const cur = new Float32Array(S), from = new Int16Array(S);
      let bestPrev = 0;
      for (let s = 1; s < S; s++) if (prev[s] > prev[bestPrev]) bestPrev = s;
      const pen = change(i);
      for (let s = 0; s < S; s++) {
        const stay = prev[s], sw = prev[bestPrev] - pen;
        if (stay >= sw || bestPrev === s) { cur[s] = stay + em[i][s]; from[s] = s; } else { cur[s] = sw + em[i][s]; from[s] = bestPrev; }
      }
      bp.push(from); prev = cur;
    }
    let s = 0;
    for (let k = 1; k < S; k++) if (prev[k] > prev[s]) s = k;
    const path = new Array(nb);
    path[nb - 1] = s;
    for (let i = nb - 1; i > 0; i--) { s = bp[i - 1][s]; path[i - 1] = s; }
    return path.map((st) => (st === NC ? null : CHORDS[st]));
  }

  const meanOf = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  function chromaDist(a, b) { let s = 0; for (let k = 0; k < 12; k++) s += Math.abs(a.chroma[k] - b.chroma[k]) + 0.7 * Math.abs(a.bass[k] - b.bass[k]); return s / 2; }
  // ---- Downbeat: chord changes, bass notes and low-band accents line up with bar starts ----------
  function findDownbeatPhase(cells, lowAt, bassOn) {
    const nb = cells.length, sc = [0, 0, 0, 0];
    const dist = (a, b) => { let s = 0; for (let k = 0; k < 12; k++) s += Math.abs(a[k] - b[k]); return s / 2; };
    for (let i = 1; i < nb; i++) {
      const nov = dist(cells[i].chroma, cells[i - 1].chroma) + 0.7 * dist(cells[i].bass, cells[i - 1].bass);
      sc[i % 4] += nov + 0.15 * (lowAt[i] || 0) + 0.25 * (bassOn[i] || 0);
    }
    let best = 0;
    for (let p = 1; p < 4; p++) if (sc[p] > sc[best]) best = p;
    return best;
  }

  // ---- Riff from transcribed notes ------------------------------------------------------------
  /* Places notes on an 8th-note grid that follows the tracked beats, splits them into a lead,
   * a middle and a bass line, and finds per line the 1-, 2- or 4-bar pattern that repeats most.
   * Repeats are matched tolerantly (a changed note, an octave slip or a note one step late still
   * counts partly); the shown riff is the majority vote over all repeats. */
  function findRiffFromNotes(notes, beats, phase, keyPcs, duration, extra) {
    if (!beats || beats.length < 8 || notes.length < 6) return { riff: null, melody: [] };
    const nb = beats.length;
    const ibi = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b)[Math.floor((nb - 1) / 2)];
    const beatPos = (t) => {
      if (t < beats[0]) return (t - beats[0]) / ibi;
      if (t >= beats[nb - 1]) return nb - 1 + (t - beats[nb - 1]) / ibi;
      let lo = 0, hi = nb - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (beats[m] <= t) lo = m; else hi = m; }
      return lo + (t - beats[lo]) / (beats[lo + 1] - beats[lo]);
    };
    const beatTime = (b) => (b <= 0 ? beats[0] + b * ibi : b >= nb - 1 ? beats[nb - 1] + (b - nb + 1) * ibi : beats[Math.floor(b)] + (b - Math.floor(b)) * (beats[Math.floor(b) + 1] - beats[Math.floor(b)]));
    const bar0 = phase - (phase > 0 ? 4 : 0);   // beat index where bar 0 starts (may be before the first beat)
    const nBars = Math.ceil((nb - bar0) / 4);
    // Pads/held chords: 3+ notes starting together that ring for over a beat and a half.
    const sorted = notes.slice().sort((a, b) => a.start - b.start);
    const pad = new Set();
    for (let i = 0; i < sorted.length;) {
      let j = i; while (j < sorted.length && sorted[j].start - sorted[i].start < 0.08) j++;
      const grp = sorted.slice(i, j), long = grp.filter((n) => n.end - n.start > 1.5 * ibi);
      if (grp.length >= 3 && long.length >= 2) long.forEach((n) => pad.add(n));
      i = j;
    }
    // Overtone ghosts: the model often adds weaker notes at the overtones (octave, 12th, 2 octaves...)
    // of a strong note, especially of the bass. Real riff notes stacked on the bass are usually louder.
    const ghost = new Set();
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      for (let j = i - 1; j >= 0 && n.start - sorted[j].start < 0.05; j--) chkGhost(n, sorted[j]);
      for (let j = i + 1; j < sorted.length && sorted[j].start - n.start < 0.05; j++) chkGhost(n, sorted[j]);
    }
    function chkGhost(n, m) {
      // The fundamental must be a real attack (not a held pad) and the ghost can't outlast it.
      if (m.onset !== false && !pad.has(m) && m.end - m.start < 2.5 * ibi && n.end <= m.end + 0.08 &&
          [12, 19, 24, 28, 31, 36].indexOf(n.midi - m.midi) >= 0 && n.velocity < 0.6 * m.velocity) ghost.add(n);
    }
    const vmax = Math.max(...notes.map((n) => n.velocity));
    // Riff notes are short-ish; anything ringing for more than 2.5 beats is a pad, drone or held chord.
    const cand = sorted.filter((n) => n.onset !== false && !pad.has(n) && !ghost.has(n) && n.velocity >= 0.2 * vmax && n.end - n.start > 0.05 && n.end - n.start < 2.5 * ibi);
    const streams = {
      lead: { test: (m) => m >= 60, pick: 'high', bias: 1 },
      mid: { test: (m) => m >= 40 && m < 72, pick: 'high', bias: 1 },
      bass: { test: (m) => m < 55, pick: 'low', bias: 0.9 },
    };
    let best = null;
    const results = {};
    for (const name of Object.keys(streams)) {
      const st = streams[name];
      // Grid: 8th notes, or 16th notes when many of this line's notes start between the 8ths.
      const own = cand.filter((n) => st.test(n.midi));
      const off8 = own.filter((n) => { const x = 2 * (beatPos(n.start) - bar0); return Math.abs(x - Math.round(x)) > 0.3; }).length;
      const sub = own.length >= 8 && off8 / own.length > 0.22 ? 4 : 2, spb = 4 * sub;
      // One note per grid step: the top (or bottom) of the louder notes starting there.
      const bySlot = new Map();
      for (const n of cand) {
        if (!st.test(n.midi) && !(st.pick === 'high' && n.midi >= 36)) continue;
        const step = Math.round(sub * (beatPos(n.start) - bar0));
        if (step < 0) continue;
        const e = bySlot.get(step);
        if (!e) bySlot.set(step, [n]); else e.push(n);
      }
      const bars = Array.from({ length: nBars }, () => []);
      const line = [];
      for (const [step, ns0] of bySlot) {
        const ns = ns0.filter((n) => st.test(n.midi));
        if (!ns.length) continue;
        const vm = Math.max(...ns.map((n) => n.velocity));
        const ok = ns.filter((n) => n.velocity >= 0.7 * vm);
        let n = ok.reduce((a, b) => (st.pick === 'high' ? (b.midi > a.midi ? b : a) : (b.midi < a.midi ? b : a)));
        // Power chords (root + 5th, same length): the riff is the root at the bottom of the shape.
        for (let g = 0; g < 3 && st.pick === 'high'; g++) {
          const dn = n.end - n.start;
          const r = ns0.find((m) => [5, 7].indexOf(n.midi - m.midi) >= 0 && m.velocity >= 0.5 * n.velocity && Math.abs(Math.log((m.end - m.start) / dn)) < 0.5);
          if (!r) break;
          n = r;
        }
        const bar = Math.floor(step / spb);
        if (bar >= nBars) continue;
        const dur = Math.max(1, Math.round(sub * (beatPos(n.end) - beatPos(n.start))));
        bars[bar].push({ step: step % spb, midi: n.midi, dur, vel: n.velocity, w: Math.min(1, n.velocity / (0.8 * vmax)) });
        line.push({ start: n.start, dur: n.end - n.start, midi: n.midi, strength: n.velocity });
      }
      bars.forEach((b) => b.sort((x, y) => x.step - y.step));
      const r = repeatSearch(bars, nBars, spb);
      if (!r) continue;
      r.sub = sub; r.spb = spb;
      // Melodic interest: a riff moves; a bass pedal on the root doesn't.
      let changes = 0;
      for (let i = 1; i < r.notes.length; i++) if (r.notes[i].midi !== r.notes[i - 1].midi) changes++;
      const distinct = new Set(r.notes.map((n) => n.midi)).size;
      const interest = Math.min(1, Math.max(0.25, distinct / 3)) * Math.min(1, Math.max(0.25, changes / (2.5 * r.L)));
      // One line, not two registers taking turns (e.g. bass notes alternating with chord stabs).
      let near = 0;
      for (let i = 1; i < r.notes.length; i++) if (Math.abs(r.notes[i].midi - r.notes[i - 1].midi) <= 9) near++;
      const coherence = r.notes.length > 1 ? near / (r.notes.length - 1) : 1;
      const loud = r.notes.reduce((a, n) => a + n.vel, 0) / r.notes.length;
      const final = r.score * interest * (0.4 + 0.6 * coherence) * st.bias * (0.6 + 0.4 * loud / vmax);
      results[name] = Object.assign(r, { final, name, line });
      if (!best || final > best.final) best = results[name];
    }
    // A riff doubled by the bass an octave or two down: show it in the higher (guitar/keys) register.
    if (best && best.name === 'bass' && results.mid) {
      const m = results.mid, sameSteps = best.notes.filter((n) => m.notes.some((k) => k.step === n.step && mod12(k.midi) === mod12(n.midi))).length;
      if (m.L === best.L && m.spb === best.spb && sameSteps >= 0.75 * best.notes.length && m.final >= 0.6 * best.final) best = m;
    }
    if (!best) return { riff: null, melody: [] };
    const L = best.L, sub = best.sub, spb = best.spb;
    const barStart = (bar) => beatTime(bar0 + 4 * bar);
    // Parts of the song the model didn't hear (time budget): look for the riff in the quick DSP
    // melody there, so "play in time" still gets those repeats.
    if (extra && extra.notes && extra.notes.length) {
      const xb = Array.from({ length: nBars }, () => []);
      for (const n of extra.notes) {
        const step = Math.round(sub * (beatPos(n.start) - bar0));
        if (step >= 0 && step < nBars * spb) xb[Math.floor(step / spb)].push({ step: step % spb, midi: n.midi, w: 1 });
      }
      const taken = new Set();
      best.occ.forEach((o) => { for (let b = 0; b < L; b++) taken.add(o.bar + b); });
      const pat = best.notes.map((n) => ({ step: n.step, midi: n.midi, w: 1 }));
      for (let t = 0; t + L <= nBars;) {
        let free = true;
        for (let b = 0; b < L; b++) if (taken.has(t + b) || extra.covered(barStart(t + b), barStart(t + b + 1))) free = false;
        if (!free) { t++; continue; }
        const span = []; for (let b = 0; b < L; b++) for (const n of xb[t + b]) span.push({ step: b * spb + n.step, midi: n.midi, w: 1 });
        const v = simNotes(pat, span);
        if (v.s >= 0.5) { best.occ.push({ bar: t, sim: v.s, dsp: true }); t += L; } else t++;
      }
      best.occ.sort((a, b) => a.bar - b.bar);
    }
    const riffNotes = best.notes.map((n) => ({ step: n.step, midi: n.midi, dur: n.dur, agree: Math.round(n.agree * 100) / 100, inKey: !keyPcs || keyPcs.includes(mod12(n.midi)) }));
    const occurrences = best.occ.map((o) => {
      const s = barStart(o.bar), e = barStart(o.bar + L);
      return { start: r3(s), end: r3(Math.min(duration, e)), match: Math.round(o.sim * 100) / 100, stepSec: r3((e - s) / (spb * L)) };
    });
    let phaseT = barStart(0);
    while (phaseT < 0) phaseT += 4 * ibi;
    const riff = {
      bars: L, spb, stepSec: ibi / sub, barSec: 4 * ibi, phase: phaseT, score: Math.round(best.final * 1000) / 1000,
      notes: riffNotes, occurrences,
      confidence: Math.round(best.occ.filter((o) => !o.dsp).reduce((a, o) => a + o.sim, 0) / Math.max(1, best.occ.filter((o) => !o.dsp).length) * 100) / 100,
      offKey: riffNotes.filter((n) => !n.inKey).length,
      unsure: riffNotes.filter((n) => n.agree < 0.75).length,
      line: best.name,
    };
    return { riff, melody: best.line };
  }
  // Tolerant similarity of two note lists over the same L bars (step = 8th index within the span).
  function simNotes(A, B) {
    if (!A.length || !B.length) return { s: 0, m: 0 };
    const used = new Uint8Array(B.length);
    let m = 0, wA = 0, wB = 0;
    for (const a of A) wA += a.w || 1;
    for (const b of B) wB += b.w || 1;
    for (const a of A) {
      let bi = -1, bv = 0;
      for (let j = 0; j < B.length; j++) {
        if (used[j]) continue;
        const b = B[j], ds = Math.abs(a.step - b.step);
        let v = 0;
        if (ds === 0 && a.midi === b.midi) v = 1;
        else if (ds === 0 && (a.midi - b.midi) % 12 === 0) v = 0.6;
        else if (ds === 1 && a.midi === b.midi) v = 0.6;
        else if (ds === 0 && Math.abs(a.midi - b.midi) <= 2) v = 0.25;
        if (v > bv) { bv = v; bi = j; }
      }
      if (bi >= 0) { used[bi] = 1; m += bv * Math.min(a.w || 1, B[bi].w || 1); }
    }
    return { s: m / Math.max(wA, wB), m, wA, wB };
  }
  function repeatSearch(bars, nBars, spb) {
    spb = spb || 8;
    const span = (s, L) => { const out = []; for (let b = 0; b < L; b++) for (const n of bars[s + b] || []) out.push({ step: b * spb + n.step, midi: n.midi, dur: n.dur, vel: n.vel, w: n.w }); return out; };
    const TH = 0.55;
    const occFor = (P, L) => {
      const occ = [];
      for (let t = 0; t + L <= nBars;) {
        const v = simNotes(P, span(t, L));
        if (v.s >= TH) { occ.push({ bar: t, sim: v.s }); t += L; } else t++;
      }
      return occ;
    };
    const consensus = (occ, L) => {
      const votes = new Map();
      for (const o of occ) for (const n of span(o.bar, L)) {
        if (!votes.has(n.step)) votes.set(n.step, new Map());
        const vm = votes.get(n.step), e = vm.get(n.midi) || { count: 0, dur: [], vel: 0, w: 0 };
        e.count++; e.dur.push(n.dur); e.vel += n.vel; e.w += n.w; vm.set(n.midi, e);
      }
      const out = [];
      for (const [step, vm] of votes) {
        // Vote on the pitch class first (an octave slip in one repeat shouldn't split the vote), then the octave.
        const pcs = new Map();
        for (const [midi, e] of vm) { const pc = mod12(midi), g = pcs.get(pc) || { count: 0, best: null }; g.count += e.count; if (!g.best || e.count > g.best.e.count) g.best = { midi, e }; pcs.set(pc, g); }
        let top = null;
        for (const g of pcs.values()) if (!top || g.count > top.count) top = g;
        if (top.count / occ.length > 0.5) {
          const e = top.best.e, d = e.dur.slice().sort((a, b) => a - b)[Math.floor(e.dur.length / 2)];
          const agree = (e.count + 0.5 * (top.count - e.count)) / occ.length;
          out.push({ step, midi: top.best.midi, dur: d, agree, vel: e.vel / e.count, w: e.w / e.count });
        }
      }
      // Quiet notes filling the riff's gaps (an arpeggio or comp behind it) are not part of it.
      const vs = out.map((n) => n.vel).sort((a, b) => a - b), vmed = vs[Math.floor(vs.length / 2)] || 0;
      for (let i = out.length - 1; i >= 0; i--) if (out[i].vel < 0.65 * vmed) out.splice(i, 1);
      out.sort((a, b) => a.step - b.step);
      out.forEach((n, i) => { const nx = out[i + 1]; n.dur = Math.max(1, Math.min(n.dur, (nx ? nx.step : L * spb) - n.step)); });
      return out;
    };
    const evalPat = (occ, C, L) => {
      let sc = 0;
      for (const o of occ) { const O = span(o.bar, L), v = simNotes(C, O); sc += v.m - 0.35 * (v.wB - v.m) - 0.35 * (v.wA - v.m); }
      return sc;
    };
    let best = null;
    const bestByL = {};
    for (const L of [1, 2, 4]) {
      const tried = new Set();
      for (let s = 0; s + L <= nBars; s++) {
        const P = span(s, L);
        if (P.length < 3) continue;
        const sig = P.map((n) => n.step + ':' + n.midi).join(' ');
        if (tried.has(sig)) continue;
        tried.add(sig);
        let occ = occFor(P, L);
        if (occ.length < 2) continue;
        let C = consensus(occ, L);
        if (C.length < 3) continue;
        // Re-match against the consensus (more tolerant to a seed bar that had a mistake).
        const occ2 = occFor(C, L);
        if (occ2.length >= 2) { const C2 = consensus(occ2, L); if (C2.length >= 3) { occ = occ2; C = C2; } }
        const score = evalPat(occ, C, L) - 0.02 * L;
        const cand = { L, occ: occ.map((o) => ({ bar: o.bar, sim: simNotes(C, span(o.bar, L)).s })), notes: C, score };
        if (!bestByL[L] || score > bestByL[L].score + 1e-9) bestByL[L] = cand;
        if (!best || score > best.score + 1e-9) best = cand;
      }
    }
    // A 4-bar "riff" that is the same 2 bars twice is a 2-bar riff (fewer repeats vote on more noise).
    while (best && best.L > 1) {
      const h = best.L / 2, small = bestByL[h];
      const A = best.notes.filter((n) => n.step < h * 8), B = best.notes.filter((n) => n.step >= h * 8).map((n) => Object.assign({}, n, { step: n.step - h * 8 }));
      if (small && (small.score >= 0.8 * best.score || (simNotes(A, B).s >= 0.5 && small.score >= 0.6 * best.score))) best = small; else break;
    }
    return best && best.score > 0 ? best : null;
  }

  // ---- Sections: 4-bar blocks grouped by chroma similarity (as in the DSP engine) ----------------
  /* Blocks are 4 bars long; the block grid is shifted by 0-3 bars to whichever alignment makes the
   * song most repetitive (so a 2-bar intro doesn't misalign every section after it). */
  function sectionsFromBars(cells, phase, duration) {
    const barStarts = [];
    for (let i = phase; i < cells.length; i += 4) barStarts.push(i);
    if (barStarts.length < 2) return [{ start: 0, end: duration, label: 'A' }];
    let best = null;
    for (let off = 0; off < 4 && off < barStarts.length; off++) {
      const secs = sectionsWithOffset(cells, barStarts, off, duration);
      const n = new Set(secs.map((x) => x.label)).size;
      if (!best || n < best.n || (n === best.n && secs.length < best.secs.length)) best = { n, secs };
    }
    return best.secs;
  }
  function sectionsWithOffset(cells, barStarts, off, duration) {
    const cuts = [0];
    for (let bi = off; bi < barStarts.length; bi += 4) if (bi > 0) cuts.push(barStarts[bi]);
    const blocks = [];
    for (let j = 0; j < cuts.length; j++) {
      const from = cuts[j], to = j + 1 < cuts.length ? cuts[j + 1] : cells.length;
      const c = new Array(12).fill(0);
      for (let i = from; i < to; i++) for (let k = 0; k < 12; k++) c[k] += cells[i].dsp[k];
      blocks.push({ start: j === 0 ? 0 : cells[from].start, end: j + 1 < cuts.length ? cells[to].start : duration, chroma: c, beats: to - from });
    }
    // Short pickup/trailing blocks (intro bars, fade-out) join their neighbour.
    if (blocks.length > 1 && blocks[0].beats < 8) { blocks[1].start = 0; for (let k = 0; k < 12; k++) blocks[1].chroma[k] += 0.25 * blocks[0].chroma[k]; blocks.shift(); }
    if (blocks.length > 1 && blocks[blocks.length - 1].beats < 8) blocks[blocks.length - 2].end = blocks.pop().end;
    const protos = [], sections = [];
    for (const b of blocks) {
      let label = null;
      for (const p of protos) if (Theory.pearson(p.chroma, b.chroma) > SECTION_SIMILARITY) { label = p.label; break; }
      if (!label) { label = String.fromCharCode(65 + Math.min(protos.length, 25)); protos.push({ label, chroma: b.chroma }); }
      const last = sections[sections.length - 1];
      if (last && last.label === label) last.end = b.end; else sections.push({ start: r3(b.start), end: r3(b.end), label });
    }
    return sections;
  }

  // ---- The model pipeline -----------------------------------------------------------------------
  async function analyzeModel(samples, sampleRate, opts, M, pre) {
    const onStage = opts.onStage || (() => {}), signal = opts.signal;
    const duration = samples.length / sampleRate;
    const timings = {};
    let t0 = now();
    const { x22, tuning, a4 } = pre;
    const ratio = 440 / a4;   // model time * ratio = song time
    // Shift the audio so the model hears A=440 (only when the song is noticeably detuned).
    const y = Math.abs(tuning.cents) >= 3 && tuning.confidence >= 0.2 ? resample(samples, sampleRate, BP.SR / ratio) : x22;
    const useRatio = y === x22 ? 1 : ratio;
    timings.prepare = pre.ms + (now() - t0);

    onStage('listen', 0);
    t0 = now();
    const x11 = downsample(samples, sampleRate, 11025);
    let dspFrames = null;
    const getDspFrames = async () => dspFrames || (dspFrames = await spectralFrames(x11.data, x11.sr, { frameSize: 2048, hop: 512, a4, bass: true }, null, signal));
    let focusCache, dspMelody = null;
    const pickFocus = async () => {
      // Under a time budget: centre the model on where the quick DSP riff finder hears a riff.
      if (focusCache !== undefined) return focusCache;
      const fr = await getDspFrames();
      const tempo = estimateTempo(fr.flux, fr.frameSec);
      const mel = dspMelody = await transcribeMelody(x11.data, x11.sr, signal, a4 / 440);
      const rf = findRiff(mel, tempo.confidence > 0.15 ? tempo.bpm : null, duration, null);
      focusCache = rf && rf.occurrences.length ? Math.max(0, rf.occurrences[0].start - 1) : duration * 0.2;
      return focusCache;
    };
    const mdl = opts._mdl || await runModel(M, y, { signal, budgetSec: opts.modelBudgetSec || 32, ratio: useRatio, pickFocus, onProgress: (p) => onStage('listen', 0.95 * p) });
    timings.model = now() - t0;
    t0 = now();
    const raw = decodeNotes(mdl.frames, mdl.onsets, mdl.nFrames);
    const fsec = BP.HOP / BP.SR;
    let notes = raw.map((n) => ({ start: (n.f0 * fsec + BP.TIME_OFFSET) * useRatio, end: (n.f1 * fsec + BP.TIME_OFFSET) * useRatio, midi: n.p + BP.MIDI0, velocity: n.amp, onset: !!n.onset }))
      .filter((n) => n.start < duration).sort((a, b) => a.start - b.start || a.midi - b.midi);
    timings.decode = now() - t0;
    onStage('listen', 1);

    onStage('key', 0);
    await tick();
    t0 = now();
    const fr = await getDspFrames();
    const hist = new Float32Array(12);
    for (const n of notes) hist[n.midi % 12] += Math.min(2, n.end - n.start) * n.velocity * (n.midi < 52 ? 1.5 : 1);
    const dTot = new Float32Array(12);
    fr.chroma.forEach((c, i) => { const w = fr.energy[i]; for (let k = 0; k < 12; k++) dTot[k] += c[k] * w; });
    const hs = hist.reduce((a, v) => a + v, 0), ds = dTot.reduce((a, v) => a + v, 0) || 1;
    const coverage = mdl.windows / mdl.windowsTotal;
    const wD = hs ? 0.4 + (1 - coverage) : 1;
    const keyHist = Array.from(hist, (v, k) => (hs ? v / hs : 0) + wD * dTot[k] / ds);
    const profileCands = keyProfileCands(keyHist);
    timings.key = now() - t0;

    onStage('tempo', 0);
    await tick();
    t0 = now();
    // With separated instruments, the beat comes from the drums (and bass) alone.
    const parts = opts.parts || null;
    const beatSrc = parts && parts.beat ? resample(parts.beat, sampleRate, BP.SR) : x22;
    const oe = await onsetEnvelope(beatSrc, BP.SR, signal);
    const noteEnv = new Float32Array(oe.full.length);
    for (const n of notes) { const i = Math.round((n.start - oe.t0) * oe.fps); if (i >= 0 && i < noteEnv.length) noteEnv[i] += n.velocity; }
    const tempoR = trackBeats(oe, normEnv(noteEnv, oe.fps));
    let beats = tempoR.beats.filter((t) => t >= 0 && t < duration);
    if (beats.length < 8) {   // no usable beat: a 2-second grid keeps chords and sections working
      beats = []; for (let t = 0; t < duration; t += 0.5) beats.push(t);
    }
    timings.tempo = now() - t0;

    onStage('chords', 0);
    await tick();
    t0 = now();
    const mdlForCells = mdl.covered.some((v) => v) ? mdl : null;
    let cells = beatFeatures(beats, duration, fr, mdlForCells, useRatio);
    if (tempoR.maybeHalf) {
      // Chords usually change once a bar. If they change every 8 tracked beats, not every 4, the
      // tracker followed 8th notes: keep every other beat (the ones the chords change on).
      // Compare 2-beat windows (so off-beat stabs don't look like chord changes).
      let bA = -1, bB = 0, bp = 0;
      for (let par = 0; par < 2; par++) {
        const win = [];
        for (let i = par; i + 1 < cells.length; i += 2) {
          const c = { chroma: new Float32Array(12), bass: new Float32Array(12) };
          for (let k = 0; k < 12; k++) { c.chroma[k] = (cells[i].chroma[k] + cells[i + 1].chroma[k]) / 2; c.bass[k] = (cells[i].bass[k] + cells[i + 1].bass[k]) / 2; }
          win.push(c);
        }
        const nov = win.map((c, j) => { if (!j) return 0; let d = 0; for (let k = 0; k < 12; k++) d += Math.abs(c.chroma[k] - win[j - 1].chroma[k]); return d / 2; });
        for (let q = 0; q < 4; q++) {
          const A = meanOf(nov.filter((_, j) => j % 4 === q)), B = meanOf(nov.filter((_, j) => j % 4 === (q + 2) % 4));
          if (A > bA) { bA = A; bB = B; bp = par; }
        }
      }
      if (bB < 0.7 * bA) {
        beats = beats.filter((_, i) => i % 2 === bp);
        tempoR.bpm = Math.round(tempoR.bpm / 2 * 10) / 10;
        cells = beatFeatures(beats, duration, fr, mdlForCells, useRatio);
      }
    }
    const lowAt = beats.map((t) => { const i = Math.round((t - oe.t0) * oe.fps); let m = 0; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < oe.low.length) m = Math.max(m, oe.low[k]); return m; });
    const bassOn = new Float32Array(beats.length);
    for (const n of notes) if (n.midi < 55) {
      let lo = 0, hi = beats.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (beats[m] <= n.start + 0.05) lo = m; else hi = m - 1; }
      if (Math.abs(beats[lo] - n.start) < 0.07) bassOn[lo] += n.velocity;
    }
    const bmax = Math.max(1e-9, ...bassOn); for (let i = 0; i < bassOn.length; i++) bassOn[i] /= bmax;
    const phase = findDownbeatPhase(cells, lowAt.map((v) => Math.min(3, v) / 3), bassOn);
    let path = decodeChords(cells, phase, null);
    const toSegs = (pth) => {
      const segs = [];
      pth.forEach((ch, i) => {
        const c = cells[i];
        const last = segs[segs.length - 1];
        if (!ch) return;
        if (last && last.rootPc === ch.rootPc && last.quality === ch.quality && Math.abs(last.end - c.start) < 0.01) { last.end = c.end; return; }
        segs.push({ start: c.start, end: c.end, rootPc: ch.rootPc, quality: ch.quality });
      });
      if (segs.length) { if (segs[0].start < 1.5) segs[0].start = 0; const l = segs[segs.length - 1]; if (duration - l.end < 1.5) l.end = duration; }
      return segs;
    };
    const downbeats = []; for (let i = phase; i < cells.length; i += 4) downbeats.push(i);
    let cands = rerankKey(profileCands, toSegs(path), cells, downbeats);
    // Decode again with a light preference for the key's chords, then re-check the key.
    path = decodeChords(cells, phase, Theory.scalePitchClasses(cands[0].rootPc, cands[0].scaleId));
    let segs = toSegs(path);
    cands = rerankKey(profileCands, segs, cells, downbeats);
    const key = cands[0];
    const conf = Theory.keyConfidence(cands.map((c) => ({ rootPc: c.rootPc, scaleId: c.scaleId, corr: c.corr + (c.score - c.corr) * 0.5 })));
    const dia = Theory.diatonicChords(key.rootPc, key.scaleId);
    const chords = segs.map((s) => {
      const d = dia.find((x) => x.rootPc === s.rootPc && x.quality === s.quality);
      return { start: r3(s.start), end: r3(s.end), rootPc: s.rootPc, quality: s.quality, name: Theory.chordName(s.rootPc, s.quality, key.rootPc), pcs: Theory.chordPitchClasses(s.rootPc, s.quality), roman: d ? d.roman : null };
    });
    timings.chords = now() - t0;

    onStage('sections', 0);
    await tick();
    const sections = sectionsFromBars(cells, phase, duration);

    onStage('riff', 0);
    await tick();
    t0 = now();
    const keyPcs = Theory.scalePitchClasses(key.rootPc, key.scaleId);
    if (mdl.partial && !dspMelody) await pickFocus();
    const fsecR = BP.HOP / BP.SR * useRatio;
    const coveredAt = (a, b) => { const j = Math.min(mdl.nFrames - 1, Math.max(0, Math.round(((a + b) / 2) / fsecR))); return !!mdl.covered[j]; };
    let rr = findRiffFromNotes(notes, beats, phase, keyPcs, duration, mdl.partial && dspMelody ? { notes: dspMelody, covered: coveredAt } : null);
    // Separated instruments: listen to each one on its own and keep the clearest riff. All options are
    // returned so Riff Mode can switch between them.
    let riffOptions = null;
    if (parts && parts.riff && parts.riff.length) {
      riffOptions = [{ id: 'mix', riff: rr.riff, melody: rr.melody.slice(0, 2000) }];
      const focus = rr.riff && rr.riff.occurrences.length ? Math.max(0, rr.riff.occurrences[0].start - 1) : (focusCache !== undefined ? focusCache : duration * 0.2);
      for (let pi = 0; pi < parts.riff.length; pi++) {
        const part = parts.riff[pi];
        onStage('riff', pi / parts.riff.length);
        const yp = resample(part.samples, sampleRate, BP.SR / useRatio);
        const pm = await runModel(M, yp, { signal, budgetSec: opts.partBudgetSec || 24, ratio: useRatio, pickFocus: async () => focus, onProgress: (q) => onStage('riff', (pi + 0.9 * q) / parts.riff.length) });
        const pn = decodeNotes(pm.frames, pm.onsets, pm.nFrames)
          .map((n) => ({ start: (n.f0 * fsec + BP.TIME_OFFSET) * useRatio, end: (n.f1 * fsec + BP.TIME_OFFSET) * useRatio, midi: n.p + BP.MIDI0, velocity: n.amp, onset: !!n.onset }))
          .filter((n) => n.start < duration).sort((a, b) => a.start - b.start || a.midi - b.midi);
        const pr = findRiffFromNotes(pn, beats, phase, keyPcs, duration, null);
        if (pr.riff) pr.riff.source = part.id;
        riffOptions.push({ id: part.id, riff: pr.riff, melody: pr.melody.slice(0, 2000) });
      }
      // A riff found in one instrument beats the same strength found in the whole mix.
      const val = (o) => (o.riff ? o.riff.score * (o.id === 'mix' ? 0.85 : 1) : -1);
      const pick = riffOptions.reduce((a, b) => (val(b) > val(a) ? b : a));
      if (pick.riff) rr = { riff: pick.riff, melody: pick.melody };
    }
    timings.riff = now() - t0;

    if (notes.length > MAX_NOTES) {
      const keep = new Set(notes.slice().sort((a, b) => b.velocity - a.velocity).slice(0, MAX_NOTES));
      notes = notes.filter((n) => keep.has(n));
    }
    onStage('done', 1);
    return {
      duration,
      key: { rootPc: key.rootPc, scaleId: key.scaleId, label: key.label },
      keyCandidates: cands.slice(0, 3).map((c) => ({ rootPc: c.rootPc, scaleId: c.scaleId, label: c.label, corr: c.corr })),
      keyConfidence: conf,
      tempo: { bpm: tempoR.bpm, confidence: Math.round(tempoR.confidence * 100) / 100 },
      beats: beats.map(r3),
      downbeat: beats.length ? r3(beats[phase]) : null,
      chords,
      sections,
      melody: rr.melody.slice(0, 2000).map((n) => ({ start: r3(n.start), dur: r3(n.dur), midi: n.midi, strength: Math.round(n.strength * 100) / 100 })),
      riff: rr.riff,
      riffOptions: riffOptions || undefined,
      parts: parts ? { beat: !!parts.beat, riff: (parts.riff || []).map((x) => x.id) } : undefined,
      tuning,
      notes: notes.map((n) => ({ start: r3(n.start), end: r3(n.end), midi: n.midi, velocity: Math.round(n.velocity * 100) / 100 })),
      engine: 'basic-pitch' + (mdl.partial ? ' (partial)' : '') + ' + dsp',
      _mdl: opts._keepMdl ? mdl : undefined,
      engineInfo: { backend: M.backend, worker: ENV.worker, windows: mdl.windows, windowsTotal: mdl.windowsTotal, modelSec: Math.round(mdl.seconds * 10) / 10,
        timingsMs: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])) },
    };
  }

  /* Shared start: checks, resampling to 22.05 kHz and tuning detection (stage 'prepare'). */
  async function prepare(samples, sampleRate, opts) {
    const onStage = opts.onStage || (() => {});
    const duration = samples.length / sampleRate;
    if (!samples.length || duration < 4) throw new AnalysisError('too_short', 'This clip is shorter than 4 seconds, which is not enough to hear a key.');
    onStage('prepare', 0);
    const t0 = now();
    let rms = 0;
    const stp = Math.max(1, Math.floor(samples.length / 2e6));
    let cnt = 0;
    for (let i = 0; i < samples.length; i += stp) { rms += samples[i] * samples[i]; cnt++; }
    if (Math.sqrt(rms / cnt) < 0.003) throw new AnalysisError('silent', 'The audio is silent or almost silent.');
    await tick();
    checkAbort(opts.signal);
    const x22 = resample(samples, sampleRate, BP.SR);
    onStage('prepare', 0.5);
    await tick();
    const tuning = await detectTuning(x22, BP.SR, opts.signal);
    const a4 = tuning.confidence >= 0.2 ? tuning.a4 : 440;
    onStage('prepare', 1);
    return { x22, tuning, a4, ms: now() - t0 };
  }

  /* Runs in this thread: the model engine if it can load (not on a page's main thread, where it
   * would block the UI), otherwise the DSP engine. */
  async function analyzeLocal(samples, sampleRate, opts) {
    opts = opts || {};
    const pre = await prepare(samples, sampleRate, opts);
    // The DSP engine only shifts its pitch grid for clearly detuned songs, so in-tune songs analyse exactly as before.
    const dspOpts = Object.assign({}, opts, { a4: Math.abs(pre.a4 - 440) >= 440 * (Math.pow(2, 3 / 1200) - 1) ? pre.a4 : 440, tuning: pre.tuning });
    if (opts.engine === 'dsp') return analyzeDsp(samples, sampleRate, Object.assign(dspOpts, { engineName: 'dsp' }));
    let M = null;
    try {
      (opts.onStage || (() => {}))('listen', 0);
      // On a page's own thread (file://, no worker) the model would freeze the UI: use DSP there.
      M = ENV.page && !opts.inPage ? null : await getModel(opts);
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('Music Theorizer: note model unavailable, using DSP analysis.', e && e.message);
      M = null;
    }
    checkAbort(opts.signal);
    const onStage0 = opts.onStage || (() => {});
    dspOpts.onStage = (st, p) => { if (st !== 'prepare') onStage0(st, p); };
    if (!M) return analyzeDsp(samples, sampleRate, dspOpts);
    try {
      return await analyzeModel(samples, sampleRate, opts, M, pre);
    } catch (e) {
      if (e && e.code) throw e;
      if (typeof console !== 'undefined') console.warn('Music Theorizer: model analysis failed, using DSP analysis.', e);
      return analyzeDsp(samples, sampleRate, dspOpts);
    }
  }

  // ---- Web Worker client (main thread) ----------------------------------------------------------
  let worker = null, workerBroken = false, jobSeq = 0, workerBackend = null;
  const STALL_MS = 15000;   // a worker silent this long is stuck (e.g. a GPU driver that never returns)
  const jobs = new Map();
  function getWorker() {
    if (worker || workerBroken) return worker;
    try {
      if (typeof Worker === 'undefined' || (typeof location !== 'undefined' && location.protocol === 'file:')) { workerBroken = true; return null; }
      worker = new Worker(ENV.base + 'analysis-worker.js');
    } catch (e) { workerBroken = true; worker = null; return null; }
    worker.onmessage = (ev) => {
      const m = ev.data || {}, job = jobs.get(m.id);
      if (!job) return;
      if (m.type === 'stage') { job.started = true; job.last = Date.now(); job.onStage(m.stage, m.p); return; }
      jobs.delete(m.id); job.done();
      if (m.type === 'result') job.resolve(m.result);
      else if (m.type === 'error') job.reject(m.error && m.error.code ? new AnalysisError(m.error.code, m.error.message) : Object.assign(new Error((m.error && m.error.message) || 'Worker failed'), { workerFailed: true }));
    };
    worker.onerror = (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      workerBroken = true;
      try { worker.terminate(); } catch (e) { /* ignore */ }
      worker = null;
      for (const [id, job] of jobs) { jobs.delete(id); job.done(); job.reject(Object.assign(new Error('Analysis worker failed to start'), { workerFailed: true })); }
    };
    return worker;
  }
  function analyzeInWorker(w, samples, sampleRate, opts) {
    return new Promise((resolve, reject) => {
      const id = ++jobSeq, signal = opts.signal;
      const job = { resolve, reject, onStage: opts.onStage || (() => {}), started: false, last: Date.now(), done: () => clearInterval(dog) };
      // Watchdog: a worker that stops reporting progress is terminated, and the caller retries on the CPU.
      const dog = setInterval(() => {
        if (!jobs.has(id) || Date.now() - job.last < STALL_MS) return;
        jobs.delete(id); job.done();
        try { w.terminate(); } catch (e) { /* ignore */ }
        if (worker === w) worker = null;
        reject(Object.assign(new Error('Analysis worker stalled'), { stalled: true }));
      }, 1000);
      jobs.set(id, job);
      if (signal) {
        if (signal.aborted) { jobs.delete(id); job.done(); reject(cancelled()); return; }
        signal.addEventListener('abort', () => { if (jobs.has(id)) { jobs.delete(id); job.done(); w.postMessage({ type: 'cancel', id }); reject(cancelled()); } }, { once: true });
      }
      const copy = new Float32Array(samples), transfer = [copy.buffer];
      const wopts = { modelBudgetSec: opts.modelBudgetSec, partBudgetSec: opts.partBudgetSec, engine: opts.engine, backend: opts.backend || workerBackend || undefined };
      if (opts.parts) {
        const cp = (a) => { const c = new Float32Array(a); transfer.push(c.buffer); return c; };
        wopts.parts = { beat: opts.parts.beat ? cp(opts.parts.beat) : null, riff: (opts.parts.riff || []).map((x) => ({ id: x.id, samples: cp(x.samples) })) };
      }
      w.postMessage({ type: 'analyze', id, samples: copy, sampleRate, opts: wopts }, transfer);
    });
  }

  /* Public entry. samples: mono Float32Array. Resolves to
   * { duration, key, keyCandidates, keyConfidence, tempo:{bpm,confidence}, beats, downbeat, chords, sections,
   *   melody, riff, tuning:{a4,cents,confidence}, notes:[{start,end,midi,velocity}], engine, engineInfo }.
   * opts: { signal, onStage(stageId, fraction), engine: 'dsp' to force the DSP engine,
   *         modelBudgetSec (default 32), worker: false to stay on this thread,
   *         parts: separated instruments at the same rate as samples (then samples should be the
   *           harmonic instruments without drums/vocals): { beat: drums+bass, riff: [{id, samples}] },
   *         partBudgetSec (model time per riff part, default 24) }. */
  async function analyzeSong(samples, sampleRate, opts) {
    opts = opts || {};
    if (ENV.page && opts.worker !== false && opts.engine !== 'dsp') {
      const t0 = Date.now();
      // Stages only move forward, even when a stuck worker is replaced and the job starts again.
      const order = ['prepare', 'listen', 'key', 'tempo', 'chords', 'sections', 'riff', 'done'], user = opts.onStage;
      let at = -1, atP = 0;
      if (user) opts = Object.assign({}, opts, { onStage: (st, p) => { const i = order.indexOf(st); if (i > at || (i === at && p >= atP)) { at = Math.max(at, i); atP = p; user(st, p); } } });
      for (let attempt = 0; attempt < 2; attempt++) {
        const w = getWorker();
        if (!w) break;
        try {
          const o = attempt ? Object.assign({}, opts, { modelBudgetSec: Math.max(8, (opts.modelBudgetSec || 32) - (Date.now() - t0) / 1000) }) : opts;
          return await analyzeInWorker(w, samples, sampleRate, o);
        } catch (e) {
          if (e.stalled && !attempt) { workerBackend = 'cpu'; continue; }   // stuck on the GPU: use the CPU from now on
          if (e.stalled) workerBroken = true;
          if (!e.workerFailed && !e.stalled) throw e;
          break;
        }
      }
    }
    return analyzeLocal(samples, sampleRate, opts);
  }

  // ---- Demo songs (synthesised so the prototype works without any audio files) ---
  // Each part is 4 bars of scale-degree chords (0 = I/i); form lists the parts in order.
  const DEMO_SONGS = [
    { id: 'pop-g', title: 'Demo 1: Pop in G major', keyRoot: 7, scale: 'major', bpm: 100,
      parts: { A: [0, 4, 5, 3], B: [3, 4, 1, 4] }, form: ['A', 'A', 'B', 'A'],
      // Riff: [eighth-note step, semitones above the tonic, length in eighths], played in the A parts.
      riff: { bars: 2, parts: ['A'], notes: [[0, 0, 2], [2, 4, 1], [3, 7, 1], [4, 9, 2], [6, 7, 2], [8, 7, 1], [9, 4, 1], [10, 2, 2], [12, 4, 1], [13, 2, 1], [14, 0, 2]] } },
    { id: 'rock-am', title: 'Demo 2: Rock in A minor', keyRoot: 9, scale: 'minor', bpm: 120,
      parts: { A: [0, 5, 6, 0], B: [3, 3, 4, 4] }, form: ['A', 'A', 'B', 'B', 'A'],
      riff: { bars: 2, parts: ['A'], notes: [[0, 0, 1], [1, 3, 1], [2, 7, 1], [3, 3, 1], [4, 12, 2], [6, 10, 1], [7, 7, 1], [8, 8, 2], [10, 7, 1], [11, 5, 1], [12, 3, 2], [14, 2, 1], [15, 0, 1]] } },
    { id: 'ballad-eb', title: 'Demo 3: Ballad in E♭ major', keyRoot: 3, scale: 'major', bpm: 76,
      parts: { A: [0, 5, 3, 4] }, form: ['A', 'A', 'A'],
      style: { bass: 'roots' },
      riff: { bars: 2, parts: ['A'], notes: [[0, 0, 2], [2, 7, 2], [4, 4, 2], [6, 7, 2], [8, 9, 2], [10, 7, 2], [12, 4, 4]] } },
  ];
  const demoProgression = (song) => song.form.flatMap((p) => song.parts[p]);

  /* Synthesises a demo song as a small band, each instrument with its own timbre, register and
   * stereo position so that instrument separation can pull them apart:
   *   drums (kick, snare, hats, crash, fills) · bass (plucked, walking to the next chord) ·
   *   keys (electric-piano comping, 7ths in some bars) · guitar (plucked-string arpeggios) ·
   *   strings pad (B parts) · lead synth (the riff, with vibrato) or a soft melody elsewhere.
   * Deterministic. Returns { samples (mono), sampleRate, left, right }. */
  function renderDemoSong(song, sr) {
    sr = sr || 22050;
    const beat = 60 / song.bpm, barSec = beat * 4;
    const prog = demoProgression(song);
    const barPart = song.form.flatMap((p) => song.parts[p].map(() => p));
    const tonicMidi = 72 + mod12(song.keyRoot);
    const dur = prog.length * barSec + 1.5;
    const N = Math.floor(dur * sr);
    const L = new Float32Array(N), R = new Float32Array(N);
    const dia = Theory.diatonicChords(song.keyRoot, song.scale);
    const scalePcs = Theory.scalePitchClasses(song.keyRoot, song.scale);
    const style = song.style || {};
    const on = (k) => !(style.mute && style.mute.includes(k));   // style.mute: instruments to leave out
    let seed = 7;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    // Adds a mono signal at a pan position (-1 left … 1 right).
    const put = (s0, buf, pan) => {
      const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
      for (let i = 0; i < buf.length && s0 + i < N; i++) { if (s0 + i < 0) continue; L[s0 + i] += buf[i] * gl; R[s0 + i] += buf[i] * gr; }
    };
    const tone = (freq, t0, len, amp, harmonics, attack, release, pan, opts) => {
      opts = opts || {};
      const n = Math.floor((len + (opts.tail || 0)) * sr), buf = new Float32Array(n);
      const decay = opts.decay || 0, vib = opts.vib || 0;
      let ph = 0;   // phase accumulator, so vibrato bends the pitch without drifting
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let env = Math.min(1, t / attack) * (t > len - release ? Math.max(0, (len - t) / release) : 1);
        if (decay) env *= Math.exp(-t * decay);
        ph += 2 * Math.PI * freq * (vib ? 1 + vib * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.25) : 1) / sr;
        let v = 0;
        for (let h = 0; h < harmonics.length; h++) v += harmonics[h] * Math.sin(ph * (h + 1));
        buf[i] = amp * env * v;
      }
      put(Math.floor(t0 * sr), buf, pan || 0);
    };
    // Plucked string (Karplus–Strong): the guitar.
    const pluck = (midi, t0, len, amp, pan) => {
      const f = Theory.midiToFreq(midi), P = Math.max(2, Math.round(sr / f)), n = Math.floor(len * sr);
      const dl = new Float32Array(P), buf = new Float32Array(n);
      for (let i = 0; i < P; i++) dl[i] = rand() * 2 - 1;
      for (let pass = 0; pass < 3; pass++) for (let i = 1; i < P; i++) dl[i] = 0.5 * (dl[i] + dl[i - 1]);   // softer pick
      let j = 0;
      for (let i = 0; i < n; i++) {
        const nx = (j + 1) % P, v = dl[j];
        dl[j] = 0.497 * (v + dl[nx]);
        buf[i] = amp * v * Math.min(1, (n - i) / (0.03 * sr));
        j = nx;
      }
      put(Math.floor(t0 * sr), buf, pan);
    };
    const kick = (t0, amp) => {
      const n = Math.floor(0.22 * sr), buf = new Float32Array(n);
      for (let i = 0; i < n; i++) { const t = i / sr; buf[i] = amp * Math.exp(-t * 18) * Math.sin(2 * Math.PI * (48 + 110 * Math.exp(-t * 45)) * t); }
      put(Math.floor(t0 * sr), buf, 0);
    };
    const snare = (t0, amp) => {
      const n = Math.floor(0.18 * sr), buf = new Float32Array(n);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, w = rand() * 2 - 1, hp = w - prev; prev = w;   // brighter noise
        buf[i] = amp * (0.75 * hp * Math.exp(-t * 26) + 0.45 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 38));
      }
      put(Math.floor(t0 * sr), buf, 0.05);
    };
    const hat = (t0, amp, open, pan) => {
      const n = Math.floor((open ? 0.22 : 0.045) * sr), buf = new Float32Array(n);
      let p1 = 0, p2 = 0;
      for (let i = 0; i < n; i++) {
        const w = rand() * 2 - 1, h = w - 2 * p1 + p2; p2 = p1; p1 = w;   // second difference: hiss only
        buf[i] = amp * 0.5 * h * Math.exp(-i / sr * (open ? 14 : 75));
      }
      put(Math.floor(t0 * sr), buf, pan);
    };
    const crash = (t0, amp) => { hat(t0, amp * 1.6, true, -0.3); hat(t0 + 0.003, amp * 1.6, true, 0.3); };
    const harm = { bass: [1, 0.5, 0.15], keys: [1, 0.35, 0.12, 0.08, 0.05, 0.03], pad: [1, 0.4, 0.15, 0.08], lead: [1, 0.6, 0.42, 0.3, 0.22, 0.15, 0.1], mel: [1, 0.2, 0.05] };
    const near = (pc, around) => { let m = around - 6 + mod12(pc - (around - 6)); return m; };   // the pc's note closest above around-6
    for (let bar = 0; bar < prog.length; bar++) {
      const ch = dia[prog[bar]], next = dia[prog[(bar + 1) % prog.length]];
      const part = barPart[bar], t0 = bar * barSec;
      const big = part !== song.form[0] || style.allBig;           // B parts (and later choruses) get the bigger arrangement
      const lastOfPart = bar + 1 >= prog.length || barPart[bar + 1] !== part;
      const firstOfPart = bar === 0 || barPart[bar - 1] !== part;
      // Seventh on the V and ii chords: richer harmony that still clearly sits in the key.
      const seventh = (prog[bar] === 4 || prog[bar] === 1) ? mod12(ch.rootPc + (ch.quality === 'min' || prog[bar] === 4 ? 10 : 11)) : null;
      const pcs = seventh != null && big ? ch.pcs.concat([seventh]) : ch.pcs;

      // Drums.
      if (on('drums')) {
      if (firstOfPart) crash(t0, 0.04);
      for (let b = 0; b < 4; b++) {
        const tb = t0 + b * beat;
        if (b === 0 || b === 2) kick(tb, 0.55);
        if (big && b === 2) kick(tb + beat / 2, 0.35);
        if (b === 1 || b === 3) {
          if (!(lastOfPart && b === 3)) snare(tb, 0.16);
        }
        hat(tb, 0.035, false, 0.35);
        hat(tb + beat / 2, big && b === 3 ? 0.03 : 0.022, big && b === 3, 0.35);
      }
      if (lastOfPart) for (let k = 0; k < 4; k++) snare(t0 + 3 * beat + k * beat / 4, 0.08 + 0.03 * k);   // fill into the next part
      }

      // Bass: root, push on the "and" of 2, fifth on 3, and a step towards the next chord.
      const root = 36 + mod12(ch.rootPc);
      const fifth = root + 7, nextRoot = 36 + mod12(next.rootPc);
      const approach = nextRoot > root ? nextRoot - (scalePcs.includes(mod12(nextRoot - 2)) ? 2 : 1) : nextRoot + (scalePcs.includes(mod12(nextRoot + 2)) ? 2 : 1);
      const bassLine = style.bass === 'roots' ? [[0, root, 1.9], [2, root, 1.4], [3.5, approach, 0.45]]   // the ballad: held roots
        : [[0, root, 1.4], [1.5, root, 0.45], [2, fifth, 0.9], [3, root, 0.45], [3.5, approach, 0.45]];
      if (on('bass')) for (const [b, m, l] of bassLine) tone(Theory.midiToFreq(m), t0 + b * beat, l * beat, 0.14, harm.bass, 0.006, 0.05, -0.05, { decay: 2.2 });

      // Keys: chord voiced around E♭4, comping on 1, the "and" of 2 and 4.
      const voicing = pcs.map((pc) => near(pc, 63)).sort((a, b) => a - b);
      // Under the riff the keys and guitar play on the beats only, so they never land between riff notes.
      const riffHere = song.riff && song.riff.parts.includes(part);
      const comp = riffHere ? (bar % 3 === 2 ? [[0, 3.8, 0.05]] : [[0, 1.9, 0.05], [2, 1.9, 0.045]]) : [[0, 1.2, 0.055], [1.5, 0.9, 0.045], [3, 0.8, 0.045]];
      if (on('keys')) for (const [b, l, a] of comp) {
        voicing.forEach((m) => tone(Theory.midiToFreq(m), t0 + b * beat, l * beat, a, harm.keys, 0.004, 0.08, -0.45, { decay: 1.6, tail: 0.15 }));
      }

      // Guitar: an arpeggio of the chord in 8ths, an octave below the keys, panned right.
      const gtr = ch.pcs.map((pc) => near(pc, 57)).sort((a, b) => a - b);
      // The picking pattern changes bar to bar (a 3-bar cycle against the 4-bar progression), like a player would.
      const pattern = [[0, 1, 2, 1, 0, 2, 1, 2], [0, 2, 1, 2, 2, 1, 0, 1], [2, 1, 0, 1, 0, 1, 2, 1]][(bar * 2) % 3];
      if (on('guitar')) pattern.forEach((k, i) => { if (!riffHere || i % 2 === 0) pluck(gtr[k % gtr.length], t0 + i * beat / 2, beat * (riffHere ? 1.8 : 0.9), riffHere ? 0.1 : 0.12, 0.55); });

      // Strings pad: chord tones just below middle C, held for the bar; fuller in the bigger parts.
      if (on('pad')) ch.pcs.forEach((pc) => tone(Theory.midiToFreq(55 + mod12(pc - 7)), t0, barSec, big ? 0.06 : 0.05, harm.pad, 0.35, 0.3, 0.15, { vib: 0.003 }));

      // Riff in its parts: bright lead synth in the middle. Elsewhere a soft melody on odd bars.
      const riff = song.riff;
      if (!on('lead')) { /* left out */ } else if (riff && riff.parts.includes(part)) {
        const barInRiff = bar % riff.bars;
        for (const [st, semi, len] of riff.notes) {
          if (Math.floor(st / 8) !== barInRiff) continue;
          tone(Theory.midiToFreq(tonicMidi + semi), t0 + (st % 8) * beat / 2, len * beat / 2 * 0.92, 0.12, harm.lead, 0.008, 0.05, 0.1, { vib: 0.004 });
        }
      } else if (bar % 2 === 1) {
        const notes = Theory.suggestPhrase({ scalePcs, chordPcs: ch.pcs, lowMidi: 72, highMidi: 86, length: 6, seed: bar + 3 });
        notes.forEach((m, i) => tone(Theory.midiToFreq(m), t0 + i * beat / 2, beat / 2 * 0.95, 0.07, harm.mel, 0.01, 0.06, -0.15));
      }
    }
    // Normalise.
    let peak = 0;
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const g = peak > 0 ? 0.8 / peak : 1;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; out[i] = (L[i] + R[i]) / 2; }
    return { samples: out, sampleRate: sr, left: L, right: R };
  }

  const Analysis = { analyzeSong, analyzeLocal, analyzeDsp, renderDemoSong, demoProgression, transcribeMelody, findRiff, DEMO_SONGS, AnalysisError, fft, estimateTempo,
    detectTuning, resample, decodeNotes, findRiffFromNotes, trackBeats, onsetEnvelope, getModel, ENV, BP };
  if (typeof module !== 'undefined' && module.exports) module.exports = Analysis;
  else root.Analysis = Analysis;
})(typeof window !== 'undefined' ? window : globalThis);
