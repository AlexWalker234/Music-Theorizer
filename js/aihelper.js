/* Optional AI analysis helper (ai-helper/server.py, running on this computer).
 * When Settings › Song analysis is set to "AI helper", Jam Mode sends the song to it and uses its
 * key, chords (BTC, including 7ths and sus chords), beats and tempo (madmom). Notes, the riff, tuning
 * and sections still come from the built-in engine, which also runs as the fallback.
 * The desktop app forwards /aihelper/... to the helper, so no browser permission is needed there. */
(function (root) {
  'use strict';
  const T = root.Theory;
  const DEFAULT_URL = 'http://127.0.0.1:8765';

  // BTC quality -> [triad quality the app highlights and names keys with, name suffix, intervals]
  const QUALS = {
    maj: ['maj', '', [0, 4, 7]], min: ['min', 'm', [0, 3, 7]], dim: ['dim', '°', [0, 3, 6]], aug: ['aug', '+', [0, 4, 8]],
    maj6: ['maj', '6', [0, 4, 7, 9]], min6: ['min', 'm6', [0, 3, 7, 9]], '7': ['maj', '7', [0, 4, 7, 10]],
    maj7: ['maj', 'maj7', [0, 4, 7, 11]], min7: ['min', 'm7', [0, 3, 7, 10]], minmaj7: ['min', 'm(maj7)', [0, 3, 7, 11]],
    dim7: ['dim', '°7', [0, 3, 6, 9]], hdim7: ['dim', 'm7♭5', [0, 3, 6, 10]], sus2: ['maj', 'sus2', [0, 2, 7]], sus4: ['maj', 'sus4', [0, 5, 7]],
  };

  function baseUrl(custom) {
    if (root.MT_DESKTOP) return location.origin + '/aihelper';
    return (custom || DEFAULT_URL).replace(/\/+$/, '');
  }

  const unreachable = (custom) => 'Could not reach the AI helper at ' + (root.MT_DESKTOP ? (root.MT_DESKTOP.helper || DEFAULT_URL) : baseUrl(custom)) + '. Is it running?';

  async function health(custom, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 3000);
    try {
      const res = await fetch(baseUrl(custom) + '/health', { signal: ctl.signal });
      if (res.status === 502 && res.headers.get('X-MT-Unreachable')) return { ok: false, unreachable: true, error: unreachable(custom) };
      if (!res.ok) return { ok: false, error: 'The helper answered ' + res.status + '.' };
      return await res.json();
    } catch (e) {
      return { ok: false, unreachable: true, error: unreachable(custom) };
    } finally { clearTimeout(t); }
  }

  /* samples: mono Float32Array. Resolves to the helper's JSON, rejects with an Error on failure. */
  async function analyze(samples, sampleRate, opts) {
    opts = opts || {};
    // 22.05 kHz is all the models use; it also keeps the upload small (about 5 MB per minute).
    const x = root.Analysis && sampleRate > 22050 ? root.Analysis.resample(samples, sampleRate, 22050) : samples;
    const sr = sampleRate > 22050 ? 22050 : sampleRate;
    let res;
    try {
      res = await fetch(baseUrl(opts.url) + '/analyze?sr=' + Math.round(sr) + (opts.separate ? '&separate=1' : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength), signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      throw new Error(unreachable(opts.url));
    }
    if (res.status === 502 && res.headers.get('X-MT-Unreachable')) throw new Error(unreachable(opts.url));
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || 'The AI helper answered ' + res.status + '.');
    return data;
  }

  /* Instrument separation (Demucs in the helper, then, unless opts.auto is false, the instruments it
   * recognises split out with AudioSep). buffer: the song's AudioBuffer. Sends it as 16-bit audio
   * (stereo when the song is), shows progress through opts.onProgress(fraction, stage) and resolves to
   * { info, stems: [{id, label, family, instruments, present, levelDb, buffer}] } with one AudioBuffer per
   * instrument the helper sent back. info.instruments lists what the helper recognised. */
  const FAMILY = { drums: 'drums', bass: 'bass', vocals: 'vocals' };     // helpers before 1.2 sent no family
  async function separate(buffer, opts) {
    opts = opts || {};
    const ch = Math.min(2, buffer.numberOfChannels), n = buffer.length;
    const pcm = new Int16Array(ch * n);
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c), o = c * n;
      for (let i = 0; i < n; i++) { const v = d[i]; pcm[o + i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767); }
    }
    let poll = null;
    if (opts.onProgress) {
      poll = setInterval(async () => {
        const h = await health(opts.url, 2500);
        if (h && h.job && h.job.kind === 'separate') opts.onProgress(h.job.progress, h.job.stage);
      }, 1000);
    }
    let res;
    try {
      try {
        res = await fetch(baseUrl(opts.url) + '/separate?sr=' + Math.round(buffer.sampleRate) + '&ch=' + ch + (opts.auto === false ? '&auto=0' : ''), {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm.buffer, signal: opts.signal,
        });
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw e;
        throw Object.assign(new Error(unreachable(opts.url)), { code: 'unreachable' });
      }
      if (res.status === 502 && res.headers.get('X-MT-Unreachable')) throw Object.assign(new Error(unreachable(opts.url)), { code: 'unreachable' });
      if (res.status === 404) throw Object.assign(new Error('This AI helper is an older version without instrument separation. Download the new helper and run its setup again.'), { code: 'old_helper' });
      if (!res.ok) {
        let data = null; try { data = await res.json(); } catch (e) { /* not JSON */ }
        throw Object.assign(new Error((data && data.error) || 'The AI helper answered ' + res.status + '.'), { code: (data && data.code) || 'failed' });
      }
      if (opts.onProgress) opts.onProgress(1, 'Receiving the instruments');
      const bin = await res.arrayBuffer();
      const hlen = new DataView(bin).getUint32(0, true);
      const info = JSON.parse(new TextDecoder().decode(new Uint8Array(bin, 4, hlen)));
      let off = 4 + hlen;
      const stems = info.stems.map((s) => {
        const out = { id: s.id, label: s.label, family: s.family || FAMILY[s.id] || 'pitched', instruments: s.instruments || [], present: s.present, levelDb: s.levelDb, buffer: null };
        if (s.samples) {
          const bytes = bin.slice(off, off + 2 * s.samples); off += 2 * s.samples;
          const pcm16 = new Int16Array(bytes), ab = new AudioBuffer({ length: s.samples, sampleRate: info.sampleRate, numberOfChannels: 1 });
          const d = ab.getChannelData(0), g = (s.gain || 1) / 32767;
          for (let i = 0; i < pcm16.length; i++) d[i] = pcm16[i] * g;
          out.buffer = ab;
        }
        return out;
      });
      return { info, stems };
    } finally { if (poll) clearInterval(poll); }
  }

  /* Puts the helper's key, chords, beats and tempo into the built-in result. Keeps the built-in
   * answers under result.builtIn for the side-by-side view. */
  function merge(base, h) {
    const key = { rootPc: h.key.rootPc, scaleId: h.key.scaleId, label: T.scaleLabel(h.key.rootPc, h.key.scaleId) };
    const dia = T.diatonicChords(key.rootPc, key.scaleId);
    const chords = h.chords.map((c) => {
      const q = QUALS[c.quality] || QUALS.maj;
      const d = dia.find((x) => x.rootPc === c.root && x.quality === q[0]);
      return { start: c.start, end: c.end, rootPc: c.root, quality: q[0], ext: c.quality,
        name: T.pcName(c.root, key.rootPc) + q[1], pcs: q[2].map((i) => T.mod12(c.root + i)), roman: d ? d.roman : null };
    });
    const cands = h.keyCandidates.map((c) => ({ rootPc: c.rootPc, scaleId: c.scaleId, label: T.scaleLabel(c.rootPc, c.scaleId), corr: c.score }));
    const builtIn = { key: base.key, keyCandidates: base.keyCandidates, keyConfidence: base.keyConfidence, tempo: base.tempo, chords: base.chords, engine: base.engine };
    return Object.assign({}, base, {
      key, keyCandidates: cands, keyConfidence: h.keyConfidence,
      tempo: h.tempo && h.tempo.bpm ? h.tempo : base.tempo,
      beats: h.beats.length ? h.beats : base.beats,
      downbeat: h.downbeats.length ? h.downbeats[0] : base.downbeat,
      chords: chords.length ? chords : base.chords,
      engine: 'AI helper (' + h.engine + ') + ' + base.engine,
      helper: { engine: h.engine, device: h.device, seconds: h.seconds, separated: h.separated, warnings: h.warnings, madmomKey: h.madmomKey, beatsPerBar: h.beatsPerBar },
      builtIn,
    });
  }

  root.AIHelper = { DEFAULT_URL, baseUrl, health, analyze, separate, merge, QUALS };
})(typeof window !== 'undefined' ? window : globalThis);
