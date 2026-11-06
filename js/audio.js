/* Sound engine: a small Web Audio synthesiser with instrument presets (the "VST" part). */
(function (root) {
  'use strict';

  const PRESETS = {
    piano: {
      name: 'Grand Piano',
      // Bright attack that decays to a softer tone, like a struck string.
      build(ctx, freq, vel, out) {
        const g = ctx.createGain();
        const partials = [[1, 1], [2, 0.5], [3, 0.25], [4, 0.12], [5, 0.06]];
        const oscs = partials.map(([h, a]) => {
          const o = ctx.createOscillator();
          o.frequency.value = freq * h * (1 + 0.0004 * h * h); // slight inharmonicity
          const pg = ctx.createGain();
          pg.gain.value = a;
          o.connect(pg).connect(g);
          return o;
        });
        const t = ctx.currentTime, peak = 0.35 * vel;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.005);
        g.gain.exponentialRampToValueAtTime(peak * 0.25, t + 1.2);
        g.gain.exponentialRampToValueAtTime(0.0008, t + 6);
        g.connect(out);
        return { nodes: oscs, gain: g, release: 0.35, peak };
      },
    },
    epiano: {
      name: 'Electric Piano',
      build(ctx, freq, vel, out) {
        const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain();
        car.frequency.value = freq; mod.frequency.value = freq * 14;
        const t = ctx.currentTime;
        mg.gain.setValueAtTime(freq * 1.5 * vel, t);
        mg.gain.exponentialRampToValueAtTime(1, t + 0.4);
        mod.connect(mg).connect(car.frequency);
        car.connect(g);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.4 * vel, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.001, t + 4);
        g.connect(out);
        return { nodes: [car, mod], gain: g, release: 0.25, peak: 0.4 * vel };
      },
    },
    synth: {
      name: 'Synth Lead',
      build(ctx, freq, vel, out) {
        const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o1.type = 'sawtooth'; o2.type = 'square';
        o1.frequency.value = freq; o2.frequency.value = freq; o2.detune.value = 7;
        const t = ctx.currentTime;
        f.type = 'lowpass'; f.Q.value = 6;
        f.frequency.setValueAtTime(400, t);
        f.frequency.exponentialRampToValueAtTime(2500 + 3000 * vel, t + 0.08);
        f.frequency.exponentialRampToValueAtTime(1400, t + 0.6);
        o1.connect(f); o2.connect(f); f.connect(g);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.01);
        g.gain.linearRampToValueAtTime(0.12 * vel, t + 0.3);
        g.connect(out);
        return { nodes: [o1, o2], gain: g, release: 0.2, peak: 0.16 * vel };
      },
    },
    strings: {
      name: 'Strings',
      build(ctx, freq, vel, out) {
        const f = ctx.createBiquadFilter(), g = ctx.createGain();
        f.type = 'lowpass'; f.frequency.value = 2200;
        const oscs = [-9, 0, 8].map((d) => {
          const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = d; o.connect(f); return o;
        });
        // Gentle vibrato.
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = 5.2; lg.gain.value = 6;
        lfo.connect(lg); oscs.forEach((o) => lg.connect(o.detune));
        f.connect(g);
        const t = ctx.currentTime;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.09 * vel, t + 0.35);
        g.connect(out);
        return { nodes: oscs.concat([lfo]), gain: g, release: 0.8, peak: 0.09 * vel };
      },
    },
    organ: {
      name: 'Organ',
      build(ctx, freq, vel, out) {
        const g = ctx.createGain();
        const oscs = [[0.5, 0.5], [1, 1], [2, 0.6], [3, 0.3], [4, 0.25]].map(([h, a]) => {
          const o = ctx.createOscillator(); o.frequency.value = freq * h;
          const pg = ctx.createGain(); pg.gain.value = a; o.connect(pg).connect(g); return o;
        });
        const t = ctx.currentTime;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.1 * (0.6 + 0.4 * vel), t + 0.02);
        g.connect(out);
        return { nodes: oscs, gain: g, release: 0.08, peak: 0.1 };
      },
    },
    pluck: {
      name: 'Pluck',
      build(ctx, freq, vel, out) {
        const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.value = freq;
        const t = ctx.currentTime;
        f.type = 'lowpass';
        f.frequency.setValueAtTime(5000, t);
        f.frequency.exponentialRampToValueAtTime(300, t + 0.5);
        o.connect(f).connect(g);
        g.gain.setValueAtTime(0.4 * vel, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
        g.connect(out);
        return { nodes: [o], gain: g, release: 0.1, peak: 0.4 * vel };
      },
    },
  };

  // ---- More instruments. Small helpers shared by the presets below. ----
  const osc = (ctx, type, freq, detune) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; if (detune) o.detune.value = detune; return o; };
  // Attack to peak, then decay towards a sustain level (0 = die away over `d` seconds).
  function adsr(g, t, a, peak, d, sus) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    if (sus > 0) g.gain.setTargetAtTime(peak * sus, t + a, d / 3);
    else g.gain.exponentialRampToValueAtTime(0.0008, t + a + d);
  }
  const vibrato = (ctx, rate, cents, oscs, delay) => {
    const l = osc(ctx, 'sine', rate), lg = ctx.createGain(), t = ctx.currentTime;
    lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(cents, t + (delay || 0.3));
    l.connect(lg); oscs.forEach((o) => lg.connect(o.detune)); return l;
  };
  // Plucked strings: Karplus-Strong rendered once per note and cached (a feedback delay in Web Audio
  // can't go short enough for high notes).
  const ksCache = new Map();
  function ksBuffer(ctx, freq, opts) {
    const key = [ctx.sampleRate, Math.round(freq * 10), opts.id].join(':');
    if (ksCache.has(key)) return ksCache.get(key);
    const sr = ctx.sampleRate, len = Math.floor(sr * opts.dur), buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    const N = Math.max(2, Math.round(sr / freq)), line = new Float32Array(N);
    let prev = 0;
    for (let i = 0; i < N; i++) { const r = Math.random() * 2 - 1; prev = prev + opts.bright * (r - prev); line[i] = prev; }   // smoothed noise burst
    const damp = Math.pow(0.001, 1 / (opts.decay * freq));   // loses 60 dB over opts.decay seconds
    let idx = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const cur = line[idx], next = line[(idx + 1) % N];
      const v = damp * (opts.blend * cur + (1 - opts.blend) * next);
      d[i] = cur; line[idx] = v; idx = (idx + 1) % N;
      if (opts.twang) { d[i] += opts.twang * (cur - last); last = cur; }
    }
    ksCache.set(key, buf);
    if (ksCache.size > 400) ksCache.delete(ksCache.keys().next().value);
    return buf;
  }
  function pluck(ctx, freq, vel, out, o) {
    const src = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    src.buffer = ksBuffer(ctx, freq, o);
    f.type = 'lowpass'; f.frequency.value = o.tone || 6000;
    let tail = f;
    if (o.drive) {
      const ws = ctx.createWaveShaper(), curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(o.drive * x) / Math.tanh(o.drive); }
      ws.curve = curve; ws.oversample = '2x'; f.connect(ws); tail = ws;
    }
    src.connect(f); tail.connect(g);
    const peak = (o.gain || 0.5) * vel;
    g.gain.value = peak;
    g.connect(out);
    return { nodes: [src], gain: g, release: o.release || 0.12, peak };
  }
  // A buzzy source through formant-like band-pass filters (voices, reeds).
  function formants(ctx, src, list, out) {
    list.forEach(([f, q, a]) => { const b = ctx.createBiquadFilter(), bg = ctx.createGain(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q; bg.gain.value = a; src.connect(b).connect(bg).connect(out); });
  }
  const noiseBuf = (ctx) => {
    if (ctx.__mtNoise) return ctx.__mtNoise;
    const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return (ctx.__mtNoise = b);
  };

  Object.assign(PRESETS, {
    harpsichord: { name: 'Harpsichord', group: 'Keys', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'hpsd', dur: 3, decay: 2.2, bright: 0.9, blend: 0.5, twang: 0.6, tone: 7000, gain: 0.32, release: 0.15 });
    } },
    clav: { name: 'Clavinet', group: 'Keys', build(ctx, freq, vel, out) {
      const o = osc(ctx, 'square', freq), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
      f.type = 'bandpass'; f.Q.value = 2.5; f.frequency.setValueAtTime(freq * 6, t); f.frequency.exponentialRampToValueAtTime(freq * 2.5, t + 0.25);
      o.connect(f).connect(g); adsr(g, t, 0.003, 0.3 * vel, 1.4, 0); g.connect(out);
      return { nodes: [o], gain: g, release: 0.06, peak: 0.3 * vel };
    } },
    vibes: { name: 'Vibraphone', group: 'Mallets & bells', build(ctx, freq, vel, out) {
      const g = ctx.createGain(), t = ctx.currentTime, trem = ctx.createGain(), lfo = osc(ctx, 'sine', 5.5), lg = ctx.createGain();
      const oscs = [[1, 1], [4, 0.25], [10, 0.05]].map(([h, a]) => { const o = osc(ctx, 'sine', freq * h), pg = ctx.createGain(); pg.gain.value = a; o.connect(pg).connect(trem); return o; });
      lg.gain.value = 0.25; lfo.connect(lg).connect(trem.gain); trem.gain.value = 0.75; trem.connect(g);
      adsr(g, t, 0.004, 0.3 * vel, 4, 0); g.connect(out);
      return { nodes: oscs.concat([lfo]), gain: g, release: 0.6, peak: 0.3 * vel };
    } },
    marimba: { name: 'Marimba', group: 'Mallets & bells', build(ctx, freq, vel, out) {
      const g = ctx.createGain(), t = ctx.currentTime;
      const oscs = [[1, 1], [4, 0.35 * vel], [9.9, 0.08 * vel]].map(([h, a], i) => { const o = osc(ctx, 'sine', freq * h), pg = ctx.createGain(); pg.gain.setValueAtTime(a, t); pg.gain.exponentialRampToValueAtTime(0.001, t + (i ? 0.12 : 1.1)); o.connect(pg).connect(g); return o; });
      adsr(g, t, 0.002, 0.4 * vel, 1.1, 0); g.connect(out);
      return { nodes: oscs, gain: g, release: 0.15, peak: 0.4 * vel };
    } },
    bells: { name: 'Glockenspiel', group: 'Mallets & bells', build(ctx, freq, vel, out) {
      const g = ctx.createGain(), t = ctx.currentTime;
      const oscs = [[2, 1], [5.4, 0.4], [8.9, 0.2]].map(([h, a]) => { const o = osc(ctx, 'sine', freq * h), pg = ctx.createGain(); pg.gain.value = a; o.connect(pg).connect(g); return o; });
      adsr(g, t, 0.002, 0.18 * vel, 2.5, 0); g.connect(out);
      return { nodes: oscs, gain: g, release: 0.8, peak: 0.18 * vel };
    } },
    fmbell: { name: 'FM Bell', group: 'Mallets & bells', build(ctx, freq, vel, out) {
      const car = osc(ctx, 'sine', freq), mod = osc(ctx, 'sine', freq * 3.5), mg = ctx.createGain(), g = ctx.createGain(), t = ctx.currentTime;
      mg.gain.setValueAtTime(freq * 4 * vel, t); mg.gain.exponentialRampToValueAtTime(freq * 0.2, t + 2.5);
      mod.connect(mg).connect(car.frequency); car.connect(g); adsr(g, t, 0.003, 0.25 * vel, 3.5, 0); g.connect(out);
      return { nodes: [car, mod], gain: g, release: 0.9, peak: 0.25 * vel };
    } },
    acoustic: { name: 'Acoustic Guitar', group: 'Guitar & plucked', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'ac', dur: 4, decay: 3, bright: 0.55 + 0.35 * vel, blend: 0.5, tone: 5000, gain: 0.55 });
    } },
    nylon: { name: 'Nylon Guitar', group: 'Guitar & plucked', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'ny', dur: 4, decay: 2.4, bright: 0.3, blend: 0.5, tone: 2800, gain: 0.6 });
    } },
    eguitar: { name: 'Electric Guitar', group: 'Guitar & plucked', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'eg', dur: 5, decay: 4.5, bright: 0.7, blend: 0.52, tone: 4200, drive: 1.6, gain: 0.35, release: 0.1 });
    } },
    overdrive: { name: 'Overdrive Guitar', group: 'Guitar & plucked', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'od', dur: 5, decay: 6, bright: 0.8, blend: 0.52, tone: 3200, drive: 8, gain: 0.16, release: 0.1 });
    } },
    banjo: { name: 'Banjo', group: 'Guitar & plucked', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'bj', dur: 2, decay: 1.1, bright: 0.95, blend: 0.5, twang: 0.4, tone: 8000, gain: 0.45 });
    } },
    harp: { name: 'Harp', group: 'Guitar & plucked', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'hp', dur: 5, decay: 4, bright: 0.25, blend: 0.5, tone: 3500, gain: 0.55, release: 0.6 });
    } },
    sitar: { name: 'Sitar', group: 'Guitar & plucked', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'st', dur: 4, decay: 3.5, bright: 0.9, blend: 0.5, twang: 1.2, tone: 6000, drive: 2.5, gain: 0.3 });
    } },
    bass: { name: 'Bass Guitar', group: 'Bass', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'bs', dur: 4, decay: 3, bright: 0.35, blend: 0.5, tone: 1400, drive: 1.3, gain: 0.8, release: 0.08 });
    } },
    synthbass: { name: 'Synth Bass', group: 'Bass', build(ctx, freq, vel, out) {
      const o1 = osc(ctx, 'sawtooth', freq), o2 = osc(ctx, 'square', freq / 2), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
      f.type = 'lowpass'; f.Q.value = 8; f.frequency.setValueAtTime(200, t); f.frequency.exponentialRampToValueAtTime(600 + 1800 * vel, t + 0.02); f.frequency.exponentialRampToValueAtTime(300, t + 0.4);
      o1.connect(f); o2.connect(f); f.connect(g); adsr(g, t, 0.005, 0.22 * vel, 0.5, 0.6); g.connect(out);
      return { nodes: [o1, o2], gain: g, release: 0.08, peak: 0.22 * vel };
    } },
    upright: { name: 'Upright Bass', group: 'Bass', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'ub', dur: 3, decay: 1.6, bright: 0.2, blend: 0.5, tone: 900, gain: 0.95, release: 0.1 });
    } },
    pizz: { name: 'Pizzicato Strings', group: 'Strings & orchestra', build(ctx, freq, vel, out) {
      return pluck(ctx, freq, vel, out, { id: 'pz', dur: 1.5, decay: 0.6, bright: 0.4, blend: 0.5, tone: 3000, gain: 0.55 });
    } },
    cello: { name: 'Cello', group: 'Strings & orchestra', build(ctx, freq, vel, out) {
      const o = osc(ctx, 'sawtooth', freq), g = ctx.createGain(), mix = ctx.createGain(), t = ctx.currentTime;
      const v = vibrato(ctx, 5, 12, [o], 0.4);
      o.connect(mix); formants(ctx, mix, [[300, 1.5, 1], [900, 2, 0.6], [2200, 3, 0.25]], g);
      adsr(g, t, 0.12, 0.35 * vel, 0.6, 0.8); g.connect(out);
      return { nodes: [o, v], gain: g, release: 0.35, peak: 0.35 * vel };
    } },
    brass: { name: 'Brass Section', group: 'Brass & winds', build(ctx, freq, vel, out) {
      const os = [-6, 0, 5].map((d) => osc(ctx, 'sawtooth', freq, d)), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
      f.type = 'lowpass'; f.Q.value = 1.5; f.frequency.setValueAtTime(freq * 1.5, t); f.frequency.linearRampToValueAtTime(freq * (4 + 5 * vel), t + 0.08); f.frequency.setTargetAtTime(freq * 3.5, t + 0.1, 0.3);
      os.forEach((o) => o.connect(f)); f.connect(g); adsr(g, t, 0.05, 0.12 * vel, 0.4, 0.85); g.connect(out);
      return { nodes: os, gain: g, release: 0.12, peak: 0.12 * vel };
    } },
    trumpet: { name: 'Trumpet', group: 'Brass & winds', build(ctx, freq, vel, out) {
      const o = osc(ctx, 'sawtooth', freq), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
      const v = vibrato(ctx, 5.5, 10, [o], 0.4);
      f.type = 'lowpass'; f.Q.value = 3; f.frequency.setValueAtTime(freq * 2, t); f.frequency.linearRampToValueAtTime(freq * (5 + 4 * vel), t + 0.05);
      o.connect(f).connect(g); adsr(g, t, 0.03, 0.2 * vel, 0.3, 0.85); g.connect(out);
      return { nodes: [o, v], gain: g, release: 0.1, peak: 0.2 * vel };
    } },
    sax: { name: 'Saxophone', group: 'Brass & winds', build(ctx, freq, vel, out) {
      const o1 = osc(ctx, 'sawtooth', freq), o2 = osc(ctx, 'square', freq, 4), mix = ctx.createGain(), g = ctx.createGain(), t = ctx.currentTime;
      const v = vibrato(ctx, 5, 14, [o1, o2], 0.35);
      o1.connect(mix); o2.connect(mix); mix.gain.value = 0.6;
      formants(ctx, mix, [[500, 2, 1], [1500, 4, 0.7], [2800, 5, 0.3]], g);
      adsr(g, t, 0.04, 0.4 * vel, 0.4, 0.8); g.connect(out);
      return { nodes: [o1, o2, v], gain: g, release: 0.1, peak: 0.4 * vel };
    } },
    flute: { name: 'Flute', group: 'Brass & winds', build(ctx, freq, vel, out) {
      const o = osc(ctx, 'sine', freq), o2 = osc(ctx, 'sine', freq * 2), n = ctx.createBufferSource(), nf = ctx.createBiquadFilter(), ng = ctx.createGain(), g = ctx.createGain(), h = ctx.createGain(), t = ctx.currentTime;
      const v = vibrato(ctx, 5, 8, [o, o2], 0.4);
      n.buffer = noiseBuf(ctx); n.loop = true; nf.type = 'bandpass'; nf.frequency.value = freq * 2; nf.Q.value = 3; ng.gain.value = 0.12;
      h.gain.value = 0.15; o2.connect(h).connect(g); o.connect(g); n.connect(nf).connect(ng).connect(g);
      adsr(g, t, 0.08, 0.3 * vel, 0.3, 0.85); g.connect(out);
      return { nodes: [o, o2, n, v], gain: g, release: 0.12, peak: 0.3 * vel };
    } },
    clarinet: { name: 'Clarinet', group: 'Brass & winds', build(ctx, freq, vel, out) {
      const o = osc(ctx, 'square', freq), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
      f.type = 'lowpass'; f.frequency.value = Math.min(8000, freq * 5); f.Q.value = 0.7;
      o.connect(f).connect(g); adsr(g, t, 0.05, 0.18 * vel, 0.3, 0.85); g.connect(out);
      return { nodes: [o], gain: g, release: 0.08, peak: 0.18 * vel };
    } },
    accordion: { name: 'Accordion', group: 'Brass & winds', build(ctx, freq, vel, out) {
      const os = [-8, 8].map((d) => osc(ctx, 'sawtooth', freq, d)), mix = ctx.createGain(), g = ctx.createGain(), t = ctx.currentTime;
      os.forEach((o) => o.connect(mix)); mix.gain.value = 0.5;
      formants(ctx, mix, [[700, 1.5, 1], [1800, 3, 0.5]], g);
      adsr(g, t, 0.04, 0.35 * vel, 0.3, 0.9); g.connect(out);
      return { nodes: os, gain: g, release: 0.08, peak: 0.35 * vel };
    } },
    harmonica: { name: 'Harmonica', group: 'Brass & winds', build(ctx, freq, vel, out) {
      const o = osc(ctx, 'square', freq), mix = ctx.createGain(), g = ctx.createGain(), t = ctx.currentTime;
      const v = vibrato(ctx, 6, 10, [o], 0.5);
      o.connect(mix); formants(ctx, mix, [[1000, 2, 1], [2500, 3, 0.4]], g);
      adsr(g, t, 0.05, 0.45 * vel, 0.3, 0.85); g.connect(out);
      return { nodes: [o, v], gain: g, release: 0.08, peak: 0.45 * vel };
    } },
    choir: { name: 'Choir "Aah"', group: 'Voices & synths', build(ctx, freq, vel, out) {
      const os = [-10, 0, 9].map((d) => osc(ctx, 'sawtooth', freq, d)), mix = ctx.createGain(), g = ctx.createGain(), t = ctx.currentTime;
      const v = vibrato(ctx, 5, 9, os, 0.5);
      os.forEach((o) => o.connect(mix)); mix.gain.value = 0.4;
      formants(ctx, mix, [[730, 6, 1], [1090, 8, 0.5], [2440, 10, 0.25]], g);
      adsr(g, t, 0.3, 0.5 * vel, 0.5, 0.9); g.connect(out);
      return { nodes: os.concat([v]), gain: g, release: 0.5, peak: 0.5 * vel };
    } },
    pad: { name: 'Synth Pad', group: 'Voices & synths', build(ctx, freq, vel, out) {
      const os = [-12, -4, 4, 12].map((d) => osc(ctx, 'sawtooth', freq, d)), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
      f.type = 'lowpass'; f.frequency.setValueAtTime(400, t); f.frequency.linearRampToValueAtTime(1800, t + 1.2);
      os.forEach((o) => o.connect(f)); f.connect(g); adsr(g, t, 0.6, 0.07 * vel, 1, 0.9); g.connect(out);
      return { nodes: os, gain: g, release: 1.2, peak: 0.07 * vel };
    } },
    square: { name: 'Square Lead', group: 'Voices & synths', build(ctx, freq, vel, out) {
      const o = osc(ctx, 'square', freq), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
      f.type = 'lowpass'; f.frequency.value = 3500;
      o.connect(f).connect(g); adsr(g, t, 0.005, 0.12 * vel, 0.2, 0.8); g.connect(out);
      return { nodes: [o], gain: g, release: 0.06, peak: 0.12 * vel };
    } },
  });
  // Groups for the Instrument menu; the original six keep their places.
  Object.assign(PRESETS.piano, { group: 'Keys' }); Object.assign(PRESETS.epiano, { group: 'Keys' }); Object.assign(PRESETS.organ, { group: 'Keys' });
  Object.assign(PRESETS.synth, { group: 'Voices & synths' }); Object.assign(PRESETS.strings, { group: 'Strings & orchestra' }); Object.assign(PRESETS.pluck, { group: 'Voices & synths', name: 'Pluck Synth' });
  const GROUPS = ['Keys', 'Guitar & plucked', 'Bass', 'Strings & orchestra', 'Brass & winds', 'Mallets & bells', 'Voices & synths'];

  // The keyboard sound that best matches each instrument the AI helper can separate (Jam › Instruments).
  const INSTRUMENT_PRESET = {
    guitar: 'eguitar', 'guitar-rest': 'eguitar', 'electric-guitar': 'eguitar', 'acoustic-guitar': 'acoustic', 'slide-guitar': 'eguitar', banjo: 'banjo', mandolin: 'banjo', ukulele: 'nylon', sitar: 'sitar',
    piano: 'piano', 'piano-rest': 'piano', 'electric-piano': 'epiano', harpsichord: 'harpsichord', organ: 'organ', synth: 'synth', strings: 'strings', brass: 'brass',
    saxophone: 'sax', flute: 'flute', clarinet: 'clarinet', woodwinds: 'flute', harp: 'harp', mallets: 'marimba', bells: 'bells', accordion: 'accordion', harmonica: 'harmonica',
    bagpipes: 'accordion', theremin: 'square', bass: 'bass', 'double-bass': 'upright', vocals: 'choir', choir: 'choir', other: 'synth', 'other-rest': 'synth',
  };

  class SoundEngine {
    constructor() {
      this.ctx = null;
      this.preset = 'piano';
      this.override = null;
      this.voices = new Map();
      this.volume = 0.8;
      this.reverbMix = 0.2;
      this.trackVolume = 0.7;
      this.bend = 0; this.mod = 0; this.bendRange = 2;
      // Audio device options (Settings › Audio input). sampleRate null = the device's own rate.
      this.sampleRate = null;
      this.latency = 'interactive';
      this.onReconfigure = null;
    }

    static latencyHint(id) { return id === 'lowest' ? 0 : id === 'safe' ? 'playback' : 'interactive'; }

    // Browsers only allow audio after a user gesture, so the context is created lazily.
    ensure() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
      const Ctx = root.AudioContext || root.webkitAudioContext;
      if (!Ctx) throw new Error('This browser does not support Web Audio.');
      const opts = { latencyHint: SoundEngine.latencyHint(this.latency) };
      if (this.sampleRate) opts.sampleRate = this.sampleRate;
      let ctx;
      try { ctx = new Ctx(opts); } catch (e) { ctx = new Ctx(); } // rate not supported by this device
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(ctx.destination);
      this.dry = ctx.createGain();
      this.wet = ctx.createGain();
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this._impulse(2.2);
      this.dry.connect(this.master);
      this.wet.connect(this.reverb).connect(this.master);
      this.bus = ctx.createGain();
      this.bus.connect(this.dry); this.bus.connect(this.wet);
      this.setReverb(this.reverbMix);
      // Separate channel for the backing track so it can be mixed against the keyboard.
      this.trackGain = ctx.createGain();
      this.trackGain.gain.value = this.trackVolume;
      this.trackGain.connect(this.master);
      // Performance controls shared by every voice: pitch bend and modulation (vibrato), both in cents on each oscillator's detune.
      this.bendSrc = ctx.createConstantSource(); this.bendSrc.offset.value = this.bend * this.bendRange * 100; this.bendSrc.start();
      this.vib = ctx.createOscillator(); this.vib.frequency.value = 5.6;
      this.vibDepth = ctx.createGain(); this.vibDepth.gain.value = this.mod * 45;
      this.vib.connect(this.vibDepth); this.vib.start();
      return ctx;
    }

    // bend: -1..1 (±bendRange semitones). mod: 0..1 (vibrato depth).
    setBend(v) {
      this.bend = Math.max(-1, Math.min(1, v));
      if (this.bendSrc) this.bendSrc.offset.setTargetAtTime(this.bend * this.bendRange * 100, this.ctx.currentTime, 0.015);
    }
    setMod(v) {
      this.mod = Math.max(0, Math.min(1, v));
      if (this.vibDepth) this.vibDepth.gain.setTargetAtTime(this.mod * 45, this.ctx.currentTime, 0.03);
    }
    _wire(v) {
      // Audio-rate oscillators follow the wheels; slow LFOs inside a preset are left alone.
      v.nodes.forEach((n) => {
        if (n.detune && (n.frequency ? n.frequency.value >= 20 : n.buffer && !n.loop)) { this.bendSrc.connect(n.detune); this.vibDepth.connect(n.detune); }
      });
    }

    _impulse(sec) {
      const ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec), buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      return buf;
    }

    // New sample rate or latency: rebuild the audio context. Anything holding nodes (the song
    // player, the guitar rig) is told through onReconfigure so it can reconnect.
    async reconfigure({ sampleRate, latency }) {
      if (sampleRate !== undefined) this.sampleRate = sampleRate || null;
      if (latency) this.latency = latency;
      if (!this.ctx) return null;
      const old = this.ctx;
      this.voices.clear();
      this.ctx = null;
      try { await old.close(); } catch (e) { /* already closed */ }
      const ctx = this.ensure();
      if (this.onReconfigure) this.onReconfigure(ctx);
      return ctx;
    }

    // What the audio output actually runs at, for the interface check.
    info() {
      const c = this.ctx;
      if (!c) return null;
      return { sampleRate: c.sampleRate, baseLatency: c.baseLatency || 0, outputLatency: c.outputLatency || 0 };
    }

    setPreset(id) { if (PRESETS[id]) this.preset = id; }
    setOverride(id) { this.override = PRESETS[id] ? id : null; }
    setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
    setReverb(v) { this.reverbMix = v; if (this.wet) { this.wet.gain.value = v; this.dry.gain.value = 1 - v * 0.5; } }
    setTrackVolume(v) { this.trackVolume = v; if (this.trackGain) this.trackGain.gain.value = v; }

    /* preset: play this one note with another sound (coach examples, riff previews); otherwise the
     * temporary override (Riff Mode matching a separated instrument) or the chosen preset. */
    noteOn(midi, velocity, preset) {
      const ctx = this.ensure();
      this.noteOff(midi, true);
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const id = PRESETS[preset] ? preset : PRESETS[this.override] ? this.override : this.preset;
      const v = PRESETS[id].build(ctx, freq, velocity == null ? 0.8 : velocity, this.bus);
      v.born = ctx.currentTime;
      this._wire(v);
      v.nodes.forEach((n) => n.start());
      this.voices.set(midi, v);
    }

    noteOff(midi, fast) {
      const v = this.voices.get(midi);
      if (!v) return;
      this.voices.delete(midi);
      const now = this.ctx.currentTime, rel = fast ? 0.02 : v.release;
      // A very quick tap still gets a short note instead of a click.
      const t = fast ? now : Math.max(now, v.born + 0.08);
      // Hold the envelope where it is at that moment. Reading gain.value is not safe for this: right
      // after noteOn (a quick tap or click) it still reports the default 1.0, which made short notes blast.
      const gp = v.gain.gain;
      if (gp.cancelAndHoldAtTime) gp.cancelAndHoldAtTime(t);
      else { gp.cancelScheduledValues(t); gp.setValueAtTime(Math.max(Math.min(t > now ? v.peak : gp.value, v.peak || 0.4), 0.0001), t); }
      gp.exponentialRampToValueAtTime(0.0001, t + rel);
      v.nodes.forEach((n) => n.stop(t + rel + 0.05));
    }

    allOff() { for (const m of Array.from(this.voices.keys())) this.noteOff(m, true); }

    // Preview a sequence of notes (used for "hear the scale" and suggested phrases).
    playSequence(midis, stepSec) {
      stepSec = stepSec || 0.3;
      midis.forEach((m, i) => {
        setTimeout(() => this.noteOn(m, 0.7), i * stepSec * 1000);
        setTimeout(() => this.noteOff(m), (i + 0.9) * stepSec * 1000);
      });
    }

    async decode(arrayBuffer) {
      const ctx = this.ensure();
      return await ctx.decodeAudioData(arrayBuffer);
    }

    // samples: one Float32Array (mono) or an array of channels.
    bufferFromSamples(samples, sampleRate) {
      const ctx = this.ensure();
      const chans = Array.isArray(samples) ? samples : [samples];
      const buf = ctx.createBuffer(chans.length, chans[0].length, sampleRate);
      chans.forEach((c, i) => buf.getChannelData(i).set(c));
      return buf;
    }
  }

  // Simple transport for the backing track, with position tracking for the guided overlay.
  /* The Jam Mode song. Tempo changes keep the pitch: the sources play faster or slower and the
   * SoundTouch time-stretcher (js/vendor/soundtouch-processor.js, an AudioWorklet) shifts the pitch
   * back. Without AudioWorklet it falls back to plain speed changes (the pitch moves too).
   * After instrument separation the stems play in sync instead of the mix, each with its own gain. */
  const STRETCH_URL = 'js/vendor/soundtouch-processor.js';
  class TrackPlayer {
    constructor(engine) {
      this.engine = engine; this.buffer = null; this.srcs = []; this.offset = 0; this.startedAt = 0; this.playing = false; this.onEnded = null; this.rate = 1;
      this.stems = null; this.useStems = false; this.bus = null; this.stretch = null; this.stretchState = 'idle'; this.latency = 0;
    }
    load(buffer) { this.stop(); this.buffer = buffer; this.offset = 0; this.setStems(null); }
    get duration() { return this.buffer ? this.buffer.duration : 0; }
    get position() { return this.playing ? Math.max(0, Math.min(this.duration, this.offset + (this.engine.ctx.currentTime - this.startedAt) * this.rate)) : this.offset; }
    // Song time the listener hears right now (the time-stretcher delays the sound a little).
    get heard() { return this.playing ? Math.max(0, this.position - this._delay() * this.rate) : this.offset; }
    _delay() { return this.rate !== 1 && this.stretch ? this.latency : 0; }
    // Loads the time-stretcher once. Resolves true when it can be used.
    prepare() {
      if (this.stretchState === 'ready') return Promise.resolve(true);
      if (this.stretchState === 'failed') return Promise.resolve(false);
      if (this._loading) return this._loading;
      const ctx = this.engine.ensure();
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') { this.stretchState = 'failed'; return Promise.resolve(false); }
      this.stretchState = 'loading';
      this._loading = ctx.audioWorklet.addModule(STRETCH_URL).then(() => {
        this.stretch = new AudioWorkletNode(ctx, 'soundtouch-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { sampleBufferType: 'circular' } });
        this.stretch.connect(this.engine.trackGain);
        this.latency = 0.115; // measured: the stretcher delays the sound by about 115 ms
        this.stretchState = 'ready'; return true;
      }).catch((e) => { console.warn('Time-stretch unavailable, tempo changes will change the pitch', e); this.stretchState = 'failed'; return false; });
      return this._loading;
    }
    get keepsPitch() { return this.stretchState === 'ready'; }
    // The engine made a new AudioContext: drop nodes from the old one (prepare() runs again).
    rebuild() {
      this.bus = null; this.stretch = null; this.stretchState = 'idle'; this._loading = null;
      if (this.stems) this.stems.forEach((s) => { s.gain = null; });
    }
    _route(ctx) {
      if (!this.bus) { this.bus = ctx.createGain(); }
      this.bus.disconnect();
      const viaStretch = this.rate !== 1 && this.stretch;
      this.bus.connect(viaStretch ? this.stretch : this.engine.trackGain);
      if (this.stretch) this.stretch.parameters.get('playbackRate').value = this.rate;
      if (this.stems) this.stems.forEach((s) => { if (!s.gain) { s.gain = ctx.createGain(); s.gain.connect(this.bus); } });
      this._mix();
    }
    play() {
      if (!this.buffer || this.playing) return;
      const ctx = this.engine.ensure();
      this._route(ctx);
      const list = this.stems && this.useStems ? this.stems.filter((s) => s.buffer) : [{ buffer: this.buffer, gain: null }];
      const at = ctx.currentTime + 0.03;
      this.srcs = list.map((s, i) => {
        const src = ctx.createBufferSource();
        src.buffer = s.buffer;
        src.playbackRate.value = this.rate;
        src.connect(s.gain || this.bus);
        if (i === 0) src.onended = () => { if (this.srcs[0] === src) { this.srcs = []; this.playing = false; this.offset = 0; this.onEnded && this.onEnded(); } };
        if (this.offset < s.buffer.duration) src.start(at, this.offset);
        return src;
      });
      this.startedAt = at;
      this.playing = true;
    }
    pause() { if (!this.playing) return; this.offset = this.position; this._kill(); }
    // Tempo: 0.5–1.5. Changes smoothly while playing; crossing 100% re-routes through the time-stretcher.
    setRate(r) {
      const reroute = (r === 1) !== (this.rate === 1);
      if (!this.playing) { this.rate = r; return; }
      if (reroute) { this.pause(); this.rate = r; this.play(); return; }
      const ctx = this.engine.ctx;
      this.offset = this.position; this.startedAt = ctx.currentTime; this.rate = r;
      this.srcs.forEach((s) => s.playbackRate.setValueAtTime(r, ctx.currentTime));
      if (this.stretch) this.stretch.parameters.get('playbackRate').setValueAtTime(r, ctx.currentTime);
    }
    stop() { this._kill(); this.offset = 0; }
    seek(sec) { const was = this.playing; this._kill(); this.offset = Math.max(0, Math.min(sec, this.duration)); if (was) this.play(); }
    _kill() { const list = this.srcs; this.srcs = []; list.forEach((s) => { s.onended = null; try { s.stop(); } catch (e) { /* already stopped */ } }); this.playing = false; }

    // stems: [{id, buffer}] or null. Volumes, mute and solo live on each entry.
    setStems(stems) {
      const was = this.playing; if (was) this.pause();
      if (this.stems) this.stems.forEach((s) => { if (s.gain) s.gain.disconnect(); });
      this.stems = stems ? stems.map((s) => Object.assign({ vol: 1, mute: false, solo: false, gain: null }, s)) : null;
      this.useStems = !!stems;
      if (was) this.play();
    }
    setUseStems(on) { const was = this.playing; if (was) this.pause(); this.useStems = !!on && !!this.stems; if (was) this.play(); }
    stem(id) { return this.stems && this.stems.find((s) => s.id === id); }
    setStem(id, patch) { const s = this.stem(id); if (s) { Object.assign(s, patch); this._mix(); } }
    _mix() {
      if (!this.stems) return;
      const solo = this.stems.some((s) => s.solo);
      const t = this.engine.ctx ? this.engine.ctx.currentTime : 0;
      this.stems.forEach((s) => { if (s.gain) s.gain.gain.setTargetAtTime(s.mute || (solo && !s.solo) ? 0 : s.vol, t, 0.015); });
    }
  }

  /* Metronome: Web Audio clicks scheduled a little ahead (so they stay steady even when the page is
   * busy), with an accent on the first beat of each bar. grid(from, to) can supply the beat times
   * instead, as AudioContext times with beat numbers (Jam Mode passes the song's own beats). */
  class Metronome {
    constructor(engine) {
      this.engine = engine; this.bpm = 100; this.beatsPerBar = 4; this.volume = 0.7; this.sound = true;
      this.on = false; this.grid = null; this.timer = null; this.next = 0; this.beat = 0; this.until = 0; this.queue = [];
    }
    start() {
      if (this.on) return;
      const ctx = this.engine.ensure();
      if (!this.out) { this.out = ctx.createGain(); this.out.connect(this.engine.master); }
      this.out.gain.value = this.volume;
      this.on = true; this.next = ctx.currentTime + 0.08; this.beat = 0; this.until = ctx.currentTime; this.queue = []; this.count = 0; this.bar = null;
      this.timer = setInterval(() => this._schedule(), 25);
      this._schedule();
    }
    stop() { this.on = false; clearInterval(this.timer); this.timer = null; this.queue = []; }
    rebuild() { this.out = null; if (this.on) { this.stop(); this.start(); } }
    setVolume(v) { this.volume = v; if (this.out) this.out.gain.value = v; }
    // Switch between the free-running beat and a supplied grid; picks up from now without a double click.
    setGrid(fn) {
      if (fn === this.grid) return;
      this.grid = fn;
      const ctx = this.engine.ctx; if (!ctx || !this.on) return;
      const last = this.queue.length ? this.queue[this.queue.length - 1].time : ctx.currentTime;
      this.until = Math.max(ctx.currentTime, last + 0.05);
      if (!fn) { this.next = Math.max(ctx.currentTime + 0.05, last + 60 / this.bpm); this.beat = this.queue.length ? (this.queue[this.queue.length - 1].beat + 1) % this.beatsPerBar : 0; }
    }
    // After a tempo or seek change: drop clicks not yet played and reschedule from now.
    resync() {
      const ctx = this.engine.ctx; if (!ctx || !this.on) return;
      const now = ctx.currentTime;
      this.queue.filter((q) => q.time > now + 0.01).forEach((q) => { try { q.osc.stop(); } catch (e) { /* done */ } });
      this.queue = this.queue.filter((q) => q.time <= now + 0.01);
      this.until = now + 0.02; this.next = now + 0.05;
    }
    _schedule() {
      const ctx = this.engine.ctx; if (!ctx || !this.on) return;
      const ahead = ctx.currentTime + 0.15;
      if (this.grid) {
        this.grid(this.until, ahead).forEach((b) => { if (b.time >= this.until) this._click(b.time, b.beat); });
        this.until = ahead;
      } else {
        while (this.next < ahead) {
          this._click(this.next, this.beat);
          this.next += 60 / this.bpm;
          this.beat = (this.beat + 1) % this.beatsPerBar;
        }
      }
      const old = ctx.currentTime - 2;
      while (this.queue.length && this.queue[0].time < old) this.queue.shift();
    }
    _click(t, beat) {
      const ctx = this.engine.ctx;
      // count: clicks since start; bar: bars since start (the staff places notes with these).
      this.count = (this.count || 0) + 1;
      if (beat === 0 || this.bar == null) this.bar = (this.bar == null ? 0 : this.bar + 1);
      const item = { time: t, beat, osc: null, count: this.count, bar: this.bar };
      if (this.sound) {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.frequency.value = beat === 0 ? 1760 : 1175;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(beat === 0 ? 0.9 : 0.5, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
        osc.connect(g).connect(this.out);
        osc.start(t); osc.stop(t + 0.06);
        item.osc = osc;
      }
      this.queue.push(item);
    }
    // The most recent beat at or before AudioContext time t (for the beat lights), or null.
    beatAt(t) { let hit = null; for (const q of this.queue) { if (q.time <= t) hit = q; else break; } return hit; }
  }

  root.Sound = { PRESETS, GROUPS, INSTRUMENT_PRESET, SoundEngine, TrackPlayer, Metronome };
})(window);
