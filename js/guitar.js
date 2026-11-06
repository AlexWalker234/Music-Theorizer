/* Guitar mode: audio-interface input, amp simulator, tuner and note tracking, and the
 * top-down fretboard drawing. Note tracking is monophonic: it follows single notes and riffs;
 * for a strummed chord it reports the strongest note. */
(function (root) {
  'use strict';

  const TUNINGS = {
    standard: { name: 'Standard (E A D G B E)', strings: [40, 45, 50, 55, 59, 64] },
    dropd: { name: 'Drop D (D A D G B E)', strings: [38, 45, 50, 55, 59, 64] },
    half: { name: 'Half step down (E♭)', strings: [39, 44, 49, 54, 58, 63] },
    dstd: { name: 'D standard', strings: [38, 43, 48, 53, 57, 62] },
    dropc: { name: 'Drop C', strings: [36, 43, 48, 53, 57, 62] },
  };

  // Amp voicings. drive: gain into the clipper; shape: clipping curve; bass/mid/treble in dB;
  // cab: speaker roll-off in Hz (0 = no cabinet); tight: low cut before the clipper; gate: noise gate level.
  const AMPS = {
    clean: { name: 'Clean', drive: 1.5, shape: 'soft', bass: 2, mid: 0, treble: 2, cab: 6500, tight: 70, gate: 0.002 },
    jazz: { name: 'Warm jazz', drive: 1.2, shape: 'soft', bass: 4, mid: 1, treble: -5, cab: 3800, tight: 60, gate: 0.002 },
    blues: { name: 'Blues crunch', drive: 7, shape: 'tube', bass: 1, mid: 3, treble: 1, cab: 5200, tight: 90, gate: 0.004 },
    rock: { name: 'Classic rock', drive: 16, shape: 'tube', bass: 2, mid: 4, treble: 2, cab: 5000, tight: 100, gate: 0.006 },
    lead: { name: 'High-gain lead', drive: 45, shape: 'hard', bass: 2, mid: 5, treble: 1, cab: 4800, tight: 120, gate: 0.01 },
    metal: { name: 'Metal', drive: 90, shape: 'hard', bass: 4, mid: -5, treble: 4, cab: 4600, tight: 160, gate: 0.015 },
    acoustic: { name: 'Acoustic simulator', drive: 0, shape: 'none', bass: -5, mid: -3, treble: 6, cab: 12000, tight: 90, gate: 0.002, body: true },
    di: { name: 'No amp (direct)', drive: 0, shape: 'none', bass: 0, mid: 0, treble: 0, cab: 0, tight: 0, gate: 0 },
  };

  function curve(shape, k) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      if (shape === 'soft') c[i] = Math.tanh(k * x) / Math.tanh(k);
      else if (shape === 'tube') c[i] = x >= 0 ? Math.tanh(k * x) / Math.tanh(k) : Math.tanh(k * 0.75 * x) / Math.tanh(k * 0.75) * 0.9;
      else if (shape === 'hard') c[i] = (2 / Math.PI) * Math.atan(k * x) / ((2 / Math.PI) * Math.atan(k));
      else c[i] = x;
    }
    return c;
  }

  // YIN pitch detection on one frame. Returns { f0, clarity } (clarity 0..1, higher = more periodic).
  function yin(buf, sr, minF, maxF) {
    const W = Math.floor(buf.length / 2);
    const tauMin = Math.max(2, Math.floor(sr / maxF)), tauMax = Math.min(W - 1, Math.ceil(sr / minF));
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) { const v = buf[i] - buf[i + tau]; sum += v * v; }
      d[tau] = sum;
    }
    // Cumulative mean normalized difference.
    let run = 0; d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; d[tau] = run ? d[tau] * tau / run : 1; }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < 0.15) { while (t + 1 <= tauMax && d[t + 1] < d[t]) t++; tau = t; break; }
    }
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin; t <= tauMax; t++) if (d[t] < d[best]) best = t;
      if (d[best] > 0.35) return { f0: 0, clarity: 1 - d[best] };
      tau = best;
    }
    // Parabolic interpolation.
    const a = d[tau - 1] !== undefined ? d[tau - 1] : d[tau], b = d[tau], c = tau + 1 <= tauMax ? d[tau + 1] : d[tau];
    const den = a + c - 2 * b;
    const shift = den ? (a - c) / (2 * den) : 0;
    return { f0: sr / (tau + shift), clarity: Math.max(0, 1 - b) };
  }

  const midiFloat = (f, ref) => 69 + 12 * Math.log2(f / ref);

  class Rig {
    constructor(engine, cb) {
      this.engine = engine;
      this.cb = cb || {};
      this.stream = null; this.deviceId = ''; this.channel = 0; this.channels = 1;
      this.amp = 'clean'; this.params = { drive: 5, bass: 0, mid: 0, treble: 0 };
      this.volume = 0.8; this.stereo = false; this.monitor = true;
      this.ref = 440;
      this.nodes = null; this.timer = 0;
      this.track = { cur: null, frames: 0, cand: null, candN: 0, prevRms: 0, quiet: 0, floor: 0.002 };
    }

    // Audio inputs the browser can see. Names only appear after the user allows access once.
    static async devices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    }

    static supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

    async _open(deviceId) {
      const audio = {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 8 }, latency: { ideal: 0 },
      };
      if (deviceId) audio.deviceId = { exact: deviceId };
      return navigator.mediaDevices.getUserMedia({ audio });
    }

    async connect(deviceId, channel) {
      this.disconnect();
      const stream = await this._open(deviceId);
      this.stream = stream;
      const t = stream.getAudioTracks()[0];
      const st = (t && t.getSettings && t.getSettings()) || {};
      this.deviceId = st.deviceId || deviceId || '';
      this.label = (t && t.label) || 'Audio input';
      this.channels = st.channelCount || 1;
      this.deviceRate = st.sampleRate || 0;
      this.inputLatency = typeof st.latency === 'number' ? st.latency : 0;
      this.channel = channel == null ? 0 : channel;
      this._build();
      return this.info();
    }

    info() {
      const e = this.engine.info() || {};
      return {
        label: this.label || '', deviceId: this.deviceId, channels: this.channels, deviceRate: this.deviceRate,
        sampleRate: e.sampleRate || 0, inputLatency: this.inputLatency, outputLatency: (e.baseLatency || 0) + (e.outputLatency || 0),
      };
    }

    // channel: 0..n-1 for one input, or 'stereo' for the first two mixed.
    setChannel(ch) { this.channel = ch; if (this.stream) this._build(); }

    _build() {
      this._teardown();
      const ctx = this.engine.ensure();
      const n = {};
      n.src = ctx.createMediaStreamSource(this.stream);
      const count = Math.max(1, n.src.channelCount || this.channels);
      n.split = ctx.createChannelSplitter(Math.max(2, count));
      n.src.connect(n.split);
      n.pick = ctx.createGain();
      if (this.channel === 'stereo') { n.split.connect(n.pick, 0); n.split.connect(n.pick, Math.min(1, count - 1)); n.pick.gain.value = 0.5; }
      else n.split.connect(n.pick, Math.min(+this.channel || 0, count - 1));
      // Clean tap for the tuner, the level meter and note tracking.
      n.analyser = ctx.createAnalyser();
      n.analyser.fftSize = ctx.sampleRate > 50000 ? 4096 : 2048;
      n.pick.connect(n.analyser);
      // Amp chain.
      n.tight = ctx.createBiquadFilter(); n.tight.type = 'highpass';
      n.pre = ctx.createGain();
      n.shaper = ctx.createWaveShaper(); n.shaper.oversample = '4x';
      n.post = ctx.createGain();
      n.bass = ctx.createBiquadFilter(); n.bass.type = 'lowshelf'; n.bass.frequency.value = 120;
      n.mid = ctx.createBiquadFilter(); n.mid.type = 'peaking'; n.mid.frequency.value = 750; n.mid.Q.value = 0.8;
      n.treble = ctx.createBiquadFilter(); n.treble.type = 'highshelf'; n.treble.frequency.value = 3000;
      n.body = ctx.createBiquadFilter(); n.body.type = 'peaking'; n.body.frequency.value = 220; n.body.Q.value = 1.2;
      n.cab = ctx.createBiquadFilter(); n.cab.type = 'lowpass'; n.cab.Q.value = 0.9;
      n.cabLow = ctx.createBiquadFilter(); n.cabLow.type = 'highpass'; n.cabLow.frequency.value = 70;
      n.gate = ctx.createGain();
      n.vol = ctx.createGain();
      n.merge = ctx.createChannelMerger(2);
      n.delay = ctx.createDelay(0.05); n.delay.delayTime.value = 0.013;
      n.send = ctx.createGain(); n.send.gain.value = 0;
      n.out = ctx.createGain();
      n.pick.connect(n.tight).connect(n.pre).connect(n.shaper).connect(n.post).connect(n.bass).connect(n.mid)
        .connect(n.treble).connect(n.body).connect(n.cab).connect(n.cabLow).connect(n.gate).connect(n.vol);
      n.merge.connect(n.out);
      n.out.connect(ctx.destination);
      if (this.engine.wet) n.send.connect(this.engine.wet);
      n.vol.connect(n.send);
      this.nodes = n;
      this._wireStereo();
      this.setAmp(this.amp);
      this.setVolume(this.volume);
      this.setMonitor(this.monitor);
      this.buf = new Float32Array(n.analyser.fftSize);
      this.timer = setInterval(() => this._tick(), 25);
    }

    _wireStereo() {
      const n = this.nodes; if (!n) return;
      try { n.vol.disconnect(n.merge); } catch (e) { /* not connected */ }
      try { n.delay.disconnect(); n.vol.disconnect(n.delay); } catch (e) { /* not connected */ }
      if (this.stereo) {
        // Stereo: dry on the left, a short delayed copy on the right, plus some room.
        n.vol.connect(n.merge, 0, 0);
        n.vol.connect(n.delay); n.delay.connect(n.merge, 0, 1);
        n.send.gain.value = 0.25;
      } else {
        n.vol.connect(n.merge, 0, 0); n.vol.connect(n.merge, 0, 1);
        n.send.gain.value = 0;
      }
    }

    setStereo(on) { this.stereo = !!on; this._wireStereo(); }

    setAmp(id) {
      if (!AMPS[id]) id = 'clean';
      this.amp = id;
      this._applyAmp();
    }

    // drive 0..10, bass/mid/treble -12..12 dB on top of the amp's own voicing.
    setParam(name, v) { this.params[name] = v; this._applyAmp(); }

    _applyAmp() {
      const n = this.nodes; if (!n) return;
      const a = AMPS[this.amp], p = this.params, t = n.pre.context.currentTime;
      const drive = a.drive ? a.drive * (0.2 + p.drive / 6.25) : 0;
      n.tight.frequency.value = a.tight || 10;
      n.pre.gain.value = drive ? drive : 1;
      n.shaper.curve = a.shape === 'none' ? null : curve(a.shape, 1 + Math.min(drive, 6) / 2);
      n.post.gain.value = drive ? 1 / Math.sqrt(Math.max(1, drive)) * 1.2 : 1;
      n.bass.gain.setTargetAtTime(a.bass + p.bass, t, 0.02);
      n.mid.gain.setTargetAtTime(a.mid + p.mid, t, 0.02);
      n.treble.gain.setTargetAtTime(a.treble + p.treble, t, 0.02);
      n.body.gain.value = a.body ? 4 : 0;
      n.cab.frequency.value = a.cab || 20000;
      this.gateLevel = a.gate;
    }

    setVolume(v) { this.volume = v; if (this.nodes) this.nodes.vol.gain.value = v; }
    setMonitor(on) { this.monitor = !!on; if (this.nodes) this.nodes.out.gain.value = on ? 1 : 0; }
    setReference(hz) { this.ref = hz; }

    disconnect() {
      this._teardown();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    _teardown() {
      clearInterval(this.timer); this.timer = 0;
      if (this.nodes) { try { this.nodes.src.disconnect(); this.nodes.out.disconnect(); this.nodes.send.disconnect(); } catch (e) { /* gone */ } }
      this.nodes = null;
    }

    // Called after the audio engine was rebuilt (new sample rate or latency).
    rebuild() { if (this.stream) this._build(); }

    // Strum test: listens to every input of every interface and returns the loudest one.
    async findGuitar(onProgress, seconds) {
      const devs = (await Rig.devices()).filter((d) => d.deviceId !== 'default');
      const list = devs.length ? devs : [{ deviceId: '', label: 'Default input' }];
      const ctx = this.engine.ensure();
      let best = null;
      for (let i = 0; i < list.length; i++) {
        if (onProgress) onProgress(i, list.length, list[i].label);
        let stream;
        try { stream = await this._open(list[i].deviceId); } catch (e) { continue; }
        const src = ctx.createMediaStreamSource(stream);
        const count = Math.max(1, src.channelCount);
        const split = ctx.createChannelSplitter(Math.max(2, count));
        src.connect(split);
        const an = [];
        for (let c = 0; c < count; c++) { const a = ctx.createAnalyser(); a.fftSize = 1024; split.connect(a, c); an.push(a); }
        const peak = new Array(count).fill(0), b = new Float32Array(1024);
        const end = performance.now() + (seconds || 1.5) * 1000;
        while (performance.now() < end) {
          await new Promise((r) => setTimeout(r, 40));
          an.forEach((a, c) => { a.getFloatTimeDomainData(b); let s = 0; for (let k = 0; k < b.length; k++) s += b[k] * b[k]; peak[c] = Math.max(peak[c], Math.sqrt(s / b.length)); });
        }
        src.disconnect(); stream.getTracks().forEach((t) => t.stop());
        peak.forEach((p, c) => { if (!best || p > best.level) best = { deviceId: list[i].deviceId, label: list[i].label, channel: c, channels: count, level: p }; });
      }
      return best;
    }

    _tick() {
      const n = this.nodes; if (!n) return;
      const sr = n.analyser.context.sampleRate;
      n.analyser.getFloatTimeDomainData(this.buf);
      let s = 0, pk = 0;
      for (let i = 0; i < this.buf.length; i++) { const v = this.buf[i]; s += v * v; if (Math.abs(v) > pk) pk = Math.abs(v); }
      const rms = Math.sqrt(s / this.buf.length);
      const tr = this.track;
      // Noise gate on the amp output, driven by the clean input level.
      const open = rms > Math.max(this.gateLevel || 0, tr.floor * 2);
      n.gate.gain.setTargetAtTime(open || !this.gateLevel ? 1 : 0, n.gate.context.currentTime, open ? 0.003 : 0.04);
      if (rms < tr.floor * 4 || tr.floor === 0.002) tr.floor = tr.floor * 0.995 + Math.min(rms, 0.05) * 0.005;
      const frame = { rms, peak: pk, clip: pk > 0.98, f0: 0, midi: null, cents: 0, voiced: false };
      if (rms > Math.max(0.003, tr.floor * 3)) {
        const p = yin(this.buf, sr, 60, 1400);
        if (p.f0 && p.clarity > 0.8) {
          const mf = midiFloat(p.f0, this.ref), m = Math.round(mf);
          Object.assign(frame, { f0: p.f0, midi: m, cents: (mf - m) * 100, voiced: true, clarity: p.clarity });
        }
      }
      this._follow(frame);
      if (this.cb.onFrame) this.cb.onFrame(frame);
    }

    // Turns frames into note events: a note starts on a pluck (level jump) or when the pitch
    // settles on a new note for two frames.
    _follow(f) {
      const tr = this.track;
      const pluck = f.rms > tr.prevRms * 1.6 && f.rms > tr.floor * 6;
      tr.prevRms = tr.prevRms * 0.6 + f.rms * 0.4;
      if (!f.voiced) {
        if (++tr.quiet > 3) { tr.cur = null; tr.cand = null; tr.candN = 0; }
        return;
      }
      tr.quiet = 0;
      if (pluck) { tr.cand = f.midi; tr.candN = 1; tr.plucked = true; return; }
      if (f.midi === tr.cand) tr.candN++; else { tr.cand = f.midi; tr.candN = 1; }
      if (tr.candN >= 2 && (tr.cur !== tr.cand || tr.plucked)) {
        tr.cur = tr.cand; tr.plucked = false;
        if (this.cb.onNote) this.cb.onNote({ midi: tr.cur, f0: f.f0, cents: f.cents });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Fretboard
  function positionsFor(midi, strings, frets) {
    const out = [];
    strings.forEach((open, s) => { const f = midi - open; if (f >= 0 && f <= frets) out.push({ s, f }); });
    return out;
  }
  function nearest(midi, strings, frets, hand) {
    const ps = positionsFor(midi, strings, frets);
    if (!ps.length) return null;
    return ps.reduce((b, p) => (Math.abs(p.f - hand) < Math.abs(b.f - hand) ? p : b), ps[0]);
  }

  const NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  /* o: { strings:[low..high midi], frets, scalePcs:Set|null, rootPc, chordPcs:Set|null,
   *      badges: Map(midi -> {ns, next}), live: midi|null, trail:[midi], hand: fret, name(pc) } */
  function drawFretboard(host, o) {
    const frets = o.frets || 15, S = o.strings.length;
    const W = 1200, H = 230, left = 70, right = 14, top = 26, bottom = 34;
    // Real fret spacing, scaled to fit.
    const pos = [0];
    for (let f = 1; f <= frets; f++) pos.push(1 - Math.pow(2, -f / 12));
    const scale = (W - left - right) / pos[frets];
    const fx = (f) => left + pos[f] * scale;
    const mid = (f) => (f === 0 ? left - 20 : (fx(f - 1) + fx(f)) / 2);
    const sy = (s) => top + (S - 1 - s) * ((H - top - bottom) / (S - 1)); // high string on top
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fb', role: 'img', 'aria-label': 'Guitar fretboard' });
    root.append(svg('rect', { x: left, y: top - 10, width: W - left - right, height: H - top - bottom + 20, rx: 6, class: 'fb-wood' }));
    [3, 5, 7, 9, 15, 17, 19, 21].filter((f) => f <= frets).forEach((f) => root.append(svg('circle', { cx: mid(f), cy: (top + H - bottom) / 2, r: 7, class: 'fb-inlay' })));
    if (frets >= 12) { const y0 = top + (H - top - bottom) * 0.28, y1 = top + (H - top - bottom) * 0.72; [y0, y1].forEach((y) => root.append(svg('circle', { cx: mid(12), cy: y, r: 7, class: 'fb-inlay' }))); }
    for (let f = 0; f <= frets; f++) root.append(svg('line', { x1: fx(f), x2: fx(f), y1: top - 10, y2: H - bottom + 10, class: f === 0 ? 'fb-nut' : 'fb-fret' }));
    for (let f = 1; f <= frets; f++) root.append(svg('text', { x: mid(f), y: H - 8, class: 'fb-num' }, f));
    o.strings.forEach((open, s) => {
      root.append(svg('line', { x1: left - 40, x2: W - right, y1: sy(s), y2: sy(s), class: 'fb-string', 'stroke-width': (1 + (S - 1 - s) * 0.35).toFixed(2) }));
      root.append(svg('text', { x: 4, y: sy(s) + 4, class: 'fb-open' }, o.name(open % 12)));
    });
    const dot = (s, f, cls, label) => {
      const g = svg('g', { class: 'fb-dot ' + cls });
      g.append(svg('circle', { cx: mid(f), cy: sy(s), r: cls.includes('badge') || cls.includes('live') ? 12 : 10 }));
      if (label != null) g.append(svg('text', { x: mid(f), y: sy(s) + 4 }, label));
      root.append(g);
    };
    // Every place a scale note can be played.
    if (o.scalePcs) {
      o.strings.forEach((open, s) => {
        for (let f = 0; f <= frets; f++) {
          const pc = (open + f) % 12;
          if (!o.scalePcs.has(pc)) continue;
          const cls = o.chordPcs && o.chordPcs.has(pc) ? 'chord' : 'scale';
          dot(s, f, cls + (pc === o.rootPc ? ' root' : ''), o.name(pc));
        }
      });
    }
    // Recently played notes fade out; the current note glows.
    (o.trail || []).forEach((t, i, arr) => { if (t.pos) { const g = svg('g', { class: 'fb-dot trail', opacity: (0.25 + 0.5 * (i + 1) / arr.length).toFixed(2) }); g.append(svg('circle', { cx: mid(t.pos.f), cy: sy(t.pos.s), r: 13 })); root.append(g); } });
    if (o.badges) {
      for (const [m, b] of o.badges) {
        const p = nearest(m, o.strings, frets, Math.round(o.hand || 0));
        if (p) dot(p.s, p.f, 'badge' + (b.next ? ' next' : ''), b.ns.join('·'));
      }
    }
    if (o.livePos) dot(o.livePos.s, o.livePos.f, 'live', o.name(o.live % 12));
    host.replaceChildren(root);
  }

  root.Guitar = { TUNINGS, AMPS, Rig, yin, positionsFor, nearest, drawFretboard };
})(window);
