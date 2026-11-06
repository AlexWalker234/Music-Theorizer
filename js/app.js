/* Music Theorizer app: wires the keyboard, modes, song analysis and coach together. */
(function () {
  'use strict';
  const T = window.Theory, A = window.Analysis, S = window.Sound, C = window.CoachKit;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const fmtTime = (s) => { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('mt.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('mt.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const DEFAULT_SETTINGS = { volume: 0.8, reverb: 0.2, trackVol: 0.7, octaves: null, labels: true, hints: true, numKeys: true, phraseLen: 4, theme: 'system', level: 'beginner', freeIdent: true, staff: true, staffMarks: true, staffJam: true,
    sampleRate: 'auto', latency: 'interactive', engine: 'builtin', helperUrl: '', helperSep: false,
    metroBpm: 100, metroBpb: 4, metroVol: 0.7, metroSound: true, metroFollow: true,
    palette: 'default', colScale: '#f2c96d', colChord: '#72cfc6', colNext: '#e2483d', colRoot: '#8a5a00', pattern: false, modeCol: 'colour', contrast: false, textSize: 100, motion: false,
    gtrDevice: '', gtrChannel: '0', gtrAmp: 'clean', gtrStereo: false, gtrDrive: 5, gtrBass: 0, gtrMid: 0, gtrTreble: 0,
    gtrVol: 0.8, gtrMonitor: true, gtrRef: 440, gtrTuning: 'standard' };
  const settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  const engine = new S.SoundEngine();
  const player = new S.TrackPlayer(engine);
  const metro = new S.Metronome(engine);

  const state = {
    mode: 'free',
    kbStart: 48,
    octaves: settings.octaves || (window.innerWidth < 700 ? 2 : 3),
    kbdBase: 60,
    held: new Set(),
    labels: settings.labels,
    free: { weights: new Array(12).fill(0), seq: [] },
    scale: { root: 0, id: 'major', only: false, degrees: false, chord: null },
    riff: { tab: 'along', shift: 0, mode: 'step', active: false, idx: 0, rounds: 0, hits: 0, misses: 0, hitSet: new Set(), sig: '' },
    jam: { status: 'empty', result: null, keyHistory: [], key: null, sourceName: '', chordIdx: -1,
      sugg: { seed: 1, history: [], notes: [], idx: 0 }, ctl: null, hits: 0 },
  };

  // ---------------------------------------------------------------------
  // Keyboard
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const COMPUTER_KEYS = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
  const keyEls = new Map();

  function buildKeyboard() {
    const kbd = $('kbd');
    kbd.innerHTML = '';
    keyEls.clear();
    const lo = state.kbStart, hi = state.kbStart + 12 * state.octaves;
    const whites = [];
    for (let m = lo; m <= hi; m++) if (!BLACK.has(T.mod12(m))) whites.push(m);
    const w = 100 / whites.length;
    let wi = 0;
    for (let m = lo; m <= hi; m++) {
      const black = BLACK.has(T.mod12(m));
      const k = el('div', { class: 'key ' + (black ? 'black' : 'white'), 'data-midi': m, role: 'button', 'aria-label': T.midiName(m) },
        el('span', { class: 'hint' }), el('span', { class: 'lbl' }));
      if (black) { k.style.left = (wi * w - w * 0.32) + '%'; k.style.width = (w * 0.64) + '%'; }
      else wi++;
      kbd.append(k);
      keyEls.set(m, k);
    }
    $('oct-label').textContent = T.midiName(lo) + '–' + T.midiName(hi);
    renderKeys();
  }

  let pointerDown = false;
  function keyFromEvent(e) { const k = e.target.closest && e.target.closest('.key'); return k ? +k.dataset.midi : null; }
  const pointerNotes = new Map();
  $('kbd').addEventListener('pointerdown', (e) => {
    const m = keyFromEvent(e); if (m == null) return;
    pointerDown = true; e.preventDefault();
    pointerNotes.set(e.pointerId, m); press(m, 0.8);
  });
  $('kbd').addEventListener('pointerover', (e) => {
    if (!pointerDown || !pointerNotes.has(e.pointerId)) return;
    const m = keyFromEvent(e); const prev = pointerNotes.get(e.pointerId);
    if (m == null || m === prev) return;
    release(prev); pointerNotes.set(e.pointerId, m); press(m, 0.8);
  });
  const endPointer = (e) => { if (pointerNotes.has(e.pointerId)) { release(pointerNotes.get(e.pointerId)); pointerNotes.delete(e.pointerId); } if (!pointerNotes.size) pointerDown = false; };
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  const kbHeld = new Map();
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    const num = /^(Digit|Numpad)([0-9])$/.exec(e.code);
    if (num) {
      // Number row / numpad: play the key carrying that number badge (0 = 10).
      const n = +num[2] || 10;
      const hit = Array.from(highlights().badges).find(([, b]) => b.ns.includes(n));
      if (hit) { kbHeld.set(e.code, hit[0]); press(hit[0], 0.8); e.preventDefault(); }
      return;
    }
    if (k === 'z' || k === 'x') { state.kbdBase = Math.max(24, Math.min(96, state.kbdBase + (k === 'z' ? -12 : 12))); renderKeys(); return; }
    if (k in COMPUTER_KEYS) { const m = state.kbdBase + COMPUTER_KEYS[k]; kbHeld.set(k, m); press(m, 0.8); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    for (const k of [e.key.toLowerCase(), e.code]) if (kbHeld.has(k)) { release(kbHeld.get(k)); kbHeld.delete(k); }
  });
  window.addEventListener('blur', () => { kbHeld.forEach((m) => release(m)); kbHeld.clear(); });

  // ---------------------------------------------------------------------
  // Pitch bend and modulation wheels: drag them, use the arrow keys, or a MIDI controller.
  // Pitch springs back to the middle when let go, like a hardware wheel; modulation stays where it is left.
  const wheels = { bend: 0, mod: 0 };
  function setBend(v) {
    wheels.bend = Math.max(-1, Math.min(1, v));
    engine.setBend(wheels.bend);
    const w = $('wheel-pitch'), semis = wheels.bend * 2;
    w.style.setProperty('--pos', (50 - wheels.bend * 42) + '%'); w.style.setProperty('--glow', Math.abs(wheels.bend).toFixed(2));
    w.setAttribute('aria-valuenow', semis.toFixed(1));
    $('wheel-pitch-val').textContent = Math.abs(semis) < 0.05 ? '0' : (semis > 0 ? '+' : '−') + Math.abs(semis).toFixed(1);
  }
  function setMod(v) {
    wheels.mod = Math.max(0, Math.min(1, v));
    engine.setMod(wheels.mod);
    const w = $('wheel-mod'), pct = Math.round(wheels.mod * 100);
    w.style.setProperty('--pos', (92 - wheels.mod * 84) + '%'); w.style.setProperty('--fill', pct + '%'); w.style.setProperty('--glow', wheels.mod.toFixed(2));
    w.setAttribute('aria-valuenow', String(pct));
    $('wheel-mod-val').textContent = pct + '%';
  }
  function dragWheel(id, onMove, onEnd) {
    const w = $(id);
    w.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      try { engine.ensure(); } catch (err) { /* no audio; the wheel still moves */ }
      w.setPointerCapture(e.pointerId); w.classList.add('dragging');
      const at = (ev) => { const r = w.getBoundingClientRect(); return 1 - Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)); };
      onMove(at(e));
      const move = (ev) => onMove(at(ev));
      const up = () => { w.classList.remove('dragging'); w.removeEventListener('pointermove', move); w.removeEventListener('pointerup', up); w.removeEventListener('pointercancel', up); if (onEnd) onEnd(); };
      w.addEventListener('pointermove', move); w.addEventListener('pointerup', up); w.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  }
  dragWheel('wheel-pitch', (y) => setBend(y * 2 - 1), () => setBend(0));
  dragWheel('wheel-mod', (y) => setMod(y));
  $('wheel-pitch').addEventListener('dblclick', () => setBend(0));
  $('wheel-mod').addEventListener('dblclick', () => setMod(0));

  // Arrow keys: up/down bend while held, left/right step the modulation.
  const arrowsHeld = new Set();
  window.addEventListener('keydown', (e) => {
    if (!/^Arrow(Up|Down|Left|Right)$/.test(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
    // Leave arrows alone only where they already mean something: text boxes, sliders, dropdowns and the coach.
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable || a.closest('.coach') ||
      (a.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|color)$/.test(a.type)))) return;
    if (document.querySelector('.kbd-wrap').classList.contains('is-guitar') || settings.level !== 'advanced') return; // no wheels in guitar mode or Beginner
    e.preventDefault();
    try { engine.ensure(); } catch (err) { /* no audio */ }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { arrowsHeld.add(e.key); setBend(e.key === 'ArrowUp' ? 1 : -1); }
    else setMod(wheels.mod + (e.key === 'ArrowRight' ? 0.05 : -0.05));
  });
  window.addEventListener('keyup', (e) => {
    if (!arrowsHeld.has(e.key)) return;
    arrowsHeld.delete(e.key);
    setBend(arrowsHeld.has('ArrowUp') ? 1 : arrowsHeld.has('ArrowDown') ? -1 : 0);
  });
  window.addEventListener('blur', () => { if (arrowsHeld.size) { arrowsHeld.clear(); setBend(0); } });

  // Every note from any input goes through press/release.
  let bgWrite = null, bgRelease = null; // set by the living background: writes played notes on its lower staff
  function press(midi, vel) {
    if (isLocked(midi)) { flashWrong(midi); return; }
    try { engine.noteOn(midi, vel); } catch (err) { console.warn(err); }
    if (bgWrite) bgWrite(midi);
    state.held.add(midi);
    const k = keyEls.get(midi); if (k) k.classList.add('down');
    onNotePlayed(midi);
  }
  function release(midi) {
    if (!state.held.has(midi)) return;
    state.held.delete(midi);
    engine.noteOff(midi);
    if (bgRelease) bgRelease(midi);
    const k = keyEls.get(midi); if (k) k.classList.remove('down');
    if (state.mode === 'learn') EX.onRelease(midi);
  }
  function flashWrong(midi) {
    const k = keyEls.get(midi); if (!k) return;
    k.classList.add('wrong'); setTimeout(() => k.classList.remove('wrong'), 250);
  }
  // Exercises tab (js/exercises.js): it reads the keyboard through press/release above.
  const EX = window.Exercises.create({ $, el, engine, keyEls, settings, store, held: state.held, flashWrong,
    range: () => [state.kbStart, state.kbStart + 12 * state.octaves], renderKeys: () => renderKeys(),
    scaleNow: () => [state.scale.root, state.scale.id] });
  function isLocked(midi) {
    return state.mode === 'scale' && state.scale.only && !T.scalePitchClasses(state.scale.root, state.scale.id).includes(T.mod12(midi));
  }

  // What the keyboard should show for the current mode.
  // A key can carry several numbers when a phrase repeats a note (e.g. 1 and 3).
  function addBadge(h, m, n, next) {
    const b = h.badges.get(m);
    if (b) { b.ns.push(n); b.next = b.next || next; } else h.badges.set(m, { n, ns: [n], next });
  }
  function highlights() {
    const h = { scale: null, root: null, chord: null, badges: new Map(), degrees: false, locked: false };
    if (state.mode === 'scale') {
      h.scale = new Set(T.scalePitchClasses(state.scale.root, state.scale.id));
      h.root = state.scale.root;
      h.chord = state.scale.chord ? new Set(state.scale.chord.pcs) : null;
      h.degrees = state.scale.degrees;
      h.locked = state.scale.only;
    } else if (state.mode === 'learn') {
      EX.highlights(h);
    } else if (state.mode === 'jam' && state.riff.tab === 'riff') {
      riffHighlights(h);
    } else if (state.mode === 'jam' && state.jam.key) {
      const j = state.jam, key = j.key;
      if ($('g-scale').checked) { h.scale = new Set(T.scalePitchClasses(key.rootPc, key.scaleId)); h.root = key.rootPc; }
      const ch = currentChord();
      if ($('g-chord').checked && ch) h.chord = new Set(ch.pcs);
      if ($('g-suggest').checked) {
        const s = j.sugg;
        // Only the next note (1) and the one after it (2), so it's always clear what to play.
        if (s.idx < s.notes.length) addBadge(h, s.notes[s.idx], 1, true);
        if (s.idx + 1 < s.notes.length && s.notes[s.idx + 1] !== s.notes[s.idx]) addBadge(h, s.notes[s.idx + 1], 2, false);
      }
    }
    return h;
  }

  function renderKeys() {
    const h = highlights();
    for (const [m, k] of keyEls) {
      const pc = T.mod12(m);
      const inScale = h.scale && h.scale.has(pc);
      k.classList.toggle('inscale', !!inScale && !(h.chord && h.chord.has(pc)));
      k.classList.toggle('chordtone', !!(h.chord && h.chord.has(pc)));
      k.classList.toggle('root', h.root === pc && !!h.scale);
      k.classList.toggle('locked', h.locked && !inScale);
      const lbl = k.querySelector('.lbl');
      if (h.degrees && h.scale) lbl.textContent = inScale ? T.DEGREE_NAMES[T.mod12(pc - h.root)] : '';
      else lbl.textContent = state.labels && !h.hideNames ? (BLACK.has(pc) ? T.pcName(pc, h.root) : T.pcName(pc) + (pc === 0 ? Math.floor(m / 12) - 1 : '')) : '';
      const ck = Object.entries(COMPUTER_KEYS).find(([, off]) => state.kbdBase + off === m);
      k.querySelector('.hint').textContent = ck && settings.hints ? ck[0].toUpperCase() : '';
      const old = k.querySelector('.badge'); if (old) old.remove();
      const b = h.badges.get(m);
      if (b) k.append(el('span', { class: 'badge' + (b.next ? ' next' : '') + (b.ns.length > 1 ? ' multi' : '') }, b.ns.join('·')));
    }
    showLights({ scale: !!(h.scale && h.scale.size), chord: !!(h.chord && h.chord.size), next: h.badges.size > 0 });
  }
  // The synth-style display on the keyboard: it only appears while something is lit,
  // and each line lights up together with the keys it describes.
  function showLights(lit) {
    const lcd = $('kbd-legend'); let any = false;
    lcd.querySelectorAll('.lcd-row').forEach((r) => {
      const on = lit[r.dataset.lit]; any = any || on;
      if (r.classList.contains('on') !== on) { r.classList.toggle('on', on); if (on) { r.classList.remove('flick'); void r.offsetWidth; r.classList.add('flick'); } }
    });
    lcd.classList.toggle('show', any);
  }

  // ---------------------------------------------------------------------
  // Note routing to modes
  function onNotePlayed(midi) {
    const pc = T.mod12(midi);
    // Free play: feed the scale identifier.
    state.free.weights[pc] += 1;
    state.free.seq.push(midi);
    if (state.free.seq.length > 32) {
      const old = state.free.seq.shift();
      state.free.weights[T.mod12(old)] -= 1;
    }
    if (state.mode === 'free') renderFree(pc);
    if (state.mode === 'learn') EX.onNote(midi);
    if (state.mode === 'jam' && state.riff.tab === 'riff') riffNote(midi);
    else if (state.mode === 'jam' && state.jam.key) jamNote(midi);
  }

  // ---------------------------------------------------------------------
  // Free Play: scale identifier
  function renderFree(lastPc) {
    const w = state.free.weights;
    const played = w.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0);
    if ($('free-notes')) $('free-notes').replaceChildren(...(played.length ? played.map((pc) => el('span', { class: 'chip' }, T.pcName(pc), el('span', { class: 'rn' }, '×' + w[pc]))) : [el('span', { class: 'note' }, 'Nothing yet.')]));
    const box = $('free-result');
    if (played.length === 0) {
      box.replaceChildren(el('div', { class: 'state' }, el('strong', {}, 'Play a few notes. '), 'Try a melody or a riff you know. After 3 different notes the identifier starts guessing.'));
      return;
    }
    if (played.length < 3) {
      box.replaceChildren(el('div', { class: 'state loading' }, el('strong', {}, 'Listening… '), `${played.length} of 3 different notes so far. Keep going.`));
      return;
    }
    const res = T.identifyScales(w, { limit: 4, lastPc });
    const best = res[0];
    const tied = res.filter((r) => best.score - r.score < 0.02 && r.covered === best.covered);
    let tip = '';
    if (tied.length > 1) {
      const a = T.scalePitchClasses(tied[0].rootPc, tied[0].scaleId), b = T.scalePitchClasses(tied[1].rootPc, tied[1].scaleId);
      const diff = a.filter((pc) => !b.includes(pc)).concat(b.filter((pc) => !a.includes(pc))).map((pc) => T.pcName(pc));
      tip = diff.length ? `Several scales fit. Play ${diff.slice(0, 3).join(' or ')} to tell ${tied[0].label} and ${tied[1].label} apart.`
        : `Same notes as ${tied[1].label}: it depends which note feels like home, ${T.pcName(tied[0].rootPc)} or ${T.pcName(tied[1].rootPc)}.`;
    }
    const why = (r) => r.outside.length
      ? `Fits ${r.covered} of ${r.played} notes; ${r.outside.map((pc) => T.pcName(pc)).join(', ')} ${r.outside.length > 1 ? 'are' : 'is'} outside.`
      : `Fits all ${r.played} notes you played (${T.SCALES[r.scaleId].steps.length}-note scale).`;
    // One fixed-size card: a small lit keyboard showing the scale, its description, and the other
    // candidates as chips. Hovering a chip previews that scale; clicking it opens it in Scale Mode.
    const keys = el('div', { class: 'mini-kbd-box' }), name = el('strong'), desc = el('div', { class: 'why' }), hint = el('div', { class: 'free-tip' }, tip);
    const use = el('button', { class: 'btn small' }, 'Use this scale');
    let shown = best;
    const show = (r) => {
      shown = r;
      keys.replaceChildren(miniKeys(T.scalePitchClasses(r.rootPc, r.scaleId), r.rootPc, played));
      name.textContent = r.label; desc.textContent = why(r);
      chips.forEach((c, i) => c.classList.toggle('on', res[i] === r));
    };
    use.onclick = () => { setScale(shown.rootPc, shown.scaleId); switchMode('scale'); };
    const chips = res.map((r, i) => el('button', { class: 'chip cand-chip' + (i === 0 ? ' best' : ''), title: 'Click to open in Scale Mode',
      onmouseenter: () => show(r), onfocus: () => show(r), onmouseleave: () => show(best),
      onclick: () => { setScale(r.rootPc, r.scaleId); switchMode('scale'); } }, r.label));
    box.replaceChildren(el('div', { class: 'free-card' }, keys,
      el('div', { class: 'free-info' }, el('div', { class: 'free-head' }, name, use), desc, hint,
        el('div', { class: 'cand-chips' }, el('span', { class: 'note' }, 'Fits:'), ...chips))));
    show(best);
  }
  // A one-octave keyboard diagram: scale notes lit, the root brightest, notes you played dotted.
  function miniKeys(pcs, rootPc, played) {
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    const order = [0, 2, 4, 5, 7, 9, 11, 12], wW = 22, H2 = 70;
    svg.setAttribute('viewBox', `0 0 ${order.length * wW} ${H2}`); svg.setAttribute('class', 'mini-kbd'); svg.setAttribute('aria-hidden', 'true');
    const key = (pc, x, y, w, h, black) => {
      const r = document.createElementNS(NS, 'rect'), on = pcs.includes(pc % 12);
      Object.entries({ x, y, width: w, height: h, rx: 3 }).forEach(([k, v]) => r.setAttribute(k, v));
      r.setAttribute('class', 'mk' + (black ? ' black' : '') + (on ? ' on' : '') + (on && pc % 12 === rootPc ? ' root' : ''));
      svg.append(r);
      if (played.includes(pc % 12)) {
        const c = document.createElementNS(NS, 'circle');
        Object.entries({ cx: x + w / 2, cy: y + h - (black ? 7 : 9), r: black ? 3 : 3.6 }).forEach(([k, v]) => c.setAttribute(k, v));
        c.setAttribute('class', 'mk-dot'); svg.append(c);
      }
    };
    order.forEach((pc, i) => key(pc, i * wW + 1, 1, wW - 2, H2 - 2, false));
    [[1, 0], [3, 1], [6, 3], [8, 4], [10, 5]].forEach(([pc, after]) => key(pc, (after + 1) * wW - 7, 1, 14, 42, true));
    return svg;
  }
  // The scale identifier can be switched off for plain free playing (remembered).
  function applyFreeIdent() {
    const on = settings.freeIdent !== false;
    $('free-ident').checked = on; $('free-result').hidden = !on;
    $('mode-free').classList.toggle('ident-off', !on);
    if (on) renderFree();
  }
  // Staff follow-along (Settings): writing played notes and Jam Mode's notes on the background staff.
  function applyStaff() {
    $('set-staff').checked = settings.staff !== false;
    $('set-staff-marks').checked = settings.staffMarks !== false;
    $('set-staff-jam').checked = settings.staffJam !== false;
    document.body.classList.toggle('no-staff', !staffEnabled());
    document.body.classList.toggle('no-jam-staff', settings.staffJam === false);
  }
  $('set-staff').onchange = () => { setting('staff', $('set-staff').checked); applyStaff(); };
  $('set-staff-marks').onchange = () => setting('staffMarks', $('set-staff-marks').checked);
  $('set-staff-jam').onchange = () => { setting('staffJam', $('set-staff-jam').checked); applyStaff(); };

  // Settings › Song analysis (the optional AI helper).
  function applyEngine() {
    $('set-engine').value = settings.engine === 'helper' ? 'helper' : 'builtin';
    $('set-helper-url').value = window.MT_DESKTOP ? (window.MT_DESKTOP.helper || '') : settings.helperUrl;
    $('set-helper-sep').checked = !!settings.helperSep;
    const on = settings.engine === 'helper';
    $('set-helper-sep').closest('label').hidden = !on; // the address is also used by Jam Mode › Instruments
  }
  async function checkHelper() {
    const st = $('set-helper-status');
    st.textContent = 'Checking…';
    const h = await window.AIHelper.health(settings.helperUrl);
    st.textContent = h.ok ? `Connected: models loaded on the ${h.device === 'cpu' ? 'CPU' : 'GPU'}${h.demucs ? ', Demucs installed' : ''}.`
      : h.loading ? 'The helper is running and still loading its models. Try again in a moment.'
      : (h.error || 'Not connected.') + (h.unreachable ? ' Start it with start-windows.bat (or start.sh) in the ai-helper folder.' : '');
    return h;
  }
  $('set-engine').onchange = () => { setting('engine', $('set-engine').value); applyEngine(); if (settings.engine === 'helper') checkHelper(); };
  $('set-helper-sep').onchange = () => setting('helperSep', $('set-helper-sep').checked);
  $('set-helper-url').onchange = async () => {
    const typed = $('set-helper-url').value.trim();
    if (window.MT_DESKTOP) {
      try {
        const res = await fetch('/launcher/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ helper: typed || window.AIHelper.DEFAULT_URL }) });
        if (res.ok) window.MT_DESKTOP.helper = (await res.json()).helper;
      } catch (e) { /* keep the old address */ }
    } else setting('helperUrl', typed);
    applyEngine(); checkHelper();
  };
  $('set-helper-check').onclick = checkHelper;
  applyEngine();
  $('free-ident').onchange = () => { setting('freeIdent', $('free-ident').checked); applyFreeIdent(); };
  $('free-clear').onclick = () => { state.free.weights.fill(0); state.free.seq = []; renderFree(); };
  $('free-example').onclick = () => {
    const riff = [57, 60, 62, 64, 62, 60, 57, 67, 64, 62, 60];
    riff.forEach((m, i) => { setTimeout(() => press(m, 0.7), i * 220); setTimeout(() => release(m), i * 220 + 190); });
  };

  // ---------------------------------------------------------------------
  // Scale Mode
  function fillSelect(sel, items) { sel.replaceChildren(...items.map(([v, t]) => el('option', { value: v }, t))); }
  fillSelect($('scale-root'), T.NOTE_NAMES.map((n, i) => [i, i === 1 || i === 3 || i === 6 || i === 8 || i === 10 ? n + ' / ' + T.FLAT_NAMES[i] : n]));
  fillSelect($('scale-type'), Object.entries(T.SCALES).map(([id, s]) => [id, s.name]));

  function setScale(root, id) {
    state.scale.root = root; state.scale.id = id; state.scale.chord = null;
    $('scale-root').value = root; $('scale-type').value = id;
    renderScale();
  }
  function renderScale() {
    const { root, id } = state.scale;
    const pcs = T.scalePitchClasses(root, id);
    $('scale-title').textContent = T.scaleLabel(root, id);
    $('scale-blurb').textContent = T.SCALES[id].blurb;
    if ($('scale-notes')) $('scale-notes').replaceChildren(...pcs.map((pc, i) => el('span', { class: 'chip scale' + (i === 0 ? ' root' : '') }, T.pcName(pc, root), el('span', { class: 'rn' }, T.DEGREE_NAMES[T.mod12(pc - root)]))));
    $('scale-formula').textContent = T.scaleFormula(id) + '   (W = whole step, H = half step)';
    const chords = T.diatonicChords(root, id);
    $('scale-chords').replaceChildren(...(chords.length ? chords.map((c) => el('button', {
      class: 'chip', 'aria-pressed': state.scale.chord && state.scale.chord.name === c.name ? 'true' : 'false',
      onclick: () => {
        state.scale.chord = state.scale.chord && state.scale.chord.name === c.name ? null : c;
        if (state.scale.chord) { const base = 60 + T.mod12(c.rootPc); c.pcs.forEach((pc, i) => { const m = base + T.mod12(pc - c.rootPc); setTimeout(() => { engine.noteOn(m, 0.6); setTimeout(() => engine.noteOff(m), 900); }, i * 60); }); }
        renderScale();
      },
    }, c.name, el('span', { class: 'rn' }, c.roman))) : [el('span', { class: 'note' }, 'Chord list is shown for 7-note scales. Pentatonic and blues scales are mostly used for melodies and solos.')]));
    renderKeys();
  }
  $('scale-root').onchange = () => setScale(+$('scale-root').value, state.scale.id);
  $('scale-type').onchange = () => setScale(state.scale.root, $('scale-type').value);
  $('scale-only').onchange = () => { state.scale.only = $('scale-only').checked; renderKeys(); };
  $('scale-degrees').onchange = () => { state.scale.degrees = $('scale-degrees').checked; renderKeys(); };
  function scaleRun() {
    const { root, id } = state.scale;
    let base = state.kbStart + 12 + root; if (base + 12 > state.kbStart + 12 * state.octaves) base -= 12;
    const up = T.SCALES[id].steps.map((s) => base + s).concat([base + 12]);
    return up.concat(up.slice(0, -1).reverse());
  }
  $('scale-play').onclick = () => {
    const run = scaleRun();
    run.forEach((m, i) => { setTimeout(() => { const k = keyEls.get(m); if (k) k.classList.add('down'); engine.noteOn(m, 0.7); }, i * 280); setTimeout(() => { const k = keyEls.get(m); if (k) k.classList.remove('down'); engine.noteOff(m); }, i * 280 + 250); });
  };
  // ---------------------------------------------------------------------
  // Jam Mode
  // Song list: demo songs, then songs the user added (kept on this device).
  const LIB = window.SongLibrary;
  async function fillSongs(selectId) {
    const sel = $('jam-demo');
    let mine = [];
    try { mine = await LIB.list(); } catch (e) { /* storage unavailable: demos only */ }
    sel.replaceChildren(
      el('optgroup', { label: 'Demo songs' }, A.DEMO_SONGS.map((s) => el('option', { value: 'demo:' + s.id }, s.title))),
      mine.length ? el('optgroup', { label: 'Your songs' }, mine.map((s) => el('option', { value: s.id }, s.name))) : null);
    if (selectId) sel.value = selectId;
    syncSongButtons();
  }
  function syncSongButtons() {
    const v = $('jam-demo').value || '';
    $('jam-song-remove').hidden = !v.startsWith('song:');
    $('jam-song-reanalyze').hidden = !v.startsWith('song:');
    $('jam-demo-load').textContent = v.startsWith('song:') ? 'Open song' : 'Analyze demo';
  }
  $('jam-demo').onchange = syncSongButtons;
  fillSongs();
  fillSelect($('jam-key-root'), T.NOTE_NAMES.map((n, i) => [i, BLACK.has(i) ? n + ' / ' + T.FLAT_NAMES[i] : n]));
  fillSelect($('jam-key-scale'), Object.entries(T.SCALES).map(([id, s]) => [id, s.name]));

  const STAGES = [['prepare', 'Reading audio'], ['listen', 'Listening for notes'], ['key', 'Finding the key'], ['tempo', 'Finding the tempo'], ['chords', 'Following the chords'], ['sections', 'Mapping sections'], ['riff', 'Learning the riff']];

  function jamState(kind, content) {
    state.jam.status = kind;
    // Once a song is loaded the intro and drop zone step aside to make room for the jam staff (the panel still takes drops).
    $('jam-drop').hidden = $('jam-lead').hidden = kind === 'success' || kind === 'uncertain';
    $('jam-state').replaceChildren(...(content ? [content] : []));
  }

  function renderJamEmpty() {
    jamState('empty', el('div', { class: 'state' }, el('strong', {}, 'No song loaded. '),
      'Pick a demo song or upload your own audio. Analysis runs on this device, so your file is never uploaded.'));
    $('jam-result').hidden = true;
  }

  async function loadSelected(forceAnalyze) {
    const v = $('jam-demo').value || '';
    if (!v.startsWith('song:')) return loadDemo();
    let rec;
    try { rec = await LIB.get(v); } catch (e) { rec = null; }
    if (!rec) { await fillSongs(); return showJamError({ code: 'decode', message: 'That song is no longer stored on this device. Add it again.' }); }
    return loadFile(rec.blob, { libId: rec.id, name: rec.name, cached: forceAnalyze ? null : rec.analysis });
  }
  $('jam-song-reanalyze').onclick = () => { try { engine.ensure(); } catch (e) { /* ok */ } loadSelected(true); };
  $('jam-song-remove').onclick = async () => {
    const v = $('jam-demo').value;
    if (!v.startsWith('song:')) return;
    try { await LIB.remove(v); } catch (e) { /* ignore */ }
    await fillSongs();
    $('jam-feedback').textContent = 'Removed from your songs.';
  };

  async function loadDemo() {
    const id = ($('jam-demo').value || '').replace(/^demo:/, '');
    const song = A.DEMO_SONGS.find((s) => s.id === id) || A.DEMO_SONGS[0];
    const { samples, sampleRate, left, right } = A.renderDemoSong(song);
    let buffer = null;
    try { buffer = engine.bufferFromSamples(left ? [left, right] : samples, sampleRate); } catch (e) { /* no audio output; analysis still works */ }
    await runAnalysis(samples, sampleRate, buffer, song.title, null, { engine: 'dsp' }); // demos are synthesized; the fast engine is exact on them
  }

  async function loadFile(file, from) {
    if (!file) return;
    from = from || {};
    if (file.type && !file.type.startsWith('audio/')) {
      return showJamError({ code: 'unsupported', message: `"${file.name}" is not an audio file.` });
    }
    if (file.size > 60 * 1024 * 1024) return showJamError({ code: 'too_big', message: 'That file is larger than 60 MB.' });
    // Keep new uploads in the song list for next time.
    if (!from.libId) {
      try { const rec = await LIB.add(file); from = { libId: rec.id, name: rec.name }; await fillSongs(rec.id); } catch (e) { /* storage full or blocked: still analyze */ }
    }
    const name = from.name || file.name;
    showJamLoading(name);
    let buffer;
    try {
      buffer = await engine.decode(await file.arrayBuffer());
    } catch (e) {
      return showJamError({ code: 'decode', message: `The browser could not decode "${file.name}".` });
    }
    // Mix to mono for analysis.
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels; }
    if (from.cached) return showCachedAnalysis(from.cached, buffer, name, from.libId);
    await runAnalysis(mono, buffer.sampleRate, buffer, name, from.libId);
  }

  function showCachedAnalysis(result, buffer, name, libId) {
    if (state.jam.ctl) state.jam.ctl.abort();
    state.jam.ctl = null;
    player.stop(); stopJamLoop();
    result.seconds = 0;
    state.jam.result = result; state.jam.sourceName = name + ' · saved analysis'; state.jam.libId = libId || null;
    player.load(buffer);
    state.jam.keyHistory = [];
    setJamKey(result.key, false);
    showJamResult();
  }

  function showJamLoading(name) {
    const bar = el('i'), list = el('ul', { class: 'stages' }, STAGES.map(([id, t]) => el('li', { 'data-stage': id }, t)));
    const elapsed = el('span', { class: 'mono' }, '0.0 s');
    const cancel = el('button', { class: 'btn small', onclick: () => state.jam.ctl && state.jam.ctl.abort() }, 'Cancel');
    jamState('loading', el('div', { class: 'state loading' },
      el('div', { class: 'row' }, el('strong', {}, 'Analyzing ' + name), elapsed, cancel),
      el('div', { class: 'progress' }, bar), list));
    $('jam-result').hidden = true;
    return { bar, list, elapsed };
  }

  async function runAnalysis(samples, sampleRate, buffer, name, libId, extra) {
    if (state.jam.ctl) state.jam.ctl.abort();
    player.stop(); stopJamLoop();
    const ctl = state.jam.ctl = new AbortController();
    const ui = showJamLoading(name);
    const t0 = performance.now();
    const timer = setInterval(() => { ui.elapsed.textContent = ((performance.now() - t0) / 1000).toFixed(1) + ' s'; }, 100);
    const useHelper = settings.engine === 'helper' && window.AIHelper;
    // The AI helper works alongside the built-in engine (which still finds the notes, riff and tuning).
    const helperJob = useHelper ? window.AIHelper.analyze(samples, sampleRate, { url: settings.helperUrl, separate: settings.helperSep, signal: ctl.signal })
      .catch((e) => ({ error: e })) : null;
    try {
      let result = await A.analyzeSong(samples, sampleRate, {
        ...(extra || {}),
        signal: ctl.signal,
        onStage(stage, p) {
          const i = STAGES.findIndex(([id]) => id === stage);
          ui.list.querySelectorAll('li').forEach((li, k) => { li.className = k < i || stage === 'done' ? 'done' : k === i ? 'active' : ''; });
          const frac = stage === 'done' ? 1 : (i + (p || 0)) / STAGES.length;
          ui.bar.style.width = (frac * 100).toFixed(1) + '%';
        },
      });
      if (helperJob) {
        if (ctl !== state.jam.ctl) return;
        ui.list.querySelectorAll('li').forEach((li) => { li.className = 'done'; });
        ui.list.append(el('li', { class: 'active' }, 'Asking the AI helper (chords, beats, key)'));
        const h = await helperJob;
        if (ctl.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        if (h.error) result.helperError = h.error.message || String(h.error);
        else result = window.AIHelper.merge(result, h);
      }
      result.seconds = (performance.now() - t0) / 1000;
      if (ctl !== state.jam.ctl) return;
      state.jam.result = result; state.jam.sourceName = name; state.jam.libId = libId || null;
      if (libId) LIB.saveAnalysis(libId, result, result.engine || '').catch(() => { /* not cloneable or storage full */ });
      if (buffer) player.load(buffer);
      state.jam.keyHistory = [];
      setJamKey(result.key, false);
      showJamResult();
    } catch (e) {
      if (ctl !== state.jam.ctl) return;
      showJamError(e, { samples, sampleRate, buffer, name });
    } finally {
      clearInterval(timer);
    }
  }

  const ERROR_TEXT = {
    cancelled: ['Analysis stopped.', 'Nothing was changed.'],
    too_short: ['This clip is too short.', 'Use at least 4 seconds of music, ideally a full verse or chorus.'],
    silent: ['The file seems to be silent.', 'Check that it plays in another app, or try a different file.'],
    decode: ['This audio format could not be read.', 'MP3, WAV, OGG and M4A usually work. Convert the file and try again.'],
    unsupported: ['That is not an audio file.', 'Choose an MP3, WAV, OGG or M4A file.'],
    too_big: ['The file is too large for the app.', 'Trim it to a few minutes and try again.'],
  };

  function showJamError(e, retry) {
    state.jam.key = null; state.jam.sugg.notes = []; state.jam.result = null; resetRiff(); renderKeys();
    const [title, help] = ERROR_TEXT[e.code] || ['Something went wrong while analyzing.', e.message || String(e)];
    const actions = el('div', { class: 'row', style: 'margin-top:8px' });
    if (retry && e.code === 'cancelled') actions.append(el('button', { class: 'btn small', onclick: () => runAnalysis(retry.samples, retry.sampleRate, retry.buffer, retry.name) }, 'Start again'));
    actions.append(el('label', { class: 'btn small', for: 'jam-file' }, 'Choose another file'));
    actions.append(el('button', { class: 'btn small', onclick: loadDemo }, 'Use the demo song'));
    actions.append(el('button', { class: 'btn small', onclick: () => manualKey(retry) }, 'Set the key myself'));
    jamState('error', el('div', { class: e.code === 'cancelled' ? 'state' : 'state error' }, el('strong', {}, title + ' '), help, actions));
    $('jam-result').hidden = true;
  }

  // Fallback when analysis fails: the user picks the key and still gets scale guidance.
  function manualKey(retry) {
    const key = { rootPc: 0, scaleId: 'major', label: T.scaleLabel(0, 'major') };
    state.jam.result = { duration: retry && retry.buffer ? retry.buffer.duration : 0, key, keyCandidates: [key], keyConfidence: { level: 'manual' }, tempo: { bpm: null, confidence: 0 }, chords: [], sections: [], manual: true };
    state.jam.sourceName = retry ? retry.name : 'No song';
    if (retry && retry.buffer) player.load(retry.buffer); else player.load(null);
    state.jam.keyHistory = [];
    setJamKey(key, false);
    showJamResult();
  }

  function setJamKey(key, userChange) {
    if (userChange && state.jam.key) state.jam.keyHistory.push(state.jam.key);
    state.jam.key = { rootPc: key.rootPc, scaleId: key.scaleId, label: T.scaleLabel(key.rootPc, key.scaleId) };
    $('jam-key-root').value = key.rootPc; $('jam-key-scale').value = key.scaleId;
    $('jam-key-undo').hidden = !state.jam.keyHistory.length;
    const r = state.jam.result;
    const isDetected = r && r.key.rootPc === key.rootPc && r.key.scaleId === key.scaleId;
    $('jam-key-note').textContent = r && r.manual ? 'You set this key.' : isDetected ? 'This is the detected key.' : 'You changed the detected key (' + r.key.label + ').';
    // Recompute roman numerals against the active key.
    if (r) { const dia = T.diatonicChords(key.rootPc, key.scaleId); r.chords.forEach((c) => { const d = dia.find((x) => x.rootPc === c.rootPc && x.quality === c.quality); c.roman = d ? d.roman : null; }); }
    state.jam.chordIdx = -1;
    newSuggestion(false);
    if (r) renderJamFacts();
  }

  function renderJamFacts() {
    const r = state.jam.result, key = state.jam.key;
    $('jam-key').textContent = key.label.replace(' (Ionian)', '').replace('Natural Minor (Aeolian)', 'Minor');
    const lvl = r.keyConfidence.level;
    const changed = r.key.rootPc !== key.rootPc || r.key.scaleId !== key.scaleId;
    $('jam-key-conf').textContent = r.manual || changed ? 'Set by you' : { high: 'Clear match', medium: 'Likely, check by ear', low: 'Unsure, check by ear' }[lvl];
    $('jam-bpm').textContent = r.tempo.bpm ? Math.round(r.tempo.bpm) + ' BPM' : '–';
    $('jam-bpm-conf').textContent = !r.tempo.bpm ? 'No steady beat found' : r.tempo.confidence > 0.5 ? 'Steady beat' : 'Beat is hard to follow';
    $('jam-len').textContent = fmtTime(r.duration || 0);
    $('jam-src').textContent = state.jam.sourceName + (r.seconds ? ` · analyzed in ${r.seconds.toFixed(1)} s` : '');
    const tu = r.tuning;
    $('jam-hz').textContent = tu && tu.a4 ? 'A4 = ' + tu.a4.toFixed(1) + ' Hz' : '–';
    $('jam-hz-note').textContent = !tu || !tu.a4 ? 'Not measured' : Math.abs(tu.cents) < 3 ? 'Standard pitch' + (tu.confidence < 0.5 ? ' (unsure)' : '')
      : `${tu.cents > 0 ? '+' : ''}${Math.round(tu.cents)} cents vs 440 Hz` + (tu.confidence < 0.5 ? ' (unsure)' : '');
    $('gtr-ref-song').disabled = !(tu && tu.a4);
    $('gtr-ref-song').textContent = tu && tu.a4 ? `Match the song (${tu.a4.toFixed(1)} Hz)` : 'Match the song';
    renderTimeline();
    updateJamNow();
  }

  function showJamResult(opts) {
    const keep = opts && opts.keep;   // re-analysis of the same song: leave the tempo and the instruments alone
    const r = state.jam.result;
    $('jam-result').hidden = false;
    $('jam-seek').max = r.duration || 0;
    const conf = r.keyConfidence;
    if (r.manual) {
      jamState('uncertain', el('div', { class: 'state uncertain' }, el('strong', {}, 'Manual key mode. '),
        'Choose the key below. Scale highlighting works; chord tones and suggestions need a successful analysis.'));
    } else if (conf.level !== 'high' || conf.relativeTie) {
      const alts = r.keyCandidates.slice(1);
      jamState('uncertain', el('div', { class: 'state uncertain' },
        el('strong', {}, `Not sure about the key. `),
        `Best guess is ${r.key.label}. It could also be ${alts.map((a) => a.label).join(' or ')}. Play along and switch if the highlighted notes clash.`,
        el('div', { class: 'row', style: 'margin-top:8px' }, alts.map((a) => el('button', { class: 'btn small', onclick: () => setJamKey(a, true) }, 'Try ' + a.label)))));
    } else {
      const rel = r.keyCandidates[1];
      jamState('success', el('div', { class: 'state' }, el('strong', {}, `Found the key: ${r.key.label}. `),
        `The chords and melody point clearly to this key. ${rel ? 'Runner-up: ' + rel.label + '.' : ''} Press Play and follow the lit keys.`));
    }
    renderJamFacts();
    renderEngineInfo();
    resetRiff();
    if (keep) { tempoLabel(); metro.resync(); syncMetro(); } else setTempo(100);
    renderStems();
  }

  // Advanced: which engine answered, and the built-in vs AI helper answers side by side.
  function renderEngineInfo() {
    const r = state.jam.result;
    const fail = $('jam-helper-fail'), box = $('jam-compare');
    fail.hidden = !(r && r.helperError);
    if (r && r.helperError) fail.textContent = 'The AI helper wasn\'t used, so this is the built-in analysis. ' + r.helperError + (/reach/.test(r.helperError) ? ' Start it with start-windows.bat in the ai-helper folder, then press Analyze again.' : '');
    box.hidden = !(r && r.builtIn);
    if (!r || !r.builtIn) return;
    const h = r.helper, b = r.builtIn;
    $('jam-engine-note').textContent = `Analyzed by the AI helper (${h.engine}, ${h.device === 'cpu' ? 'CPU' : 'GPU'}, ${h.seconds.toFixed(1)} s). Compare with the built-in engine`;
    const chordList = (cs) => { const out = []; for (const c of cs) { if (out[out.length - 1] !== c.name) out.push(c.name); if (out.length >= 10) break; } return out.join(' '); };
    const bpm = (t) => (t && t.bpm ? Math.round(t.bpm) + ' BPM' : '–');
    const mm = h.madmomKey ? T.scaleLabel(h.madmomKey.rootPc, h.madmomKey.scaleId) : null;
    const rows = [
      ['Key', b.key.label, r.key.label + (mm && mm !== r.key.label ? ` (madmom's key model: ${mm})` : '')],
      ['Tempo', bpm(b.tempo), bpm(r.tempo)],
      ['Chords', b.chords.length + ' changes', r.chords.length + ' changes'],
      ['First chords', chordList(b.chords), chordList(r.chords)],
    ];
    if (h.warnings && h.warnings.length) rows.push(['Notes', '', h.warnings.join(' ')]);
    $('jam-compare-rows').replaceChildren(...rows.map(([k, x, y]) => el('tr', {}, el('th', {}, k), el('td', {}, x), el('td', {}, y))));
  }

  function renderTimeline() {
    const r = state.jam.result, dur = r.duration || 1;
    const pct = (t) => (100 * t / dur) + '%';
    $('jam-sections').replaceChildren(...r.sections.map((s) => el('div', { class: 'seg sec', style: `left:${pct(s.start)};width:calc(${pct(s.end - s.start)} - 2px)`, title: 'Section ' + s.label }, 'Section ' + s.label)));
    $('jam-chords').replaceChildren(...r.chords.map((c, i) => el('div', {
      class: 'seg' + (c.roman ? '' : ' outside') + (i === state.jam.chordIdx ? ' now' : ''),
      style: `left:${pct(c.start)};width:calc(${pct(c.end - c.start)} - 2px)`, title: c.name + (c.roman ? ' (' + c.roman + ')' : ' (outside the key)'),
      onclick: () => { player.seek(c.start); updateJamNow(); },
    }, c.name)));
    if (!r.chords.length) $('jam-chords').append(el('span', { class: 'note' }, r.manual ? 'No chord map in manual mode.' : 'No chords detected.'));
  }

  function currentChord() {
    const r = state.jam.result; if (!r || !r.chords.length) return null;
    const t = player.heard;
    return r.chords.find((c) => t >= c.start && t < c.end) || (t < r.chords[0].start ? r.chords[0] : null);
  }

  // Where suggestions are placed: the middle of the keyboard, or around the guitar player's hand.
  function suggRange() {
    if (state.riff.tab === 'guitar') return guitarSuggRange();
    const lo = state.kbStart + 12;
    return [lo, Math.min(state.kbStart + 12 * state.octaves, lo + 19)];
  }

  // The player went their own way with an in-key note: keep the notes they already played,
  // and rebuild the rest of the phrase from the note they chose so it still fits the chord.
  function adaptSuggestion(midi) {
    const j = state.jam, s = j.sugg, key = j.key, ch = currentChord();
    const left = Math.max(2, s.notes.length - s.idx);
    const [lo, hi] = suggRange();
    const rest = T.suggestPhrase({ scalePcs: T.scalePitchClasses(key.rootPc, key.scaleId), chordPcs: ch ? ch.pcs : [key.rootPc],
      lowMidi: Math.min(lo, midi), highMidi: Math.max(hi, midi), length: left + 1, seed: s.seed + s.notes.length * 13 + midi, start: midi });
    // Restart the numbering from the note just played so number keys 1–9 keep working.
    s.notes = [midi].concat(rest.slice(1));
    s.idx = 1;
  }

  function newSuggestion(regenerate) {
    const j = state.jam, s = j.sugg;
    if (regenerate) { s.history.push(s.seed); s.seed = (s.seed * 31 + 7) % 100000; }
    const key = j.key; if (!key) return;
    const ch = currentChord();
    const [lo, hi] = suggRange();
    const cIdx = j.result ? j.result.chords.indexOf(ch) : 0;
    s.notes = T.suggestPhrase({ scalePcs: T.scalePitchClasses(key.rootPc, key.scaleId), chordPcs: ch ? ch.pcs : [key.rootPc], lowMidi: lo, highMidi: hi, length: settings.phraseLen, seed: s.seed + cIdx * 97 });
    s.idx = 0;
    if (state.riff.tab === 'guitar') renderFretboard();
    $('g-undo').disabled = !s.history.length;
    renderKeys();
  }
  $('g-regen').onclick = () => newSuggestion(true);
  $('g-undo').onclick = () => { const s = state.jam.sugg; if (s.history.length) { s.seed = s.history.pop(); newSuggestion(false); } };
  ['g-scale', 'g-chord', 'g-suggest'].forEach((id) => { $(id).onchange = renderKeys; });

  function jamNote(midi) {
    const j = state.jam, s = j.sugg, fb = $('jam-feedback');
    const pcs = T.scalePitchClasses(j.key.rootPc, j.key.scaleId);
    const expected = s.notes[s.idx];
    const same = midi === expected || (state.riff.tab === 'guitar' && expected != null && T.mod12(midi) === T.mod12(expected));
    if ($('g-suggest').checked && s.notes.length && same) {
      s.idx++;
      if (s.idx >= s.notes.length) { fb.textContent = 'Phrase complete! Here is another one.'; fb.className = 'feedback good'; s.history.push(s.seed); s.seed = (s.seed * 31 + 7) % 100000; newSuggestion(false); return; }
      fb.textContent = 'Nice. Now play the key marked 1.'; fb.className = 'feedback good';
      renderKeys(); if (state.riff.tab === 'guitar') renderFretboard();
    } else if (!pcs.includes(T.mod12(midi))) {
      fb.textContent = `${T.pcName(T.mod12(midi), j.key.rootPc)} is outside ${j.key.label}. It adds tension; slide to a lit key to resolve it.`; fb.className = 'feedback bad';
    } else if ($('g-suggest').checked && s.notes.length) {
      adaptSuggestion(midi);
      fb.textContent = `${T.pcName(T.mod12(midi), j.key.rootPc)} fits the key too. The suggestion now continues from there.`; fb.className = 'feedback good';
      renderKeys(); if (state.riff.tab === 'guitar') renderFretboard();
    }
  }

  // Playback loop keeps the playhead, current chord and suggestions in sync.
  let raf = 0;
  function jamLoop() { updateJamNow(); raf = requestAnimationFrame(jamLoop); }
  function stopJamLoop() { cancelAnimationFrame(raf); raf = 0; }
  function updateJamNow() {
    const r = state.jam.result; if (!r) return;
    const t = player.heard;
    $('jam-time').textContent = fmtTime(t) + ' / ' + fmtTime(r.duration || 0);
    if (document.activeElement !== $('jam-seek')) $('jam-seek').value = t;
    $('jam-playhead').style.left = (100 * t / (r.duration || 1)) + '%';
    const ch = currentChord();
    const idx = ch ? r.chords.indexOf(ch) : -1;
    if (idx !== state.jam.chordIdx) {
      state.jam.chordIdx = idx;
      $('jam-chord').textContent = ch ? ch.name : '–';
      $('jam-chord-rn').textContent = ch ? (ch.roman ? 'Chord ' + ch.roman + ' of the key' : 'Borrowed from outside the key') : '';
      $('jam-chords').querySelectorAll('.seg').forEach((n, i) => n.classList.toggle('now', i === idx));
      newSuggestion(false);
    }
    riffTick(t);
  }
  $('jam-play').onclick = () => {
    if (!player.buffer) { $('jam-feedback').textContent = 'No audio to play. You can still jam with the highlighted keys.'; return; }
    if (player.playing) { player.pause(); $('jam-play').textContent = '▶ Play'; stopJamLoop(); updateJamNow(); }
    else { player.play(); $('jam-play').textContent = '❚❚ Pause'; if (!raf) jamLoop(); player.prepare(); }
    syncMetro();
  };
  $('jam-stop').onclick = () => { player.stop(); $('jam-play').textContent = '▶ Play'; stopJamLoop(); updateJamNow(); syncMetro(); };
  player.onEnded = () => { $('jam-play').textContent = '▶ Play'; stopJamLoop(); updateJamNow(); syncMetro(); };
  $('jam-seek').oninput = () => { player.seek(+$('jam-seek').value); updateJamNow(); metro.resync(); };

  // Tempo: 50–150% of the song's speed. The pitch stays the same (time-stretching), where the browser allows it.
  function tempoLabel() {
    const r = state.jam.result, pct = Math.round(player.rate * 100);
    const bpm = r && r.tempo && r.tempo.bpm;
    $('jam-tempo-val').textContent = (bpm ? Math.round(bpm * player.rate) + ' BPM · ' : '') + pct + '%';
    $('jam-tempo-reset').hidden = pct === 100;
    const note = $('jam-tempo-note');
    note.hidden = !(pct !== 100 && player.stretchState === 'failed');
    note.textContent = 'This browser can\u2019t keep the pitch when the tempo changes, so slower also sounds lower.';
  }
  function setTempo(pct, fromSlider) {
    pct = Math.max(50, Math.min(150, Math.round(pct)));
    if (!fromSlider) $('jam-tempo').value = pct;
    const rate = pct / 100;
    if (rate !== 1 && player.stretchState === 'idle' && player.buffer) {
      // Load the time-stretcher, then restart the sound through it.
      player.prepare().then(() => { if (player.playing && player.rate !== 1) { player.pause(); player.play(); metro.resync(); } tempoLabel(); });
    }
    player.setRate(rate);
    metro.resync(); syncMetro(); tempoLabel();
  }
  $('jam-tempo').oninput = () => setTempo(+$('jam-tempo').value, true);
  $('jam-tempo-reset').onclick = () => setTempo(100);

  // ---------------------------------------------------------------------
  // Metronome (next to the Instrument picker). In Jam Mode it can follow the song's own beats,
  // and a row of lights under the transport shows the beat.
  const mod = (a, n) => ((a % n) + n) % n;
  const gridCache = new WeakMap();
  function songBeats() {
    const r = state.jam.result;
    if (!r || r.manual) return null;
    if (gridCache.has(r)) return gridCache.get(r);
    let beats = r.beats || (r.tempo && r.tempo.beats), down = r.downbeat;
    // The fast engine (demo songs) gives only a tempo: lay its beats out from the first chord, which starts a bar.
    if ((!beats || beats.length < 4) && r.tempo && r.tempo.bpm && r.tempo.confidence > 0.15) {
      const step = 60 / r.tempo.bpm, first = (r.chords && r.chords[0] ? r.chords[0].start : 0) % step;
      beats = []; for (let t = first; t < (r.duration || 0); t += step) beats.push(t);
      if (down == null) down = r.chords && r.chords[0] ? r.chords[0].start : first;
    }
    let g = null;
    if (beats && beats.length >= 4) {
      const bpb = (r.helper && r.helper.beatsPerBar) || 4;
      let di = 0;
      if (down != null) { let best = Infinity; beats.forEach((b, i) => { const d = Math.abs(b - down); if (d < best) { best = d; di = i; } }); }
      g = { beats, bpb, di };
    }
    gridCache.set(r, g);
    return g;
  }
  // AudioContext times of the song's beats between two context times, while the song plays.
  function songGrid(from, to) {
    const g = songBeats(); if (!g || !player.playing) return [];
    const d = player._delay(), rate = player.rate;
    const s0 = player.offset + (from - player.startedAt - d) * rate, s1 = player.offset + (to - player.startedAt - d) * rate;
    const out = [], b = g.beats;
    let lo = 0, hi = b.length; while (lo < hi) { const m = (lo + hi) >> 1; if (b[m] < s0) lo = m + 1; else hi = m; }
    for (let i = lo; i < b.length && b[i] < s1; i++) out.push({ time: player.startedAt + d + (b[i] - player.offset) / rate, beat: mod(i - g.di, g.bpb) });
    return out;
  }
  const followingSong = () => settings.metroFollow && state.mode === 'jam' && !!songBeats();
  function metroBpm() {
    const r = state.jam.result;
    if (followingSong() && r.tempo && r.tempo.bpm) return r.tempo.bpm * player.rate;
    return settings.metroBpm;
  }
  function syncMetro() {
    const follow = followingSong(), g = follow ? songBeats() : null;
    metro.bpm = metroBpm();
    metro.beatsPerBar = g ? g.bpb : settings.metroBpb;
    metro.sound = settings.metroSound;
    metro.setGrid(follow && player.playing ? songGrid : null);
    $('metro-label').textContent = Math.round(metro.bpm);
    $('jam-beats').hidden = !(metro.on && state.mode === 'jam');
    $('jam-beat-src').textContent = follow ? (player.playing ? 'Following the song' : 'Song tempo') : Math.round(metro.bpm) + ' BPM';
    const dots = $('jam-beat-dots');
    if (dots.childElementCount !== metro.beatsPerBar) dots.replaceChildren(...Array.from({ length: metro.beatsPerBar }, (_, i) => el('i', { class: i === 0 ? 'one' : '' })));
  }
  let metroRaf = 0, metroShown = null;
  function metroLights() {
    metroRaf = metro.on ? requestAnimationFrame(metroLights) : 0;
    const ctx = engine.ctx; if (!ctx) return;
    const q = metro.beatAt(ctx.currentTime - (ctx.outputLatency || 0));
    if (q === metroShown) return;
    metroShown = q;
    const fresh = q && ctx.currentTime - q.time < 60 / Math.max(30, metro.bpm);
    $('metro-led').classList.toggle('on', !!fresh);
    $('metro-led').classList.toggle('one', !!(fresh && q.beat === 0));
    if (!fresh) return;
    $('metro-arm').classList.toggle('right', (q.count || 0) % 2 === 1);   // the pendulum swings on each click
    $('jam-beat-num').textContent = q.beat + 1;
    $('jam-beat-dots').querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i === q.beat));
    $('jam-beats').classList.toggle('one', q.beat === 0);
    setTimeout(() => { if (metroShown === q) $('metro-led').classList.remove('on', 'one'); }, 110);
  }
  function setMetro(on) {
    if (on) { try { engine.ensure(); } catch (e) { return; } metro.setVolume(settings.metroVol); syncMetro(); metro.start(); syncMetro(); if (!metroRaf) metroLights(); }
    else { metro.stop(); $('metro-led').classList.remove('on', 'one'); $('jam-beat-dots').querySelectorAll('i').forEach((d) => d.classList.remove('on')); $('jam-beat-num').textContent = '–'; }
    $('metro-btn').setAttribute('aria-pressed', String(on));
    syncMetro();
  }
  $('metro-btn').onclick = () => setMetro(!metro.on);
  function setMetroMenu(on) { $('metro-pop').hidden = !on; $('metro-more').setAttribute('aria-expanded', String(on)); }
  $('metro-more').onclick = (e) => { e.stopPropagation(); setMetroMenu($('metro-pop').hidden); };
  document.addEventListener('click', (e) => { if (!$('metro-pop').hidden && !e.target.closest('.metro-menu')) setMetroMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('metro-pop').hidden) setMetroMenu(false); });
  function setMetroBpm(v) {
    v = Math.max(30, Math.min(240, Math.round(+v || 100)));
    setting('metroBpm', v); $('metro-bpm').value = v; $('metro-bpm-range').value = v; syncMetro();
  }
  $('metro-bpm-range').oninput = () => setMetroBpm($('metro-bpm-range').value);
  $('metro-bpm').onchange = () => setMetroBpm($('metro-bpm').value);
  const taps = [];
  $('metro-tap').onclick = () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now); if (taps.length > 6) taps.shift();
    if (taps.length < 2) { $('metro-tap-note').textContent = 'Keep tapping…'; return; }
    const gap = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setMetroBpm(60000 / gap);
    $('metro-tap-note').textContent = followingSong() ? 'Set (Jam Mode is following the song)' : '';
  };
  $('metro-bpb').onchange = () => { setting('metroBpb', +$('metro-bpb').value); syncMetro(); };
  $('metro-vol').oninput = () => { setting('metroVol', +$('metro-vol').value); metro.setVolume(settings.metroVol); };
  $('metro-sound').onchange = () => { setting('metroSound', $('metro-sound').checked); syncMetro(); };
  $('metro-follow').onchange = () => { setting('metroFollow', $('metro-follow').checked); metro.resync(); syncMetro(); };
  function applyMetroSettings() {
    $('metro-bpm').value = settings.metroBpm; $('metro-bpm-range').value = settings.metroBpm; $('metro-bpb').value = String(settings.metroBpb);
    $('metro-vol').value = settings.metroVol; $('metro-sound').checked = settings.metroSound; $('metro-follow').checked = settings.metroFollow;
    metro.setVolume(settings.metroVol); syncMetro();
  }
  $('jam-track-vol').oninput = () => { settings.trackVol = +$('jam-track-vol').value; saveSettings(); engine.setTrackVolume(settings.trackVol); $('set-track-vol').value = settings.trackVol; };
  $('jam-demo-load').onclick = () => { try { engine.ensure(); } catch (e) { /* analysis works without sound */ } loadSelected(false); };
  $('jam-file').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };
  const drop = $('jam-drop'), dropArea = drop.closest('section') || drop;
  dropArea.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  dropArea.addEventListener('dragleave', (e) => { if (!dropArea.contains(e.relatedTarget)) drop.classList.remove('over'); });
  dropArea.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  const keyChange = () => setJamKey({ rootPc: +$('jam-key-root').value, scaleId: $('jam-key-scale').value }, true);
  $('jam-key-root').onchange = keyChange; $('jam-key-scale').onchange = keyChange;
  $('jam-key-undo').onclick = () => { const prev = state.jam.keyHistory.pop(); if (prev) setJamKey(prev, false); };


  // ---------------------------------------------------------------------
  // Riff Mode: learn the song's repeating riff on the keys
  const riffOf = () => (state.jam.result && state.jam.result.riff) || null;
  const riffMidi = (n) => n.midi + 12 * state.riff.shift;
  const riffTime = (o, n, r) => o.start + n.step * (o.stepSec || r.stepSec);

  document.querySelectorAll('.subtab[data-jt]').forEach((b) => { b.onclick = () => setJamTool(b.dataset.jt); });
  function setJamTool(tab) {
    state.riff.tab = tab;
    document.querySelectorAll('.subtab[data-jt]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.jt === tab)));
    $('jam-along').hidden = tab === 'riff';
    $('jam-riff').hidden = tab !== 'riff';
    $('jam-guitar').hidden = tab !== 'guitar';
    $('jam-stems').hidden = tab !== 'stems';
    updateInstrumentView();
    if (tab !== 'riff') newSuggestion(false);
    if (tab === 'stems') renderStems();
    if (tab !== 'riff') stopRiff();
    $('jam-feedback').textContent = '';
    renderRiff();
    renderKeys();
  }

  // ---------------------------------------------------------------------
  // Instruments: the AI helper (Demucs) splits the song into drums, bass, vocals, guitar, piano/keys
  // and everything else, names the instruments it hears, and splits each of those out of its stem
  // (AudioSep) when that's installed; the stems then play in sync with their own mute, solo and volume.
  const STEM_ICONS = { drums: '🥁', 'drum-machine': '🥁', percussion: '🪘', bass: '𝄢', 'double-bass': '𝄢', vocals: '🎤', choir: '🎤', rap: '🎤',
    guitar: '🎸', 'electric-guitar': '🎸', 'acoustic-guitar': '🎸', 'slide-guitar': '🎸', banjo: '🪕', mandolin: '🪕', ukulele: '🎸', sitar: '🪕',
    piano: '🎹', 'electric-piano': '🎹', harpsichord: '🎹', organ: '🎹', synth: '🎛', strings: '🎻', brass: '🎺', saxophone: '🎷',
    flute: '🎶', clarinet: '🎶', woodwinds: '🎶', harp: '🎶', mallets: '🎶', bells: '🔔', accordion: '🪗', harmonica: '🎵', bagpipes: '🎶',
    theremin: '🎵', scratching: '💿', other: '🎛' };
  const stems = { status: 'idle', progress: 0, stage: '', info: null, list: null, error: null, code: null, ctl: null, song: null };
  // Play along / Guitar: "Mute in the song" so you can play that part yourself.
  function renderMuteSelect() {
    const row = $('jam-mute-row'), sel = $('jam-mute');
    const list = stems.status === 'done' && player.stems ? stems.list.filter((x) => x.buffer) : [];
    row.hidden = !list.length;
    if (!list.length) return;
    const cur = player.stems.find((p) => p.mute) || null;
    sel.replaceChildren(el('option', { value: '' }, 'Nothing'), ...list.map((x) => el('option', { value: x.id }, x.label.split(':')[0])));
    sel.value = cur && player.stems.filter((p) => p.mute).length === 1 ? cur.id : '';
  }
  $('jam-mute').onchange = () => {
    if (!player.stems) return;
    const id = $('jam-mute').value;
    player.stems.forEach((p) => player.setStem(p.id, { mute: p.id === id }));
    if (id && !player.useStems) player.setUseStems(true);
    renderStems();
  };
  function resetStems() { if (stems.ctl) stems.ctl.abort(); if (stems.improveCtl) stems.improveCtl.abort(); stems.improve = null; Object.assign(stems, { status: 'idle', progress: 0, stage: '', info: null, list: null, error: null, code: null, ctl: null, song: player.buffer }); }
  async function startStems() {
    if (!player.buffer || !window.AIHelper) return;
    if (stems.ctl) stems.ctl.abort();
    const ctl = stems.ctl = new AbortController(), song = player.buffer;
    Object.assign(stems, { status: 'running', progress: 0, stage: 'Sending the song to the AI helper', error: null, code: null, song });
    renderStems();
    const t0 = performance.now();
    const tick = setInterval(() => { stems.elapsed = (performance.now() - t0) / 1000; renderStemsProgress(); }, 250);
    try {
      const res = await window.AIHelper.separate(song, { url: settings.helperUrl, signal: ctl.signal, auto: settings.stemsAuto !== false,
        onProgress: (p, stage) => { if (stems.ctl === ctl) { stems.progress = p == null ? stems.progress : p; stems.stage = stage || stems.stage; renderStemsProgress(); } } });
      if (stems.ctl !== ctl || player.buffer !== song) return;
      const list = res.stems.filter((x) => x.buffer);
      if (!list.length) throw Object.assign(new Error('The helper found no instruments in this song.'), { code: 'empty' });
      Object.assign(stems, { status: 'done', info: res.info, list: res.stems, seconds: (performance.now() - t0) / 1000 });
      player.setStems(list.map((x) => ({ id: x.id, buffer: x.buffer, mute: false, vol: 1 })));
      metro.resync();
      setTimeout(improveWithStems, 0);
    } catch (e) {
      if (ctl.signal.aborted) { if (stems.ctl === ctl) Object.assign(stems, { status: 'idle' }); }
      else Object.assign(stems, { status: 'error', error: e.message, code: e.code || 'failed' });
    } finally {
      clearInterval(tick);
      if (stems.ctl === ctl) stems.ctl = null;
      renderStems();
    }
  }
  /* Separated instruments make the rest of the analysis better: chords, key and tuning from the
   * pitched instruments without drums or vocals, the beat from the drums and bass, and the riff from
   * each instrument on its own (Riff Mode can switch between them). The AI helper, when it's on, is
   * asked again with its own separation. The first analysis stays available to undo. */
  const IMPROVE_STAGES = { prepare: 'Reading the instruments', listen: 'Listening to the instruments for notes', key: 'Finding the key without drums and vocals',
    tempo: 'Finding the beat from the drums', chords: 'Following the chords', sections: 'Mapping sections', riff: 'Listening to each instrument for the riff', helper: 'Asking the AI helper again', done: 'Done' };
  async function improveWithStems() {
    const r0 = state.jam.result, song = player.buffer;
    if (!r0 || r0.manual || !player.stems || stems.status !== 'done') return;
    const present = (id) => { const x = stems.list.find((v) => v.id === id), p = player.stem(id); return x && x.present && p ? p.buffer.getChannelData(0) : null; };
    const n = player.stems[0].buffer.length, sr = player.stems[0].buffer.sampleRate;
    const sum = (ids) => { let out = null; ids.forEach((id) => { const d = present(id); if (!d) return; out = out || new Float32Array(n); for (let i = 0; i < n && i < d.length; i++) out[i] += d[i]; }); return out; };
    const ids = (...fam) => stems.list.filter((x) => fam.includes(x.family)).map((x) => x.id);
    const harmonic = sum(ids('pitched', 'bass')) || sum(ids('vocals'));
    if (!harmonic) return;
    const beat = ids('drums').some(present) ? sum(ids('drums', 'bass')) : null;
    const riff = [...ids('pitched'), ...ids('bass')].filter((id) => present(id)).map((id) => ({ id, samples: present(id) }));
    if (stems.improveCtl) stems.improveCtl.abort();
    const ctl = stems.improveCtl = new AbortController();
    stems.improve = { status: 'running', stage: IMPROVE_STAGES.prepare, p: 0, prev: stems.improve && stems.improve.prev && stems.improve.song === song ? stems.improve.prev : r0, song };
    renderStems();
    try {
      let res = await A.analyzeSong(harmonic, sr, { parts: { beat, riff }, signal: ctl.signal,
        onStage: (st, p) => { const order = ['prepare', 'listen', 'key', 'tempo', 'chords', 'sections', 'riff', 'done'], i = order.indexOf(st);
          stems.improve.stage = IMPROVE_STAGES[st] || st; stems.improve.p = i < 0 ? stems.improve.p : (i + (p || 0)) / (order.length - 1); renderImproveProgress(); } });
      if (settings.engine === 'helper' && window.AIHelper) {
        stems.improve.stage = IMPROVE_STAGES.helper; renderImproveProgress();
        const mono = new Float32Array(song.length);
        for (let c = 0; c < song.numberOfChannels; c++) { const d = song.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / song.numberOfChannels; }
        try { res = window.AIHelper.merge(res, await window.AIHelper.analyze(mono, song.sampleRate, { url: settings.helperUrl, separate: true, signal: ctl.signal })); }
        catch (e) { if (ctl.signal.aborted) throw e; res.helperError = e.message; }
      }
      if (ctl !== stems.improveCtl || player.buffer !== song) return;
      res.duration = r0.duration;
      res.engine = (res.engine || '') + ' · from the separated instruments';
      res.improved = true;
      res.seconds = r0.seconds;
      const prev = stems.improve.prev;
      stems.improve = { status: 'done', prev, song, changes: describeChanges(prev, res) };
      state.jam.result = res;
      if (state.jam.libId) LIB.saveAnalysis(state.jam.libId, res, res.engine).catch(() => { /* storage full */ });
      state.jam.keyHistory = [];
      setJamKey(res.key, false);
      showJamResult({ keep: true });
    } catch (e) {
      if (ctl.signal.aborted) { if (stems.improve) stems.improve.status = 'idle'; }
      else stems.improve = { status: 'error', error: e.message || String(e), prev: stems.improve.prev, song };
      renderStems();
    } finally { if (stems.improveCtl === ctl) stems.improveCtl = null; }
  }
  function describeChanges(a, b) {
    const out = [];
    const keyA = a.key.label, keyB = b.key.label;
    out.push(keyA === keyB ? 'Key: ' + keyB + ' (same)' : 'Key: ' + keyA + ' → ' + keyB);
    const bpm = (r) => (r.tempo && r.tempo.bpm ? Math.round(r.tempo.bpm) : null);
    if (bpm(b)) out.push(bpm(a) === bpm(b) ? 'Tempo: ' + bpm(b) + ' BPM (same)' : 'Tempo: ' + (bpm(a) || '?') + ' → ' + bpm(b) + ' BPM');
    let same = 0; const ch = b.chords || [];
    ch.forEach((c) => { const mid = (c.start + c.end) / 2, o = (a.chords || []).find((x) => x.start <= mid && x.end > mid); if (o && o.rootPc === c.rootPc && o.quality === c.quality) same++; });
    if (ch.length) out.push('Chords: ' + Math.round(100 * (1 - same / ch.length)) + '% changed');
    const src = b.riff && b.riff.source ? STEM_NAME(b.riff.source) : b.riff ? 'the whole song' : null;
    out.push(b.riff ? 'Riff: ' + b.riff.notes.length + ' notes over ' + b.riff.bars + ' bar' + (b.riff.bars > 1 ? 's' : '') + ', from ' + src + ((b.riff.spb || 8) === 16 ? ', in 16th notes' : '') : 'Riff: none found');
    return out;
  }
  const STEM_NAME = (id) => {
    const x = stems.list && stems.list.find((v) => v.id === id);
    if (x && (x.instruments.length || !['guitar', 'piano', 'other'].includes(id))) return 'the ' + x.label.split(': ').pop().toLowerCase();
    return { mix: 'the whole song', guitar: 'the guitar', piano: 'the piano & keys', other: 'the synths, leads and strings', bass: 'the bass', vocals: 'the vocals', drums: 'the drums' }[id] || id;
  };
  function undoImprove() {
    const im = stems.improve; if (!im || !im.prev) return;
    if (stems.improveCtl) stems.improveCtl.abort();
    state.jam.result = im.prev;
    if (state.jam.libId) LIB.saveAnalysis(state.jam.libId, im.prev, im.prev.engine || '').catch(() => {});
    stems.improve = { status: 'undone', prev: null, song: im.song };
    setJamKey(im.prev.key, false);
    showJamResult({ keep: true });
  }
  function renderImproveProgress() {
    const bar = $('improve-bar'), st = $('improve-stage');
    if (bar) bar.style.width = Math.round(100 * (stems.improve.p || 0)) + '%';
    if (st) st.textContent = stems.improve.stage;
  }
  function improveBox() {
    const im = stems.improve;
    if (!im || im.song !== player.buffer) return null;
    if (im.status === 'running') return el('div', { class: 'state loading' },
      el('div', { class: 'row' }, el('strong', {}, 'Improving the analysis with the separated instruments'), el('button', { class: 'btn small', onclick: () => stems.improveCtl && stems.improveCtl.abort() }, 'Stop')),
      el('div', { class: 'progress' }, el('i', { id: 'improve-bar', style: 'width:' + Math.round(100 * (im.p || 0)) + '%' })), el('p', { class: 'note', id: 'improve-stage', style: 'margin:6px 0 0' }, im.stage));
    if (im.status === 'done') return el('div', { class: 'state' }, el('strong', {}, 'Analysis improved with the separated instruments. '),
      im.changes.join(' · ') + '.',
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small', onclick: undoImprove }, 'Undo: use the first analysis'), el('button', { class: 'btn small', onclick: improveWithStems }, 'Analyze again')));
    if (im.status === 'error') return el('div', { class: 'state error' }, el('strong', {}, 'Could not improve the analysis. '), im.error,
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small', onclick: improveWithStems }, 'Try again')));
    if (im.status === 'undone' || im.status === 'idle') return el('div', { class: 'state' }, 'Using the first analysis. ',
      el('button', { class: 'btn small', onclick: improveWithStems }, 'Improve it with the instruments'));
    return null;
  }

  function renderStemsProgress() {
    const bar = document.querySelector('#stems-state .progress i'), st = $('stems-stage'), tm = $('stems-elapsed');
    if (bar) bar.style.width = Math.round(100 * (stems.progress || 0)) + '%';
    if (st) st.textContent = stems.stage + (stems.progress > 0 && stems.progress < 1 ? ' · ' + Math.round(100 * stems.progress) + '%' : '');
    if (tm) tm.textContent = (stems.elapsed || 0).toFixed(0) + ' s';
  }
  function renderStems() {
    const box = $('stems-state'), mix = $('stems-mixer'), r = state.jam.result;
    if (stems.song !== player.buffer && stems.status !== 'running') resetStems();
    mix.hidden = stems.status !== 'done';
    renderMuteSelect();
    if (!r || !player.buffer) {
      box.replaceChildren(el('div', { class: 'state' }, el('strong', {}, 'No song loaded. '), 'Load a song above, then split it into its instruments here.'));
      return;
    }
    if (stems.status === 'running') {
      box.replaceChildren(el('div', { class: 'state loading' },
        el('div', { class: 'row' }, el('strong', {}, 'Separating the instruments'), el('span', { class: 'mono', id: 'stems-elapsed' }, '0 s'),
          el('button', { class: 'btn small', onclick: () => stems.ctl && stems.ctl.abort() }, 'Cancel')),
        el('div', { class: 'progress' }, el('i')), el('p', { class: 'note', id: 'stems-stage', style: 'margin:6px 0 0' }, stems.stage),
        el('p', { class: 'note', style: 'margin:4px 0 0' }, 'With an NVIDIA graphics card this takes a few seconds; on the processor alone, about a minute per minute of song. You can keep playing meanwhile.')));
      renderStemsProgress();
      return;
    }
    if (stems.status === 'error') {
      const how = stems.code === 'unreachable'
        ? 'Start the AI helper (double-click start-windows.bat in the ai-helper folder, or sh start.sh), wait for "Ready", then try again.'
        : stems.code === 'no_demucs' ? 'Run setup-windows.bat (or sh setup.sh) in the ai-helper folder again and answer y when it asks about Demucs.'
        : stems.code === 'old_helper' ? 'Replace the ai-helper folder with the one from the new download, then run its setup again.' : '';
      box.replaceChildren(el('div', { class: 'state error' }, el('strong', {}, 'Could not separate the instruments. '), stems.error + (how ? ' ' + how : ''),
        el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small primary', onclick: startStems }, 'Try again'))));
      return;
    }
    if (stems.status !== 'done') {
      box.replaceChildren(el('div', { class: 'state' },
        el('strong', {}, 'Split this song into instruments. '),
        'Drums, bass, vocals, guitar, piano and everything else each get their own fader. With "Find the instruments" on, the helper also listens for which instruments play (strings, brass, sax, organ, synth, acoustic or electric guitar and more) and gives each one found its own fader. It runs in the AI helper on your computer.',
        el('label', { class: 'row', style: 'gap:6px;margin-top:8px' }, autoBox(), 'Find the instruments in this song and split each one out'),
        el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small primary', onclick: startStems }, 'Separate instruments'))));
      return;
    }
    const sent = stems.list.filter((x) => x.buffer), missing = stems.list.filter((x) => !x.buffer);
    box.replaceChildren(...[el('div', { class: 'state' }, el('strong', {}, `Separated in ${stems.seconds.toFixed(0)} s. `),
      'Mute (M) or solo (S) an instrument, or turn it down. ' + (missing.length ? `Not in this song: ${missing.map((x) => x.label.split(':')[0].toLowerCase()).join(', ')}.` : '')),
      foundBox(), improveBox()].filter(Boolean));
    const strip = (x) => {
      const p = player.stem(x.id) || {};
      const vol = el('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: p.vol != null ? p.vol : 1, 'aria-label': x.label + ' volume' });
      const pct = el('span', { class: 'mono' }, Math.round(100 * vol.value) + '%');
      vol.oninput = () => { player.setStem(x.id, { vol: +vol.value }); pct.textContent = Math.round(100 * vol.value) + '%'; };
      const mute = el('button', { class: 'btn small mute', 'aria-pressed': String(!!p.mute), title: 'Mute ' + x.label }, 'M');
      const solo = el('button', { class: 'btn small solo', 'aria-pressed': String(!!p.solo), title: 'Solo ' + x.label }, 'S');
      mute.onclick = () => { const on = mute.getAttribute('aria-pressed') !== 'true'; player.setStem(x.id, { mute: on }); mute.setAttribute('aria-pressed', String(on)); };
      solo.onclick = () => { const on = solo.getAttribute('aria-pressed') !== 'true'; player.setStem(x.id, { solo: on }); solo.setAttribute('aria-pressed', String(on)); };
      const [name, detail] = x.label.split(': ');
      return el('div', { class: 'strip' + (x.present ? '' : ' absent') },
        el('span', { class: 'ico', 'aria-hidden': 'true' }, STEM_ICONS[x.id] || STEM_ICONS[x.id.replace(/-rest$/, '')] || '♪'),
        el('span', { class: 'nm' }, el('b', {}, name), el('small', {}, x.present ? (detail || '') + (x.instruments.length > 1 && stems.info && stems.info.recognition && !stems.info.audiosep ? ' · install AudioSep to split these' : '') : 'Very quiet in this song')),
        mute, solo, vol, pct);
    };
    const useMix = el('input', { type: 'checkbox', checked: player.useStems });
    useMix.onchange = () => { player.setUseStems(useMix.checked); metro.resync(); };
    mix.replaceChildren(...sent.filter((x) => x.present).map(strip), ...sent.filter((x) => !x.present).map(strip),
      el('div', { class: 'mix-foot' },
        el('label', { class: 'row', style: 'gap:6px' }, useMix, 'Play the separated instruments (off: the original song)'),
        el('button', { class: 'btn small', onclick: () => { stems.list.forEach((x) => player.setStem(x.id, { vol: 1, mute: false, solo: false })); renderStems(); } }, 'Reset mixer'),
        el('span', { class: 'note' }, stemsNote())));
  }
  function autoBox() {
    const box = el('input', { type: 'checkbox', id: 'stems-auto', checked: settings.stemsAuto !== false });
    box.onchange = () => { settings.stemsAuto = box.checked; saveSettings(); };
    return box;
  }
  // "Found in this song": what the helper recognised, how sure it is, and whether it got its own fader.
  function foundBox() {
    const info = stems.info || {}, list = info.instruments || [];
    if (!info.recognition) return null;
    if (!list.length) return el('div', { class: 'state' }, 'The helper did not recognise any particular instruments in this song.');
    return el('div', { class: 'found' }, el('strong', {}, 'Found in this song'),
      el('div', { class: 'chips' }, ...list.map((f) => el('span', { class: 'chip' + (f.separated ? ' own' : ''), title: Math.round(100 * f.confidence) + '% sure' + (f.share != null ? ', plays in about ' + Math.round(100 * f.share) + '% of the song' : '') + (f.separated ? ', has its own fader' : '') },
        (STEM_ICONS[f.id] || '♪') + ' ' + f.name, el('small', {}, ' ' + Math.round(100 * f.confidence) + '%')))));
  }
  function stemsNote() {
    const info = stems.info || {};
    if (info.notes && info.notes.length) return info.notes.join(' ');
    if (info.audiosep) return 'Each instrument the helper recognised was split out of the stem it shared; what was left is under "the rest" and "Everything else".';
    return 'Synths, lead lines and strings share "Other" unless AudioSep is installed in the AI helper (run its setup again and answer y to AudioSep).';
  }

  // Fit the riff onto the visible keyboard by whole octaves.
  function autoShift(r) {
    const lo = state.kbStart, hi = state.kbStart + 12 * state.octaves;
    const min = Math.min(...r.notes.map((n) => n.midi)), max = Math.max(...r.notes.map((n) => n.midi));
    let sh = 0;
    while (max + 12 * sh > hi && min + 12 * (sh - 1) >= lo - 12) sh--;
    while (min + 12 * sh < lo && max + 12 * (sh + 1) <= hi + 12) sh++;
    return sh;
  }

  function resetRiff() {
    stopRiff();
    const r = riffOf();
    state.riff.shift = r ? autoShift(r) : 0;
    renderRiff();
  }

  function renderRiffSource() {
    const res = state.jam.result, row = $('riff-src-row'), sel = $('riff-src');
    const opts = res && res.riffOptions ? res.riffOptions : null;
    row.hidden = !opts || opts.length < 2;
    if (row.hidden) return;
    const cur = (res.riff && res.riff.source) || 'mix';
    sel.replaceChildren(...opts.map((o) => el('option', { value: o.id, disabled: !o.riff }, STEM_NAME(o.id).replace(/^the /, '').replace(/^./, (c) => c.toUpperCase()) + (o.riff ? '' : ' (no riff found)'))));
    sel.value = cur;
  }
  $('riff-src').onchange = () => {
    const res = state.jam.result, o = res && res.riffOptions && res.riffOptions.find((x) => x.id === $('riff-src').value);
    if (!o || !o.riff) return;
    res.riff = o.riff; res.melody = o.melody;
    resetRiff(); renderKeys();
  };
  /* Riff Mode plays the riff (and your keys) with the sound of the instrument it came from, when the
   * riff was taken from a separated instrument: strings sound like strings, the sax like a sax. */
  function matchedPreset() {
    const r = riffOf(), src = r && r.source;
    if (!src || src === 'mix') return null;
    const x = stems.list && stems.list.find((v) => v.id === src);
    const id = S.INSTRUMENT_PRESET[src] || (x && x.instruments && x.instruments.map((i) => S.INSTRUMENT_PRESET[i]).find(Boolean)) || (x && x.family === 'bass' ? 'bass' : null);
    return id ? { id, name: S.PRESETS[id].name, from: STEM_NAME(src) } : null;
  }
  function syncInstrument() {
    const m = state.mode === 'jam' && state.riff.tab === 'riff' ? matchedPreset() : null;
    const on = !!m && settings.matchInst !== false;
    engine.setOverride(on ? m.id : null);
    $('riff-inst-row').hidden = !m;
    if (m) {
      $('riff-inst-match').checked = on;
      $('riff-inst').textContent = on ? `The keyboard sounds like ${m.from} here (${m.name}).` : `The riff comes from ${m.from}; the keyboard keeps your instrument.`;
    }
    $('preset').value = on ? m.id : engine.preset;
    $('preset').title = on ? 'Riff Mode is using ' + m.name + ' to match ' + m.from : '';
    $('strip-preset').classList.toggle('matched', on);
  }
  $('riff-inst-match').onchange = () => { settings.matchInst = $('riff-inst-match').checked; saveSettings(); syncInstrument(); };
  function renderRiff() {
    renderRiffSource();
    syncInstrument();
    const res = state.jam.result, r = riffOf(), box = $('riff-state');
    $('riff-body').hidden = !r;
    if (!res) { box.replaceChildren(el('div', { class: 'state' }, el('strong', {}, 'No song loaded. '), 'Analyze a song first; Riff Mode then shows its riff here.')); return; }
    if (res.manual) { box.replaceChildren(el('div', { class: 'state' }, el('strong', {}, 'Riff Mode needs a song analysis. '), 'In manual key mode there is no audio to learn from. Load a demo or another file.')); return; }
    if (!r) {
      box.replaceChildren(el('div', { class: 'state uncertain' }, el('strong', {}, 'No repeating riff found. '),
        `I heard ${res.melody ? res.melody.length : 0} lead notes but no pattern that repeats. The lead may be too quiet under the band, or change every time.`,
        el('div', { class: 'row', style: 'margin-top:8px' },
          el('button', { class: 'btn small', onclick: () => setJamTool('along') }, 'Use Play along instead'),
          el('label', { class: 'btn small', for: 'jam-file' }, 'Try another song'))));
      return;
    }
    const doubt = r.unsure + r.offKey;
    const where = r.occurrences.map((o) => fmtTime(o.start)).slice(0, 4).join(', ') + (r.occurrences.length > 4 ? '…' : '');
    box.replaceChildren(doubt || r.confidence < 0.85
      ? el('div', { class: 'state uncertain' }, el('strong', {}, `Riff found, but check ${doubt || 'some'} note${doubt === 1 ? '' : 's'} by ear. `),
          `${r.bars}-bar riff, repeats ${r.occurrences.length} times (${where}). Dashed notes didn't sound the same every time or fall outside the key. Click a note to hear it.`)
      : el('div', { class: 'state' }, el('strong', {}, `Riff found: ${r.notes.length} notes over ${r.bars} bar${r.bars > 1 ? 's' : ''}. `),
          `It repeats ${r.occurrences.length} times in the song (${where}).`));
    drawRoll();
  }

  function drawRoll() {
    const r = riffOf(); if (!r) return;
    const spb = r.spb || 8, roll = $('riff-roll'), steps = r.bars * spb;
    const mids = r.notes.map(riffMidi), lo = Math.min(...mids), hi = Math.max(...mids), span = Math.max(1, hi - lo);
    const kids = [];
    for (let st = 0; st <= steps; st += spb / 4) kids.push(el('div', { class: 'beat' + (st % spb === 0 ? ' bar' : ''), style: `left:${100 * st / steps}%` }));
    const ui = state.riff;
    r.notes.forEach((n, i) => {
      const m = riffMidi(n);
      const cls = 'rn' + (n.agree < 0.75 || !n.inKey ? ' unsure' : '') +
        (ui.active && ui.mode === 'step' ? (i < ui.idx ? ' done' : i === ui.idx ? ' now' : '') : '');
      kids.push(el('button', {
        class: cls, title: T.midiName(m) + (n.inKey ? '' : ' (outside the key)'),
        style: `left:calc(${100 * n.step / steps}% + 1px);width:calc(${100 * n.dur / steps}% - 2px);top:${8 + (hi - m) / span * 116}px`,
        onclick: () => { engine.noteOn(m, 0.8); setTimeout(() => engine.noteOff(m), 350); },
      }, T.midiName(m)));
    });
    kids.push(el('div', { class: 'cursor', id: 'riff-cursor', hidden: true }));
    roll.replaceChildren(...kids);
  }

  $('riff-hear').onclick = () => {
    const r = riffOf(); if (!r) return;
    const sp = 1 / (player.rate || 1);
    r.notes.forEach((n) => {
      const m = riffMidi(n), at = n.step * r.stepSec * sp * 1000, len = n.dur * r.stepSec * sp * 900;
      setTimeout(() => { engine.noteOn(m, 0.8); const k = keyEls.get(m); if (k) k.classList.add('down'); }, at);
      setTimeout(() => { engine.noteOff(m); const k = keyEls.get(m); if (k) k.classList.remove('down'); }, at + len);
    });
  };
  $('riff-jump').onclick = () => {
    const r = riffOf(); if (!r || !player.buffer) return;
    player.seek(Math.max(0, r.occurrences[0].start - r.barSec / 2));
    if (!player.playing) $('jam-play').click(); else updateJamNow();
  };
  $('riff-down').onclick = () => { state.riff.shift--; drawRoll(); renderKeys(); };
  $('riff-up').onclick = () => { state.riff.shift++; drawRoll(); renderKeys(); };
  document.querySelectorAll('input[name="riff-mode"]').forEach((i) => { i.onchange = () => { stopRiff(); state.riff.mode = i.value; riffHelp(); }; });
  function riffHelp() {
    $('riff-help').textContent = state.riff.mode === 'step'
      ? 'Play the key marked 1. The next one lights up when you get it right. Number keys work too.'
      : 'The song plays and the keys light up in time with the riff: play the key marked 1 as it comes round.';
  }

  $('riff-start').onclick = () => {
    const r = riffOf(); if (!r) return;
    Object.assign(state.riff, { active: true, idx: 0, rounds: 0, hits: 0, misses: 0, hitSet: new Set(), sig: '' });
    $('riff-start').hidden = true; $('riff-stop').hidden = false;
    const fb = $('jam-feedback'); fb.className = 'feedback';
    if (state.riff.mode === 'time') {
      if (!player.buffer) { fb.textContent = 'No audio to play along with. Use Step by step instead.'; stopRiff(); return; }
      player.seek(Math.max(0, r.occurrences[0].start - r.barSec));
      if (!player.playing) $('jam-play').click();
      fb.textContent = 'Get ready: the riff starts in one bar.';
    } else {
      fb.textContent = `Play the key marked 1 (${T.midiName(riffMidi(r.notes[0]))}).`;
    }
    drawRoll(); renderKeys();
  };
  $('riff-stop').onclick = () => { stopRiff(); $('jam-feedback').textContent = ''; };
  function stopRiff() {
    const ui = state.riff;
    if (ui.active && ui.mode === 'time' && player.playing) $('jam-play').click();
    ui.active = false;
    $('riff-start').hidden = false; $('riff-stop').hidden = true;
    const c = $('riff-cursor'); if (c) c.hidden = true;
    drawRoll(); renderKeys();
  }

  // Which notes are coming up in "play in time" mode, from the song position.
  function upcomingInTime(t) {
    const r = riffOf(), out = [];
    for (const o of r.occurrences) for (const n of r.notes) {
      const at = riffTime(o, n, r);
      if (at >= t - 0.12 && out.length < 3) out.push({ n, at, o });
    }
    return out;
  }

  function riffHighlights(h) {
    const r = riffOf(); if (!r) return;
    h.scale = new Set(r.notes.map((n) => T.mod12(n.midi)));
    const ui = state.riff;
    if (!ui.active) return;
    if (ui.mode === 'step') {
      for (let i = 0; i < 4 && ui.idx + i < r.notes.length; i++) {
        const m = riffMidi(r.notes[ui.idx + i]);
        addBadge(h, m, i + 1, i === 0);
      }
    } else {
      upcomingInTime(player.heard).forEach((u, i) => { const m = riffMidi(u.n); addBadge(h, m, i + 1, i === 0); });
    }
  }

  function riffTick(t) {
    const r = riffOf(), ui = state.riff;
    if (!r || ui.tab !== 'riff') return;
    const cur = $('riff-cursor');
    const o = r.occurrences.find((x) => t >= x.start && t < x.end);
    if (cur) { cur.hidden = !o; if (o) cur.style.left = (100 * (t - o.start) / (o.end - o.start)) + '%'; }
    if (!ui.active || ui.mode !== 'time') return;
    const up = upcomingInTime(t);
    const sig = up.map((u) => riffMidi(u.n) + '@' + u.at.toFixed(2)).join('|');
    if (sig !== ui.sig) { ui.sig = sig; renderKeys(); }
    if (!up.length) {
      $('jam-feedback').textContent = `That was the last riff in the song. Hits ${ui.hits}, misses ${ui.misses}.` + ($('riff-loop').checked ? ' Starting again…' : '');
      if ($('riff-loop').checked) { player.seek(Math.max(0, r.occurrences[0].start - r.barSec)); ui.hitSet = new Set(); }
      else stopRiff();
    } else if (!o && up[0].at - t > 0.5) {
      $('jam-feedback').textContent = `Riff comes back in ${Math.ceil(up[0].at - t)} s. Hits ${ui.hits}, misses ${ui.misses}.`;
    }
  }

  function riffNote(midi) {
    const r = riffOf(), ui = state.riff, fb = $('jam-feedback');
    if (!r || !ui.active) return;
    if (ui.mode === 'step') {
      const want = riffMidi(r.notes[ui.idx]);
      if (midi === want) {
        ui.idx++;
        if (ui.idx >= r.notes.length) {
          ui.rounds++; ui.idx = 0;
          fb.textContent = `You played the whole riff${ui.rounds > 1 ? ` (${ui.rounds} times)` : ''}! ` + ($('riff-loop').checked ? 'Go again from key 1, or switch to Play in time.' : 'Switch to Play in time to try it with the song.');
          fb.className = 'feedback good';
          if (!$('riff-loop').checked) { stopRiff(); return; }
        } else { fb.textContent = `Good. ${r.notes.length - ui.idx} notes to go.`; fb.className = 'feedback good'; }
      } else {
        fb.textContent = `That was ${T.midiName(midi)}. The key marked 1 is ${T.midiName(want)}.`; fb.className = 'feedback bad';
      }
      drawRoll(); renderKeys();
      return;
    }
    // In time: the nearest riff note within a short window (scaled by playback speed) counts.
    const t = player.heard, tol = 0.22 * player.rate;
    let best = null;
    for (const o of r.occurrences) for (const n of r.notes) {
      const at = riffTime(o, n, r), d = Math.abs(at - t);
      if (d <= tol && (!best || d < best.d)) best = { n, d, key: o.start.toFixed(2) + ':' + n.step };
    }
    if (best && riffMidi(best.n) === midi && !ui.hitSet.has(best.key)) { ui.hits++; ui.hitSet.add(best.key); fb.className = 'feedback good'; fb.textContent = `Hit! ${ui.hits} hits, ${ui.misses} misses.`; }
    else if (best && T.mod12(riffMidi(best.n)) === T.mod12(midi)) { ui.misses++; fb.className = 'feedback bad'; fb.textContent = `Right note, wrong octave: try ${T.midiName(riffMidi(best.n))}.`; }
    else { ui.misses++; fb.className = 'feedback bad'; fb.textContent = best ? `Missed: that one was ${T.midiName(riffMidi(best.n))}.` : `Too early or late. ${ui.hits} hits, ${ui.misses} misses.`; }
  }

  // ---------------------------------------------------------------------
  // Mode switching & shared controls
  function switchMode(mode) {
    // AI Setup lives in Settings now, as a dropdown: going "to" it opens Settings with it expanded.
    if (mode === 'guide') { mode = 'settings'; $('mode-guide').open = true; setTimeout(() => $('mode-guide').scrollIntoView({ block: 'start', behavior: 'smooth' }), 60); }
    state.mode = mode;
    document.body.dataset.mode = mode;
    syncInstrument();
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
    ['free', 'scale', 'jam', 'learn', 'settings'].forEach((m) => { $('mode-' + m).hidden = m !== mode; });
    if (mode === 'learn') EX.render();
    if (mode === 'free') renderFree();
    if (mode === 'scale') renderScale();
    updateInstrumentView();
    renderQuick();
    renderKeys();
    syncMetro();
    store.set('mode', mode);
  }
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = (e) => {
      const was = state.mode;
      switchMode(t.dataset.mode);
      if (calm()) return;
      // A ripple from where the tab was clicked, a little bounce, and the new screen slides in.
      const r = t.getBoundingClientRect(), x = (e.clientX || r.left + r.width / 2) - r.left, y = (e.clientY || r.top + r.height / 2) - r.top;
      const rip = el('span', { class: 'tab-ripple' }); rip.style.left = x + 'px'; rip.style.top = y + 'px'; t.append(rip);
      rip.animate([{ transform: 'translate(-50%,-50%) scale(0)', opacity: 0.7 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 }], { duration: 550, easing: 'ease-out' }).onfinish = () => rip.remove();
      t.animate([{ transform: 'scale(1)' }, { transform: 'scale(.9)', offset: 0.25 }, { transform: 'scale(1.08)', offset: 0.6 }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
      if (was !== t.dataset.mode) {
        const panel = $('mode-' + t.dataset.mode), order = ['free', 'scale', 'jam', 'learn', 'settings'];
        const dir = order.indexOf(t.dataset.mode) > order.indexOf(was) ? 1 : -1;
        panel.animate([{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.3,1)' });
      }
    };
  });
  // The corner of a tab nearest the mouse lights up as the mouse comes close.
  (function tabGlow() {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    let raf = 0, mx = -1e4, my = -1e4;
    function paint() {
      raf = 0;
      for (const t of tabs) {
        const r = t.getBoundingClientRect();
        const dx = Math.max(r.left - mx, 0, mx - r.right), dy = Math.max(r.top - my, 0, my - r.bottom);
        const near = Math.max(0, 1 - Math.hypot(dx, dy) / 70);
        t.style.setProperty('--gx', (mx - r.left).toFixed(0) + 'px'); t.style.setProperty('--gy', (my - r.top).toFixed(0) + 'px');
        t.style.setProperty('--gn', near.toFixed(3));
      }
    }
    window.addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY; if (!raf) raf = requestAnimationFrame(paint); }, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => { mx = my = -1e4; paint(); });
  })();

  $('preset').replaceChildren(...S.GROUPS.map((g) => el('optgroup', { label: g },
    ...Object.entries(S.PRESETS).filter(([, p]) => p.group === g).map(([id, p]) => el('option', { value: id }, p.name)))));
  function setPreset(id) {
    engine.setPreset(id); store.set('preset', id);
    $('preset').value = id;
  }
  // Let go of the dropdown after a pick so the arrow keys go back to the wheels.
  $('preset').onchange = () => {
    if (engine.override) { settings.matchInst = false; saveSettings(); }
    setPreset($('preset').value); $('preset').blur(); syncInstrument();
  };

  // Settings tab
  function applyTheme() {
    if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', settings.theme);
  }
  function applySettings() {
    engine.setVolume(settings.volume); engine.setReverb(settings.reverb); engine.setTrackVolume(settings.trackVol);
    $('volume').value = settings.volume; $('reverb').value = settings.reverb;
    $('set-track-vol').value = settings.trackVol; $('jam-track-vol').value = settings.trackVol;
    $('set-octaves').value = String(state.octaves);
    $('kbd-names').checked = settings.labels; $('kbd-keys').checked = settings.hints;
    $('set-phrase').value = String(settings.phraseLen); $('set-theme').value = settings.theme;
    state.labels = settings.labels;
    applyTheme();
    applyLevel();
    applyFreeIdent();
    applyStaff();
    applyMetroSettings();
    applyAccess();
  }
  // Beginner hides every control marked data-adv in the page; Advanced shows them all.
  function applyLevel() {
    const lvl = settings.level === 'advanced' ? 'advanced' : 'beginner';
    document.documentElement.dataset.level = lvl;
    $('set-level').value = lvl;
    if (lvl === 'beginner') { arrowsHeld.clear(); setBend(0); setMod(0); } // the wheels are Advanced only
    if ($('set-staff')) applyStaff();
  }
  // ---------------------------------------------------------------------
  // Settings › Accessibility: highlight colours (incl. colour-blind palettes), stripes on chord
  // tones, mode colours, high contrast, text size and reduced motion. Colours are CSS variables on
  // <html>; the default palette leaves the stylesheet's own colours in place.
  const PALETTES = {
    okabe: { scale: '#f0e442', chord: '#56b4e9', next: '#d55e00', root: '#0072b2' },
    redgreen: { scale: '#ffb000', chord: '#648fff', next: '#dc267f', root: '#785ef0' },
    blueyellow: { scale: '#ff9aa2', chord: '#00a6a6', next: '#b5001f', root: '#3a0ca3' },
  };
  const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const mixHex = (h, to, a) => { const c = hexRgb(h), t = hexRgb(to); return '#' + c.map((v, i) => Math.round(v + (t[i] - v) * a).toString(16).padStart(2, '0')).join(''); };
  const paletteNow = () => settings.palette === 'custom'
    ? { scale: settings.colScale, chord: settings.colChord, next: settings.colNext, root: settings.colRoot }
    : PALETTES[settings.palette] || null;
  const HL_VARS = ['--sc-w1', '--sc-w2', '--sc-w3', '--sc-b1', '--sc-b2', '--ct-w1', '--ct-w2', '--ct-w3', '--ct-b1', '--ct-b2', '--rt-w', '--rt-b', '--lcd-scale', '--lcd-chord', '--lcd-next', '--suggest', '--accent', '--chord'];
  function applyAccess() {
    const root = document.documentElement, p = paletteNow();
    HL_VARS.forEach((v) => root.style.removeProperty(v));
    if (p) {
      const set = (k, v) => root.style.setProperty(k, v);
      set('--sc-w1', mixHex(p.scale, '#ffffff', 0.35)); set('--sc-w2', p.scale); set('--sc-w3', mixHex(p.scale, '#000000', 0.15));
      set('--sc-b1', mixHex(p.scale, '#000000', 0.3)); set('--sc-b2', mixHex(p.scale, '#000000', 0.6));
      set('--ct-w1', mixHex(p.chord, '#ffffff', 0.35)); set('--ct-w2', p.chord); set('--ct-w3', mixHex(p.chord, '#000000', 0.15));
      set('--ct-b1', mixHex(p.chord, '#000000', 0.3)); set('--ct-b2', mixHex(p.chord, '#000000', 0.6));
      set('--rt-w', p.root); set('--rt-b', mixHex(p.root, '#ffffff', 0.55));
      set('--lcd-scale', p.scale); set('--lcd-chord', p.chord); set('--lcd-next', mixHex(p.next, '#ffffff', 0.25));
      set('--suggest', p.next); set('--accent', mixHex(p.scale, '#000000', 0.3)); set('--chord', mixHex(p.chord, '#000000', 0.25));
    }
    root.dataset.pattern = settings.pattern ? 'on' : 'off';
    root.dataset.modecol = settings.modeCol === 'calm' ? 'calm' : 'colour';
    root.dataset.contrast = settings.contrast ? 'high' : 'normal';
    root.dataset.motion = settings.motion ? 'reduce' : 'system';
    root.style.fontSize = settings.textSize && settings.textSize !== 100 ? settings.textSize + '%' : '';
    $('set-palette').value = PALETTES[settings.palette] || settings.palette === 'custom' ? settings.palette : 'default';
    $('set-palette-custom').hidden = settings.palette !== 'custom';
    const cur = p || { scale: '#f2c96d', chord: '#72cfc6', next: '#e2483d', root: '#8a5a00' };
    $('set-col-scale').value = settings.palette === 'custom' ? settings.colScale : cur.scale;
    $('set-col-chord').value = settings.palette === 'custom' ? settings.colChord : cur.chord;
    $('set-col-next').value = settings.palette === 'custom' ? settings.colNext : cur.next;
    $('set-col-root').value = settings.palette === 'custom' ? settings.colRoot : cur.root;
    $('set-palette-preview').hidden = settings.palette === 'custom';
    $('set-palette-preview').replaceChildren(...[['scale', 'In the scale'], ['chord', 'Chord tone'], ['next', 'Play next'], ['root', 'Key root']].map(([k, t]) =>
      el('span', { class: 'sw ' + k }, el('i', { style: 'background:' + cur[k] }), t)));
    $('set-pattern').checked = !!settings.pattern; $('set-modecol').value = root.dataset.modecol;
    $('set-contrast').checked = !!settings.contrast; $('set-textsize').value = String(settings.textSize || 100); $('set-motion').checked = !!settings.motion;
    document.dispatchEvent(new Event('mt-access'));
  }
  $('set-palette').onchange = () => {
    const v = $('set-palette').value;
    // Custom starts from whatever palette was showing.
    if (v === 'custom' && settings.palette !== 'custom') { const c = paletteNow() || { scale: '#f2c96d', chord: '#72cfc6', next: '#e2483d', root: '#8a5a00' }; Object.assign(settings, { colScale: c.scale, colChord: c.chord, colNext: c.next, colRoot: c.root }); }
    setting('palette', v); applyAccess(); renderKeys();
  };
  [['set-col-scale', 'colScale'], ['set-col-chord', 'colChord'], ['set-col-next', 'colNext'], ['set-col-root', 'colRoot']].forEach(([id, k]) => {
    $(id).oninput = () => { setting(k, $(id).value); applyAccess(); };
  });
  $('set-pattern').onchange = () => { setting('pattern', $('set-pattern').checked); applyAccess(); };
  $('set-modecol').onchange = () => { setting('modeCol', $('set-modecol').value); applyAccess(); };
  $('set-contrast').onchange = () => { setting('contrast', $('set-contrast').checked); applyAccess(); };
  $('set-textsize').onchange = () => { setting('textSize', +$('set-textsize').value); applyAccess(); };
  $('set-motion').onchange = () => { setting('motion', $('set-motion').checked); applyAccess(); };

  // The staff is an Advanced feature, with its own switch in Settings › Staff.
  const staffEnabled = () => settings.level === 'advanced' && settings.staff !== false;
  const setting = (key, val) => { settings[key] = val; saveSettings(); };
  function setSoundMenu(on) { $('sound-pop').hidden = !on; $('sound-btn').setAttribute('aria-expanded', String(on)); }
  $('sound-btn').onclick = (e) => { e.stopPropagation(); setSoundMenu($('sound-pop').hidden); };
  document.addEventListener('click', (e) => { if (!$('sound-pop').hidden && !e.target.closest('.sound-menu')) setSoundMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sound-pop').hidden) setSoundMenu(false); });
  $('volume').oninput = () => { setting('volume', +$('volume').value); engine.setVolume(settings.volume); };
  $('reverb').oninput = () => { setting('reverb', +$('reverb').value); engine.setReverb(settings.reverb); };
  $('set-track-vol').oninput = () => { setting('trackVol', +$('set-track-vol').value); engine.setTrackVolume(settings.trackVol); $('jam-track-vol').value = settings.trackVol; };
  $('set-octaves').onchange = () => {
    setting('octaves', +$('set-octaves').value); state.octaves = settings.octaves;
    if (state.kbStart + 12 * state.octaves > 108) state.kbStart = 108 - 12 * state.octaves;
    buildKeyboard();
  };
  function setLabels(on) { setting('labels', on); state.labels = on; $('kbd-names').checked = on; renderKeys(); }
  $('kbd-names').onchange = () => setLabels($('kbd-names').checked);
  $('kbd-keys').onchange = () => { setting('hints', $('kbd-keys').checked); renderKeys(); };
  $('set-phrase').onchange = () => { setting('phraseLen', +$('set-phrase').value); newSuggestion(false); };
  $('set-theme').onchange = () => { setting('theme', $('set-theme').value); applyTheme(); };
  $('set-level').onchange = () => { setting('level', $('set-level').value); applyLevel(); };
  $('set-reset').onclick = () => {
    Object.assign(settings, DEFAULT_SETTINGS); saveSettings();
    state.octaves = window.innerWidth < 700 ? 2 : 3; state.kbStart = 48;
    setPreset('piano'); applySettings(); buildKeyboard();
    $('set-reset-note').textContent = 'Settings reset to defaults.';
  };
  $('oct-down').onclick = () => { if (state.kbStart > 24) { state.kbStart -= 12; buildKeyboard(); } };
  $('oct-up').onclick = () => { if (state.kbStart + 12 * state.octaves < 108) { state.kbStart += 12; buildKeyboard(); } };

  $('midi-btn').onclick = async () => {
    const pill = $('midi-status');
    if (!navigator.requestMIDIAccess) { pill.textContent = 'MIDI not supported in this browser'; pill.className = 'pill warn'; return; }
    try {
      const access = await navigator.requestMIDIAccess();
      const hook = () => {
        const inputs = Array.from(access.inputs.values());
        inputs.forEach((inp) => {
          inp.onmidimessage = (msg) => {
            const [st, note, vel] = msg.data, cmd = st & 0xf0;
            if (cmd === 0x90 && vel > 0) press(note, vel / 127);
            else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) release(note);
            else if (cmd === 0xe0) setBend((((vel << 7) | note) - 8192) / 8192); // pitch wheel (14-bit)
            else if (cmd === 0xb0 && note === 1) setMod(vel / 127); // CC1 = mod wheel
          };
        });
        pill.textContent = inputs.length ? 'MIDI: ' + inputs.map((i) => i.name).join(', ') : 'No MIDI device found';
        pill.className = 'pill ' + (inputs.length ? 'ok' : 'warn');
      };
      access.onstatechange = hook; hook();
    } catch (e) { pill.textContent = 'MIDI access was blocked'; pill.className = 'pill bad'; }
  };

  // ---------------------------------------------------------------------
  // AI Coach
  const coach = new C.Coach();
  Object.assign(coach, store.get('coach', {}));
  // In the desktop app, the coach talks to the app's own relay, which forwards to the Ollama
  // address saved in the app (this computer or another one), so OLLAMA_ORIGINS isn't needed.
  const DESKTOP = window.MT_DESKTOP || null;
  function useDesktopRelay() {
    if (!DESKTOP) return;
    if (coach.api === 'ollama') { coach.url = location.origin + '/ollama'; coach.label = DESKTOP.ollama; }
    else coach.label = '';
  }
  useDesktopRelay();
  $('coach-api').value = coach.api; $('coach-url').value = DESKTOP && coach.api === 'ollama' ? DESKTOP.ollama : coach.url; $('coach-model').value = coach.model;
  const chat = { msgs: [], ctl: null, offlineMode: coach.api === 'offline' };

  async function saveCoach() {
    const typed = $('coach-url').value.trim();
    coach.api = $('coach-api').value; coach.model = $('coach-model').value.trim();
    if (DESKTOP && coach.api === 'ollama') {
      if (typed && typed !== DESKTOP.ollama) {
        try {
          const res = await fetch('/launcher/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ollama: typed }) });
          if (res.ok) DESKTOP.ollama = (await res.json()).ollama;
        } catch (e) { /* the relay is gone; checkCoach will report it */ }
      }
      $('coach-url').value = DESKTOP.ollama;
    } else {
      coach.url = typed;
    }
    useDesktopRelay();
    chat.offlineMode = coach.api === 'offline';
    const saved = store.get('coach', {});
    store.set('coach', { api: coach.api, url: DESKTOP && coach.api === 'ollama' ? (saved.url || new C.Coach().url) : coach.url, model: coach.model });
  }
  if (DESKTOP) setInterval(() => { fetch('/launcher/alive').catch(() => {}); }, 10000);
  ['coach-api', 'coach-url', 'coach-model'].forEach((id) => { $(id).onchange = async () => { await saveCoach(); checkCoach(); }; });
  function openCoachSettings() { switchMode('guide'); setTimeout(() => { $('coach-settings').scrollIntoView({ block: 'center' }); $('coach-api').focus(); }, 80); }
  $('coach-settings-btn').onclick = openCoachSettings;
  $('coach-test').onclick = () => checkCoach(true);
  // The coach is a drawer over the page: hidden at start, opened and closed with the header button.
  // The coach window can be dragged by its title bar; its spot is remembered on this device.
  let coachPos = null;
  try { coachPos = JSON.parse(localStorage.getItem('mt-coach-pos') || 'null'); } catch (e) { /* storage unavailable */ }
  function placeCoach() {
    const c = $('coach');
    if (!coachPos) { c.style.left = c.style.top = c.style.right = ''; return; }
    const r = c.getBoundingClientRect();
    const x = Math.min(Math.max(8, coachPos.x), window.innerWidth - Math.min(r.width, window.innerWidth - 16) - 8);
    const y = Math.min(Math.max(8, coachPos.y), window.innerHeight - 48);
    Object.assign(c.style, { left: x + 'px', top: y + 'px', right: 'auto' });
  }
  $('coach-head').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, a, input, select')) return;
    const c = $('coach'), r = c.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    $('coach-head').setPointerCapture(e.pointerId); c.classList.add('dragging');
    const move = (ev) => { coachPos = { x: ev.clientX - dx, y: ev.clientY - dy }; placeCoach(); };
    const up = () => {
      c.classList.remove('dragging');
      $('coach-head').removeEventListener('pointermove', move); $('coach-head').removeEventListener('pointerup', up);
      try { localStorage.setItem('mt-coach-pos', JSON.stringify(coachPos)); } catch (err) { /* not saved */ }
    };
    $('coach-head').addEventListener('pointermove', move); $('coach-head').addEventListener('pointerup', up);
    e.preventDefault();
  });
  $('coach-head').addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    coachPos = null; placeCoach(); try { localStorage.removeItem('mt-coach-pos'); } catch (err) { /* ignore */ }
  });
  window.addEventListener('resize', () => { if (!$('coach').hidden) placeCoach(); });
  function setCoach(on) { $('coach').hidden = !on; $('coach-toggle').setAttribute('aria-pressed', String(on)); if (on) { placeCoach(); $('coach-input').focus(); } }
  $('coach-toggle').onclick = () => setCoach($('coach').hidden);
  $('coach-close').onclick = () => setCoach(false);
  $('set-coach-reset').onclick = () => {
    if (chat.ctl) chat.ctl.abort();
    const done = resetCoachContext('manual');
    $('set-coach-reset-note').textContent = done ? 'Done. The coach starts fresh with your next question.' : 'Nothing to reset yet: the coach has no conversation to forget.';
  };
  $('coach-new').onclick = () => { if (chat.ctl) chat.ctl.abort(); chat.msgs = []; renderMsgs(); $('coach-input').focus(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('coach').hidden) setCoach(false); });
  function openCoach() { if ($('coach').hidden) $('coach-toggle').click(); }

  function setCoachStatus(text, cls) { const p = $('coach-status'); p.textContent = text; p.className = 'pill ' + (cls || ''); }
  async function checkCoach(verbose) {
    if (coach.api === 'offline') { setCoachStatus('Offline helper', 'warn'); return; }
    setCoachStatus('Checking…');
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    try {
      await coach.ping(ctl.signal);
      chat.offlineMode = false; setCoachStatus('Loading Qwen…', 'warn');
      coach.warm().then(() => setCoachStatus('Qwen ready', 'ok')).catch(() => setCoachStatus('Qwen connected', 'ok'));
      if (verbose) addMsg({ role: 'assistant', kind: 'offline', content: 'Connected to ' + coach.model + ' at ' + coach.where + '.' });
    } catch (e) {
      chat.offlineMode = true; setCoachStatus(e.code === 'no_model' ? 'Model missing' : 'Offline helper', 'warn');
      if (verbose) addMsg({ role: 'assistant', kind: 'error', content: e.message, code: e.code });
    } finally { clearTimeout(t); }
  }

  function appContext() {
    const lines = ['Mode: ' + { free: 'Free Play', scale: 'Scale Mode', jam: 'Jam Mode' }[state.mode]];
    const k = activeKey();
    if (k) lines.push('Current key/scale: ' + T.scaleLabel(k.rootPc, k.scaleId) + ' = ' + T.scalePitchClasses(k.rootPc, k.scaleId).map((pc) => T.pcName(pc, k.rootPc)).join(' '));
    if (state.mode === 'jam' && state.jam.result) {
      const r = state.jam.result;
      lines.push('Song: ' + state.jam.sourceName + (r.tempo.bpm ? ', ' + Math.round(r.tempo.bpm) + ' BPM' : ''));
      if (r.chords.length) lines.push('Chord sequence: ' + r.chords.slice(0, 12).map((c) => c.name).join(' '));
      const ch = currentChord(); if (ch) lines.push('Chord playing now: ' + ch.name);
      const soundOf = (x) => S.INSTRUMENT_PRESET[x.id] || (x.instruments || []).map((i) => S.INSTRUMENT_PRESET[i]).find(Boolean);
      if (stems.status === 'done') lines.push('Separated instrument tracks (with the keyboard sound to use as inst=): ' + stems.list.filter((x) => x.present).map((x) => x.label + (soundOf(x) ? ' (inst=' + soundOf(x) + ')' : '')).join('; ')
        + (player.stems && player.useStems ? '. Muted by the user: ' + (player.stems.filter((x) => x.mute).map((x) => (stems.list.find((v) => v.id === x.id) || x).label || x.id).join(', ') || 'none') : ''));
      if (stems.status === 'done' && stems.info && stems.info.instruments && stems.info.instruments.length)
        lines.push('Instruments recognised in the song: ' + stems.info.instruments.map((f) => f.name + ' (' + Math.round(100 * f.confidence) + '% sure)').join(', '));
      if (r.riff && r.riff.source) lines.push('Riff Mode riff comes from the ' + r.riff.source + ' part');
    }
    if (state.free.seq.length) lines.push('Last notes the user played: ' + state.free.seq.slice(-12).map(T.midiName).join(' '));
    if (state.mode === 'learn' && EX.context()) lines.push(EX.context());
    lines.push('Keyboard range: ' + T.midiName(state.kbStart) + ' to ' + T.midiName(state.kbStart + 12 * state.octaves) + ' (you can play it with a play block)');
    lines.push('Keyboard sound: ' + S.PRESETS[engine.override || engine.preset].name + '. Sounds for inst=: ' + Object.keys(S.PRESETS).join(', '));
    return lines.join('\n');
  }
  function activeKey() {
    if (state.mode === 'scale') return { rootPc: state.scale.root, scaleId: state.scale.id };
    if (state.mode === 'jam' && state.jam.key) return state.jam.key;
    if (state.mode === 'free') {
      const w = state.free.weights; if (w.filter((x) => x > 0).length >= 3) { const r = T.identifyScales(w, { limit: 1 })[0]; return { rootPc: r.rootPc, scaleId: r.scaleId }; }
    }
    return null;
  }

  function renderQuick() {
    const qs = {
      free: ['What scale am I playing?', 'Major vs. minor?', 'What is a pentatonic scale?'],
      scale: ['Explain this scale', 'What chords fit this key?', 'Give me an exercise'],
      jam: ['What should I play over this chord?', 'Why this key?', 'What chords are in this song?'],
    }[state.mode] || ['What is a scale?', 'Major vs. minor?', 'What is a pentatonic scale?'];
    $('coach-quick').replaceChildren(...qs.map((q) => el('button', { class: 'btn small', onclick: () => sendToCoach(q) }, q)));
  }

  function addMsg(m) { chat.msgs.push(m); renderMsgs(); return m; }
  // Context resets: a divider in the chat. Messages above it stay on screen, but the coach no longer sees them.
  const COACH_CONTEXT_CHARS = 8000;
  function sinceReset() { let i = chat.msgs.length - 1; while (i >= 0 && chat.msgs[i].kind !== 'reset') i--; return chat.msgs.slice(i + 1); }
  function resetCoachContext(why, beforeQuestion) {
    const content = why === 'auto' ? 'The chat reached the coach\u2019s memory limit, so it started fresh from here. Messages above stay on screen, but it no longer sees them.'
      : 'Coach context reset. It starts fresh from here and no longer sees the messages above.';
    const last = chat.msgs[chat.msgs.length - 1];
    if (!chat.msgs.length || (last && last.kind === 'reset')) return false;
    // Put the divider above the question that is being asked, so that question counts as the new start.
    let at = chat.msgs.length;
    if (beforeQuestion) for (let i = chat.msgs.length - 1; i >= 0; i--) { if (chat.msgs[i].role === 'user' && chat.msgs[i].content === beforeQuestion) { at = i; break; } }
    if (at === 0) return false;
    chat.msgs.splice(at, 0, { role: 'system', kind: 'reset', content });
    renderMsgs();
    return true;
  }
  function renderMsgs() {
    const box = $('coach-msgs');
    if (!chat.msgs.length) {
      box.replaceChildren(el('div', { class: 'state' }, el('strong', {}, 'Ask me anything about music theory. '), 'I can see what you are playing and which key you are in. Try a quick question below.'));
      return;
    }
    box.replaceChildren(...chat.msgs.map((m, i) => {
      if (m.kind === 'reset') return el('div', { class: 'msg reset', role: 'separator' }, el('span', {}, '↺ ' + m.content));
      if (m.role === 'user') return el('div', { class: 'msg user' }, m.content);
      if (m.kind === 'loading') return el('div', { class: 'msg ai' }, C.parsePlay(m.content).text || el('em', {}, 'Thinking…'),
        el('div', { class: 'meta' }, el('span', { class: 'mono' }, m.elapsed || '0.0 s'), m.slow ? 'Still working. Local models can be slow on the first question.' : null, el('button', { onclick: () => chat.ctl && chat.ctl.abort() }, 'Stop')));
      if (m.kind === 'error') {
        const q = m.question;
        return el('div', { class: 'msg err state error' }, el('strong', {}, 'The AI coach could not answer. '), m.content,
          el('div', { class: 'meta' },
            q ? el('button', { onclick: () => { chat.msgs.splice(i, 1); sendToCoach(q, { retry: true }); } }, 'Try again') : null,
            q ? el('button', { onclick: () => { const om = { role: 'assistant', kind: 'offline', content: C.offlineAnswer(q, coachState()) }; chat.msgs.splice(i, 1, om); renderMsgs(); autoPlay(om); } }, 'Use offline helper') : null,
            el('button', { onclick: () => switchMode('guide') }, 'Setup guide'),
            el('button', { onclick: openCoachSettings }, 'Open settings')));
      }
      const pp = C.parsePlay(m.content), play = pp.plays[0];
      const playBtn = play ? el('button', { class: 'play-btn', 'aria-pressed': String(coachPlay.msg === m), onclick: () => (coachPlay.msg === m ? stopCoachPlay() : playCoach(m)) },
        coachPlay.msg === m ? '■ Stop' : '▶ Play on the keyboard') : null;
      const playInfo = play ? el('span', { class: 'mono' }, play.events.filter((e) => e.midis.length).length + ' notes · ' + Math.round(play.bpm) + ' BPM') : null;
      const meta = m.kind === 'offline'
        ? [playBtn, playInfo, el('span', {}, 'Offline helper (no AI)'), coach.api !== 'offline' ? el('button', { onclick: () => checkCoach(true) }, 'Reconnect to Qwen') : null]
        : [playBtn, playInfo, el('span', {}, 'Qwen · ' + m.seconds.toFixed(1) + ' s'),
          el('button', { onclick: () => { const q = m.question; chat.msgs.splice(i, 1); sendToCoach(q, { retry: true }); } }, 'Regenerate'),
          el('button', { onclick: () => copyText(pp.text) }, 'Copy'),
          el('button', { onclick: () => { chat.msgs.splice(i, 1); renderMsgs(); } }, 'Not helpful, remove')];
      return el('div', { class: 'msg ai' + (m.kind === 'offline' ? ' offline' : '') }, pp.text, el('div', { class: 'meta' }, meta));
    }));
    box.scrollTop = box.scrollHeight;
  }
  // The coach plays its examples on the keyboard: the first play block of an answer, with the keys lit.
  const coachPlay = { msg: null, timers: [], held: new Set() };
  const coachKey = (m, on) => { const k = keyEls.get(m); if (k) k.classList.toggle('coach-on', on); };
  function stopCoachPlay() {
    coachPlay.timers.forEach(clearTimeout); coachPlay.timers = [];
    coachPlay.held.forEach((m) => { if (!state.held.has(m)) engine.noteOff(m); coachKey(m, false); });
    coachPlay.held.clear();
    if (coachPlay.msg) { coachPlay.msg = null; renderMsgs(); }
  }
  function playCoach(msg) {
    stopCoachPlay();
    const p = C.parsePlay(msg.content).plays[0];
    if (!p) return;
    try { engine.ensure(); } catch (e) { return; }
    const beat = 60000 / p.bpm;
    let t = 60;
    coachPlay.msg = msg;
    // inst=<sound> in the block (the coach picks the sound of a separated instrument); else the keyboard's own.
    const inst = S.PRESETS[p.inst] ? p.inst : null;
    for (const ev of p.events) {
      const at = t, len = ev.beats * beat;
      if (ev.midis.length) {
        coachPlay.timers.push(setTimeout(() => ev.midis.forEach((m) => { engine.noteOn(m, 0.75, inst); coachPlay.held.add(m); coachKey(m, true); }), at));
        coachPlay.timers.push(setTimeout(() => ev.midis.forEach((m) => { if (!state.held.has(m)) engine.noteOff(m); coachPlay.held.delete(m); coachKey(m, false); }), at + len * 0.9));
      }
      t += len;
    }
    coachPlay.timers.push(setTimeout(() => { coachPlay.timers = []; if (coachPlay.msg === msg) { coachPlay.msg = null; renderMsgs(); } }, t + 50));
    renderMsgs();
  }
  // A fresh answer with an example plays it once by itself.
  function autoPlay(msg) { if (C.parsePlay(msg.content).plays.length) playCoach(msg); }
  function offlineReply(question) { autoPlay(addMsg({ role: 'assistant', kind: 'offline', content: C.offlineAnswer(question, coachState()) })); }
  function copyText(t) { if (navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {}); }
  function coachState() { return { key: activeKey(), chord: state.mode === 'jam' ? currentChord() : null }; }

  async function sendToCoach(question, opts) {
    question = (question || '').trim();
    if (!question) { $('coach-input').focus(); return; }
    if (chat.ctl) return;
    opts = opts || {};
    if (!opts.retry) addMsg({ role: 'user', content: question });
    if (question.length > 1000) { addMsg({ role: 'assistant', kind: 'error', content: 'That message is over 1000 characters. Shorten it and send again.' }); return; }
    if (chat.offlineMode) { offlineReply(question); return; }
    // The coach sees the chat since the last context reset, minus this question (added below).
    let history = sinceReset().filter((m) => m.role === 'user' || (m.role === 'assistant' && m.kind === 'ai')).map((m) => ({ role: m.role, content: m.content }));
    if (history.length && history[history.length - 1].role === 'user' && history[history.length - 1].content === question) history.pop();
    // Context limit (about 2,000 tokens of chat, so the prompt always fits the model's window): start fresh.
    if (!opts.fresh && history.reduce((n, m) => n + m.content.length, 0) > COACH_CONTEXT_CHARS) {
      resetCoachContext('auto', question); history = [];
    }
    if (opts.fresh) history = [];
    history.push({ role: 'user', content: question });
    const ctl = chat.ctl = new AbortController();
    const msg = addMsg({ role: 'assistant', kind: 'loading', content: '', question });
    const t0 = performance.now();
    const timer = setInterval(() => { const s = (performance.now() - t0) / 1000; msg.elapsed = s.toFixed(1) + ' s'; msg.slow = s > 10; renderMsgs(); }, 250);
    $('coach-send').hidden = true; $('coach-cancel').hidden = false;
    let again = false;
    try {
      const text = await coach.ask(history, appContext(), (partial) => { msg.content = partial; }, ctl.signal);
      Object.assign(msg, { kind: 'ai', content: text, seconds: (performance.now() - t0) / 1000 });
      setCoachStatus('Qwen connected', 'ok');
      setTimeout(() => autoPlay(msg), 0);
    } catch (e) {
      if (e.code === 'cancelled') { Object.assign(msg, { kind: 'error', content: 'You stopped this answer.' }); }
      else if (e.code === 'too_long' && !opts.fresh) {
        // The model's own limit was hit: reset the context and ask again with only this question.
        chat.msgs.splice(chat.msgs.indexOf(msg), 1); resetCoachContext('auto', question); again = true;
      }
      else {
        Object.assign(msg, { kind: 'error', content: e.message + ({ unreachable: ' Is Ollama running?', timeout: ' The model may still be loading.', rate_limit: ' Wait a moment and try again.', empty: ' Try rephrasing the question.', no_model: ' Check the model name in AI Setup.', too_long: ' Press New chat to start over.' }[e.code] || ''), code: e.code });
        if (e.code === 'unreachable') { chat.offlineMode = true; setCoachStatus('Offline helper', 'warn'); }
      }
    } finally {
      clearInterval(timer); chat.ctl = null;
      $('coach-send').hidden = false; $('coach-cancel').hidden = true;
      renderMsgs();
    }
    if (again) return sendToCoach(question, { retry: true, fresh: true });
  }
  $('coach-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('coach-input').value; $('coach-input').value = ''; sendToCoach(v); });
  $('coach-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('coach-form').requestSubmit(); } });
  $('coach-cancel').onclick = () => chat.ctl && chat.ctl.abort();


  // ---------------------------------------------------------------------
  // AI setup guide
  const STEP_TEXT = {
    install: { win: ['Install Ollama', 'Download the Windows installer from ollama.com/download and run it. Ollama starts in the system tray (bottom right).', null],
      mac: ['Install Ollama', 'Download Ollama from ollama.com/download, drag it into Applications and open it. Its icon appears in the menu bar.', null],
      linux: ['Install Ollama', 'Run the official install script. It sets Ollama up as a background service.', 'curl -fsSL https://ollama.com/install.sh | sh'] },
    pull: ['Download the Qwen model', 'Open a terminal (PowerShell on Windows) and run this. It downloads about 4.7 GB once.', 'ollama pull qwen2.5:7b-instruct'],
    test: ['Test it in the terminal', 'You should get a short answer. The first one can take up to a minute while the model loads.', 'ollama run qwen2.5:7b-instruct "Which notes are in the C major scale?"'],
    origins: { win: ['Let the browser talk to Ollama', 'Run this, then right-click the Ollama tray icon, choose Quit, and open Ollama again from the Start menu.', 'setx OLLAMA_ORIGINS "*"'],
      mac: ['Let the browser talk to Ollama', 'Run this, then quit Ollama from the menu bar icon and open it again.', 'launchctl setenv OLLAMA_ORIGINS "*"'],
      linux: ['Let the browser talk to Ollama', 'Add the setting to the service and restart it. In the editor that opens, add the two lines shown in the comment.', 'sudo systemctl edit ollama.service   # add:  [Service]  Environment="OLLAMA_ORIGINS=*"\nsudo systemctl daemon-reload && sudo systemctl restart ollama'] },
    serve: { win: ['Open the app from the project folder', 'The online preview can’t reach your computer, so run the app locally, then open http://localhost:8000.', 'cd music-theorizer\npython -m http.server 8000'],
      mac: ['Open the app from the project folder', 'The online preview can’t reach your computer, so run the app locally, then open http://localhost:8000.', 'cd music-theorizer\npython3 -m http.server 8000'],
      linux: ['Open the app from the project folder', 'The online preview can’t reach your computer, so run the app locally, then open http://localhost:8000.', 'cd music-theorizer\npython3 -m http.server 8000'] },
    remote: { win: ['Optional: use Ollama on another computer', 'The desktop app talks to Ollama for you, so no browser setting is needed. To use a different computer (for example a gaming PC), run this there, restart Ollama, then type that computer\u2019s address in AI Setup › Coach connection, like http://192.168.1.20:11434.', 'setx OLLAMA_HOST "0.0.0.0"'],
      mac: ['Optional: use Ollama on another computer', 'The desktop app talks to Ollama for you, so no browser setting is needed. To use a different computer, run this there, restart Ollama, then type its address in AI Setup › Coach connection, like http://192.168.1.20:11434.', 'launchctl setenv OLLAMA_HOST "0.0.0.0"'],
      linux: ['Optional: use Ollama on another computer', 'The desktop app talks to Ollama for you, so no browser setting is needed. To use a different computer, add Environment="OLLAMA_HOST=0.0.0.0" to its service, restart it, then type its address in AI Setup › Coach connection.', 'sudo systemctl edit ollama.service'] },
    check: ['Run the checks below', 'When all four pass, the coach status at the top of the AI Coach panel says "Qwen ready".', null],
  };
  function renderGuide(os) {
    document.querySelectorAll('.subtab.os').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.os === os)));
    const pick = (x) => (Array.isArray(x) ? x : x[os]);
    const keys = DESKTOP ? ['install', 'pull', 'test', 'remote', 'check'] : ['install', 'pull', 'test', 'origins', 'serve', 'check'];
    const steps = keys.map((k) => pick(STEP_TEXT[k]));
    $('guide-steps').replaceChildren(...steps.map(([title, text, cmd]) => el('li', {},
      el('strong', {}, title), el('p', {}, text),
      cmd ? el('div', { class: 'cmd' }, el('code', {}, cmd), el('button', { type: 'button', onclick: (e) => {
        const btn = e.currentTarget;
        const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard) navigator.clipboard.writeText(cmd).then(done, () => { btn.textContent = 'Select and copy'; });
      } }, 'Copy')) : null)));
    store.set('guideOs', os);
  }
  document.querySelectorAll('.subtab.os').forEach((b) => { b.onclick = () => renderGuide(b.dataset.os); });
  const guessOs = /Mac/i.test(navigator.platform) ? 'mac' : /Linux/i.test(navigator.platform) ? 'linux' : 'win';
  renderGuide(store.get('guideOs', guessOs));

  $('guide-check').onclick = async () => {
    const list = $('guide-checks');
    const rows = [
      ['page', 'App is running on this computer'],
      ['server', 'Ollama is reachable from the browser'],
      ['model', `Model "${coach.model}" is installed`],
      ['answer', 'The model loads and answers'],
    ].map(([id, label]) => {
      const li = el('li', { class: 'wait' }, el('span', { class: 'ic' }, '…'), el('span', {}, label, ' ', el('span', { class: 'detail' })));
      li.dataset.id = id; return li;
    });
    list.replaceChildren(...rows);
    const set = (i, ok, detail) => {
      const li = rows[i]; li.className = ok === null ? 'wait' : ok ? 'ok' : 'bad';
      li.querySelector('.ic').textContent = ok === null ? '…' : ok ? '✓' : '✗';
      li.querySelector('.detail').textContent = detail || '';
    };
    const skipRest = (from) => { for (let i = from; i < rows.length; i++) set(i, false, 'Skipped until the step above passes.'); };
    const local = location.protocol === 'file:' || /^(localhost|127\.|\[::1\])/.test(location.hostname);
    set(0, local, local ? '' : 'This is the online preview. It can’t reach your computer: do step 5.');
    if (coach.api === 'offline') { set(1, false, 'Coach connection says "Offline helper only". Change Server type to Ollama.'); skipRest(2); return; }
    try {
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), 4000);
      await coach.ping(ctl.signal);
      set(1, true, coach.where); set(2, true, '');
    } catch (e) {
      if (e.code === 'no_model') { set(1, true, coach.where); set(2, false, e.message + ' Do step 2.'); skipRest(3); return; }
      set(1, false, DESKTOP
        ? `Not reachable at ${coach.where}. Start Ollama (step 1). If it runs on another computer, check that address in AI Setup › Coach connection (step 4).`
        : `Not reachable at ${coach.url}. If that address in a new tab says "Ollama is running", do step 4; otherwise start Ollama (step 1).`);
      skipRest(2); return;
    }
    set(3, null, 'Loading the model. The first time can take up to a minute…');
    const t0 = performance.now();
    try {
      await coach.warm();
      const text = await coach.ask([{ role: 'user', content: 'Reply with just: ready' }], 'Mode: setup check', null);
      set(3, true, `Answered in ${((performance.now() - t0) / 1000).toFixed(1)} s: "${text.trim().slice(0, 40)}"`);
      chat.offlineMode = false; setCoachStatus('Qwen ready', 'ok');
    } catch (e) { set(3, false, e.message); }
  };


  // ---------------------------------------------------------------------
  // Guitar mode: audio-interface input, amp sim, tuner, fretboard
  const G = window.Guitar;
  const gtr = { rig: null, connected: false, hand: 5, live: null, livePos: null, trail: [], stats: { hit: 0, own: 0, out: 0 }, dev: [], lastVoiced: 0 };
  fillSelect($('gtr-amp'), Object.entries(G.AMPS).map(([id, a]) => [id, a.name]));
  fillSelect($('amp-strip'), Object.entries(G.AMPS).map(([id, a]) => [id, a.name]));
  fillSelect($('gtr-tuning'), Object.entries(G.TUNINGS).map(([id, t]) => [id, t.name]));
  const tuningStrings = () => (G.TUNINGS[settings.gtrTuning] || G.TUNINGS.standard).strings;
  const guitarView = () => state.mode === 'jam' && state.riff.tab === 'guitar';

  function updateInstrumentView() {
    const g = guitarView();
    $('kbd').hidden = g; $('fretboard').hidden = !g;
    document.querySelector('.kbd-wrap').classList.toggle('is-guitar', g);
    $('strip-preset').hidden = g; $('strip-amp').hidden = !g;
    if (g) renderFretboard();
  }

  function guitarSuggRange() {
    const st = tuningStrings(), h = Math.round(Math.max(0, Math.min(12, gtr.hand)));
    return [st[0] + Math.max(0, h - 1), st[st.length - 1] + h + 4];
  }

  function renderFretboard() {
    if (!guitarView()) return;
    const h = highlights();
    G.drawFretboard($('fretboard'), {
      strings: tuningStrings(), frets: 15, scalePcs: h.scale, rootPc: h.root, chordPcs: h.chord, badges: h.badges,
      live: gtr.live, livePos: gtr.livePos, trail: gtr.trail, hand: gtr.hand, name: (pc) => T.pcName(pc, h.root),
    });
  }

  function applyGuitarSettings() {
    $('gtr-amp').value = settings.gtrAmp; $('amp-strip').value = settings.gtrAmp;
    $('gtr-stereo').value = settings.gtrStereo ? 'stereo' : 'mono';
    $('gtr-drive').value = settings.gtrDrive; $('gtr-bass').value = settings.gtrBass; $('gtr-mid').value = settings.gtrMid; $('gtr-treble').value = settings.gtrTreble;
    $('gtr-vol').value = settings.gtrVol; $('gtr-monitor').checked = settings.gtrMonitor;
    $('gtr-ref').value = settings.gtrRef; $('gtr-tuning').value = settings.gtrTuning;
    $('set-rate').value = settings.sampleRate; $('set-latency').value = settings.latency;
    engine.sampleRate = settings.sampleRate === 'auto' ? null : +settings.sampleRate;
    engine.latency = settings.latency;
    const r = gtr.rig; if (!r) return;
    r.setAmp(settings.gtrAmp); r.setStereo(settings.gtrStereo); r.setVolume(settings.gtrVol); r.setMonitor(settings.gtrMonitor); r.setReference(settings.gtrRef);
    ['drive', 'bass', 'mid', 'treble'].forEach((k) => r.setParam(k, settings['gtr' + k[0].toUpperCase() + k.slice(1)]));
  }

  const gtrStatus = (text, cls) => { const p = $('gtr-status'); p.textContent = text; p.className = 'pill ' + (cls || ''); };

  async function fillDevices() {
    let devs = [];
    try { devs = await G.Rig.devices(); } catch (e) { /* none */ }
    const sel = $('gtr-device');
    sel.replaceChildren(...(devs.length ? devs.map((d, i) => el('option', { value: d.deviceId }, d.deviceId === 'default' ? 'System default' + (d.label ? ' (' + d.label.replace(/^Default - /, '') + ')' : '') : d.label || 'Input device ' + (i + 1)))
      : [el('option', { value: '' }, 'Default input')]));
    if (gtr.rig && gtr.rig.deviceId && Array.from(sel.options).some((o) => o.value === gtr.rig.deviceId)) sel.value = gtr.rig.deviceId;
  }

  function fillChannels(n) {
    const opts = [];
    for (let i = 0; i < Math.max(1, n); i++) opts.push([String(i), 'Input ' + (i + 1)]);
    if (n >= 2) opts.push(['stereo', 'Inputs 1+2 together']);
    fillSelect($('gtr-channel'), opts);
    const want = String(settings.gtrChannel);
    $('gtr-channel').value = opts.some(([v]) => v === want) ? want : '0';
  }

  function showGuitarInfo() {
    if (!gtr.rig || !gtr.connected) { $('gtr-info').textContent = ''; return; }
    const i = gtr.rig.info();
    const ms = Math.round((i.inputLatency + i.outputLatency) * 1000);
    $('gtr-info').textContent = `${i.label} · ${i.channels} input${i.channels === 1 ? '' : 's'} · ` +
      (i.deviceRate ? `interface ${(i.deviceRate / 1000).toFixed(1)} kHz · ` : '') + `app ${(i.sampleRate / 1000).toFixed(1)} kHz` + (ms ? ` · delay about ${ms} ms` : '');
  }

  // Rebuild audio with a new sample rate or latency, keeping the song and the guitar going.
  async function reconfigureAudio(opts) {
    const was = player.playing;
    if (was) player.pause();
    await engine.reconfigure(opts);
    player.rebuild(); metro.rebuild();
    if (player.rate !== 1) await player.prepare();
    if (was) player.play();
  }
  engine.onReconfigure = () => { if (gtr.rig) gtr.rig.rebuild(); showGuitarInfo(); };

  async function connectGuitar(deviceId, channel) {
    if (!G.Rig.supported()) { gtrStatus('This browser can’t use audio inputs', 'warn'); return false; }
    try { engine.ensure(); } catch (e) { gtrStatus('No audio output', 'warn'); return false; }
    if (!gtr.rig) gtr.rig = new G.Rig(engine, { onFrame: gtrFrame, onNote: gtrNote });
    applyGuitarSettings();
    gtrStatus('Waiting for permission…', 'warn');
    const ch = channel != null ? channel : (settings.gtrChannel === 'stereo' ? 'stereo' : +settings.gtrChannel || 0);
    let info;
    try {
      info = await gtr.rig.connect(deviceId != null ? deviceId : settings.gtrDevice, ch);
    } catch (e) {
      if (e && e.name === 'OverconstrainedError' || e && e.name === 'NotFoundError' && (deviceId || settings.gtrDevice)) {
        try { info = await gtr.rig.connect('', ch); } catch (e2) { e = e2; }
      }
      if (!info) {
        gtr.connected = false;
        gtrStatus(e && e.name === 'NotAllowedError' ? 'Access blocked: allow the microphone for this app and try again'
          : e && e.name === 'NotFoundError' ? 'No audio input found. Plug in your interface' : 'Could not open the input', 'warn');
        return false;
      }
    }
    gtr.connected = true;
    settings.gtrDevice = info.deviceId; settings.gtrChannel = String(ch); saveSettings();
    await fillDevices(); fillChannels(info.channels);
    // Match the app's sample rate to the interface so the browser doesn't resample.
    if (settings.sampleRate === 'auto' && info.deviceRate && engine.ctx && engine.ctx.sampleRate !== info.deviceRate) {
      engine.sampleRate = info.deviceRate;
      await reconfigureAudio({ sampleRate: info.deviceRate });
    }
    gtrStatus('Connected', 'ok');
    $('gtr-connect').textContent = 'Disconnect';
    showGuitarInfo();
    return true;
  }

  $('gtr-connect').onclick = async () => {
    if (gtr.connected) { gtr.rig.disconnect(); gtr.connected = false; gtrStatus('Not connected'); $('gtr-connect').textContent = 'Connect guitar'; showGuitarInfo(); return; }
    await connectGuitar();
  };
  $('gtr-device').onchange = () => connectGuitar($('gtr-device').value, 0);
  $('gtr-channel').onchange = () => {
    const v = $('gtr-channel').value; settings.gtrChannel = v; saveSettings();
    if (gtr.rig) gtr.rig.setChannel(v === 'stereo' ? 'stereo' : +v);
  };
  $('gtr-find').onclick = async () => {
    const note = $('gtr-find-note');
    if (!gtr.connected && !(await connectGuitar())) return;
    note.textContent = 'Strum your guitar now…';
    const best = await gtr.rig.findGuitar((i, n, label) => { note.textContent = `Strum now… checking ${label || 'input'} (${i + 1} of ${n})`; }, 1.5);
    if (!best || best.level < 0.01) { note.textContent = 'Didn’t hear a guitar. Check the cable and the input gain on your interface, then try again.'; await connectGuitar(); return; }
    await connectGuitar(best.deviceId, best.channel);
    note.textContent = `Found it: ${best.label || 'your interface'}, input ${best.channel + 1}.`;
  };

  const ampChange = (id) => { settings.gtrAmp = id; saveSettings(); $('gtr-amp').value = id; $('amp-strip').value = id; if (gtr.rig) gtr.rig.setAmp(id); };
  $('gtr-amp').onchange = () => ampChange($('gtr-amp').value);
  $('amp-strip').onchange = () => ampChange($('amp-strip').value);
  $('gtr-stereo').onchange = () => { settings.gtrStereo = $('gtr-stereo').value === 'stereo'; saveSettings(); if (gtr.rig) gtr.rig.setStereo(settings.gtrStereo); };
  [['gtr-drive', 'gtrDrive', 'drive'], ['gtr-bass', 'gtrBass', 'bass'], ['gtr-mid', 'gtrMid', 'mid'], ['gtr-treble', 'gtrTreble', 'treble']].forEach(([id, key, param]) => {
    $(id).oninput = () => { settings[key] = +$(id).value; saveSettings(); if (gtr.rig) gtr.rig.setParam(param, settings[key]); };
  });
  $('gtr-vol').oninput = () => { settings.gtrVol = +$('gtr-vol').value; saveSettings(); if (gtr.rig) gtr.rig.setVolume(settings.gtrVol); };
  $('gtr-monitor').onchange = () => { settings.gtrMonitor = $('gtr-monitor').checked; saveSettings(); if (gtr.rig) gtr.rig.setMonitor(settings.gtrMonitor); };
  const setRef = (hz) => {
    hz = Math.max(400, Math.min(480, +hz || 440));
    settings.gtrRef = Math.round(hz * 10) / 10; saveSettings();
    $('gtr-ref').value = settings.gtrRef;
    if (gtr.rig) gtr.rig.setReference(settings.gtrRef);
  };
  $('gtr-ref').onchange = () => setRef($('gtr-ref').value);
  $('gtr-ref-440').onclick = () => setRef(440);
  $('gtr-ref-song').onclick = () => { const tu = state.jam.result && state.jam.result.tuning; if (tu && tu.a4) setRef(tu.a4); };
  $('gtr-tuning').onchange = () => { settings.gtrTuning = $('gtr-tuning').value; saveSettings(); gtr.livePos = null; gtr.trail = []; newSuggestion(false); renderFretboard(); };

  // Live frames: level meter, tuner, and the "out of tune with the song" check.
  function gtrFrame(f) {
    const m = $('gtr-meter');
    m.style.width = Math.min(100, Math.sqrt(f.rms) * 160).toFixed(1) + '%';
    m.classList.toggle('clip', f.clip);
    const now = performance.now();
    if (f.voiced) {
      gtr.lastVoiced = now;
      const c = Math.max(-50, Math.min(50, f.cents));
      $('tuner-note').textContent = T.pcName(T.mod12(f.midi)) + (Math.floor(f.midi / 12) - 1);
      $('tuner-needle').style.left = (50 + c) + '%';
      $('gtr-tuner').classList.toggle('in-tune', Math.abs(f.cents) < 5);
      $('tuner-cents').textContent = Math.abs(f.cents) < 5 ? 'In tune' : `${f.cents > 0 ? '+' : ''}${Math.round(f.cents)} cents ${f.cents > 0 ? '(sharp)' : '(flat)'}`;
      $('tuner-hz').textContent = f.f0.toFixed(1) + ' Hz';
      // Compare against the song's own tuning while a note rings.
      const tu = state.jam.result && state.jam.result.tuning;
      if (state.mode === 'jam' && tu && tu.a4 && f.clarity > 0.9 && f.midi === gtr.live) {
        const mf = 69 + 12 * Math.log2(f.f0 / tu.a4);
        gtr.dev.push((mf - Math.round(mf)) * 100);
        if (gtr.dev.length > 80) gtr.dev.shift();
      }
    } else if (now - gtr.lastVoiced > 1500) {
      $('tuner-note').textContent = '–'; $('tuner-cents').textContent = 'Play one string'; $('tuner-hz').textContent = '';
      $('gtr-tuner').classList.remove('in-tune');
    }
    if (!gtr.devAt || now - gtr.devAt > 700) { gtr.devAt = now; checkSongTuning(); }
  }

  // Small, non-blocking hint when the guitar is noticeably off from the song.
  function checkSongTuning() {
    const w = $('gtr-tune-warn');
    if (gtr.dev.length < 25) { w.hidden = true; return; }
    const sorted = gtr.dev.slice().sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    if (Math.abs(med) > 15) {
      w.hidden = false;
      w.textContent = `Guitar sounds ${Math.round(Math.abs(med))}¢ ${med > 0 ? 'sharp' : 'flat'} vs the song`;
      w.title = 'Tune with the tuner set to "Match the song". You can keep playing.';
    } else w.hidden = true;
  }
  $('gtr-tune-warn').onclick = () => { const tu = state.jam.result && state.jam.result.tuning; if (tu && tu.a4) setRef(tu.a4); $('gtr-tuner').scrollIntoView({ block: 'nearest' }); };

  // A note from the guitar: show it on the fretboard and feed the same logic as the keys.
  function gtrNote(n) {
    const midi = n.midi, st = tuningStrings();
    const pos = G.nearest(midi, st, 15, gtr.hand);
    gtr.live = midi; gtr.livePos = pos;
    if (pos) { gtr.hand = gtr.hand * 0.6 + pos.f * 0.4; gtr.trail.push({ midi, pos }); if (gtr.trail.length > 8) gtr.trail.shift(); }
    if (state.mode === 'jam' && state.jam.key && state.riff.tab !== 'riff') {
      const s = state.jam.sugg, exp = s.notes[s.idx];
      const pcs = T.scalePitchClasses(state.jam.key.rootPc, state.jam.key.scaleId);
      if (exp != null && T.mod12(exp) === T.mod12(midi)) gtr.stats.hit++;
      else if (pcs.includes(T.mod12(midi))) gtr.stats.own++;
      else gtr.stats.out++;
      $('gtr-stats').textContent = `Suggested notes hit: ${gtr.stats.hit} · your own notes in the key: ${gtr.stats.own} · outside the key: ${gtr.stats.out}`;
    }
    const k = keyEls.get(midi); if (k) { k.classList.add('down'); setTimeout(() => k.classList.remove('down'), 180); }
    onNotePlayed(midi);
    renderFretboard();
  }

  // Settings › Audio input
  $('set-rate').onchange = async () => {
    settings.sampleRate = $('set-rate').value; saveSettings();
    let rate = settings.sampleRate === 'auto' ? (gtr.rig && gtr.rig.deviceRate) || null : +settings.sampleRate;
    engine.sampleRate = rate;
    if (engine.ctx) await reconfigureAudio({ sampleRate: rate });
    showGuitarInfo();
  };
  $('set-latency').onchange = async () => {
    settings.latency = $('set-latency').value; saveSettings();
    engine.latency = settings.latency;
    if (engine.ctx) await reconfigureAudio({ latency: settings.latency });
    showGuitarInfo();
  };
  $('set-check-audio').onclick = async () => {
    const list = $('audio-checks');
    const item = (ok, text, detail) => el('li', { class: ok === null ? 'wait' : ok ? 'ok' : 'bad' }, el('span', { class: 'ic' }, ok === null ? '…' : ok ? '✓' : '!'), el('span', {}, text, ' ', el('span', { class: 'detail' }, detail || '')));
    list.replaceChildren(item(null, 'Opening your audio input…'));
    if (!gtr.connected && !(await connectGuitar())) { list.replaceChildren(item(false, 'Could not open an audio input', $('gtr-status').textContent)); return; }
    const i = gtr.rig.info(), devs = await G.Rig.devices();
    const ms = Math.round((i.inputLatency + i.outputLatency) * 1000);
    const rows = [
      item(true, `Interface: ${i.label}`, `${i.channels} input${i.channels === 1 ? '' : 's'} on this device` + (devs.length > 2 ? `; ${devs.length - 1} input devices found in total. Interfaces with many inputs often appear as several devices (e.g. inputs 1+2, 3+4).` : '')),
      i.deviceRate ? item(i.deviceRate === i.sampleRate, `Sample rate: interface ${(i.deviceRate / 1000).toFixed(1)} kHz, app ${(i.sampleRate / 1000).toFixed(1)} kHz`,
        i.deviceRate === i.sampleRate ? 'Matched, no resampling.' : 'Different rates add resampling delay. Choose "Match my interface".') : item(true, `App sample rate ${(i.sampleRate / 1000).toFixed(1)} kHz`, 'The interface did not report its rate.'),
      item(!ms || ms <= 25, ms ? `Delay through the app: about ${ms} ms` : 'Delay: not reported by this browser', ms > 25 ? 'Try Latency: Lowest, and a 64–128 sample buffer in your interface’s control panel.' : 'Good for playing along.'),
      item(true, 'Driver: system audio (WASAPI on Windows, Core Audio on Mac)', 'ASIO drivers can’t be used by the app’s browser engine.'),
    ];
    list.replaceChildren(...rows);
  };

  // ---------------------------------------------------------------------
  // Boot
  const savedPreset = store.get('preset', 'piano');
  if (S.PRESETS[savedPreset]) setPreset(savedPreset);
  applySettings();
  applyGuitarSettings();
  buildKeyboard();
  setScale(0, 'major');
  renderJamEmpty();
  renderMsgs();
  // ---------------------------------------------------------------------
  // Playful touches: the background follows the mouse, and clicking the title
  // plays a riff, sends notes floating up and washes the app in colour.
  const calm = () => !!settings.motion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  (function livingBackground() {
    const cv = $('fx-bg'), ctx = cv.getContext('2d');
    if (!ctx) return;
    let W = 0, H = 0, dpr = 1, t = 0, frame = 0, raf = 0;
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, on: false, power: 0 };
    let col = {}, dark = false;
    function readColours() {
      const cs = getComputedStyle(document.body);
      col = { mode: cs.getPropertyValue('--mode').trim() || '#7c4dff', fg: cs.getPropertyValue('--fg').trim() || '#222',
        pal: ['--c-free', '--c-jam', '--c-scale', '--c-settings', '--c-guide'].map((v) => cs.getPropertyValue(v).trim()) };
      const m = (cs.backgroundColor.match(/\d+/g) || [255, 255, 255]).map(Number);
      dark = (m[0] + m[1] + m[2]) / 3 < 110;
    }
    // Staves: groups of five lines that gently ripple on their own.
    const wave = (x, si, l) => Math.sin(x * 0.006 + t * 0.6 + si * 2 + l * 0.15) * 4;
    // The staves under the keyboard live in a reserved strip of the page (#staff-room):
    // yours on top and, in Jam Mode, a second one for the jam's notes.
    let lowY = 0, lowTarget = 0, jamOn = 0, staffOn = 1;
    const JAM_GAP = 112;
    const jamY = () => lowY + JAM_GAP;
    function placeLowStaff(snap) {
      const room = $('staff-room'), top = room ? room.getBoundingClientRect().top : H * 0.7;
      lowTarget = top + 64;
      if (snap || !lowY) lowY = lowTarget;
    }
    /* Notation. Notes are spelled in the current key (scale in Scale Mode, the song's key in Jam
     * Mode, C major otherwise), with the key signature after the clef and accidentals only where a
     * note differs from the signature or from an earlier accidental in the same bar. Each line picks a
     * treble or bass clef from its first notes; notes far outside it fold by an octave, marked 8va/8vb.
     * With the metronome on, or a Jam song playing, notes sit where they fall in the bar (8th-note grid)
     * and show how long they were held; otherwise they're written as quarter notes, a bar per meter. */
    const CLEF_REF = { treble: 34, bass: 22 };   // diatonic number of the middle line: B4 / D3
    const SIG_STEPS = { sharp: [4, 1, 5, 2, -1, 3, 0], flat: [0, 3, -1, 2, -2, 1, -3] };   // treble; bass is 2 lower
    const PX_BEAT = 56, BAR_PAD = 20, COL = 56;
    function placeNote(midi, line) {
      const sp = T.spellNote(midi, line.sig);
      let step = sp.dia - CLEF_REF[line.clef], oct = '';
      while (step > 11) { step -= 7; oct = '8va'; }
      while (step < -11) { step += 7; oct = '8vb'; }
      return { sp, step, oct };
    }
    // Accidental to print: only where the note differs from what the bar already says.
    function accidental(sp, line, barKey) {
      const k = barKey + ':' + sp.dia;
      const cur = line.acc.has(k) ? line.acc.get(k) : line.sig.acc[sp.letter];
      if (sp.acc === cur) return '';
      line.acc.set(k, sp.acc);
      return ({ '-2': '𝄫', '-1': '♭', 0: '♮', 1: '♯', 2: '𝄪' })[sp.acc];
    }
    const headerWidth = (sig) => 50 + Math.abs(sig.count) * 11 + 30;
    function staffKey() {
      if (state.mode === 'jam' && state.jam.key) return state.jam.key;
      if (state.mode === 'scale') return { rootPc: state.scale.root, scaleId: state.scale.id };
      return { rootPc: 0, scaleId: 'major' };
    }
    const meter = () => { const g = state.mode === 'jam' ? songBeats() : null; return g ? g.bpb : (metro.on ? metro.beatsPerBar : settings.metroBpb) || 4; };
    // Where we are in the bar right now, in beats (pos counts beats from the first bar), or null without a beat.
    function staffClock() {
      const c = engine.ctx; if (!c) return null;
      if (state.mode === 'jam' && player.playing) {
        const g = songBeats();
        if (g) {
          const sT = player.heard, b = g.beats;
          let lo = 0, hi = b.length - 1;
          if (sT < b[0] || sT >= b[hi]) return null;
          while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m] <= sT) lo = m; else hi = m; }
          return { pos: lo - g.di + (sT - b[lo]) / (b[lo + 1] - b[lo]), bpb: g.bpb };
        }
      }
      if (metro.on) {
        const t = c.currentTime - (c.outputLatency || 0), q = metro.beatAt(t);
        if (!q) return null;
        return { pos: q.bar * metro.beatsPerBar + q.beat + (t - q.time) * metro.bpm / 60, bpb: metro.beatsPerBar };
      }
      return null;
    }
    const INTERVALS = ['P1', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7', 'P8'];
    // Chord names for notes held together: power chords, triads, sus and seventh chords (octave doublings are fine).
    const CHORDS = [['5', [0, 7]], ['', [0, 4, 7]], ['m', [0, 3, 7]], ['°', [0, 3, 6]], ['+', [0, 4, 8]], ['sus2', [0, 2, 7]], ['sus4', [0, 5, 7]],
      ['7', [0, 4, 7, 10]], ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['m7♭5', [0, 3, 6, 10]], ['°7', [0, 3, 6, 9]], ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]], ['add9', [0, 2, 4, 7]]];
    function chordOf(midis, sig) {
      const pcs = [...new Set(midis.map(T.mod12))];
      if (pcs.length < 2 || pcs.length > 4) return null;
      const bass = T.mod12(Math.min(...midis));
      const nm = (pc) => T.spellNote(60 + pc, sig).name;
      // Prefer the reading whose root is the lowest note, then any other root (an inversion).
      const roots = [bass].concat(pcs.filter((pc) => pc !== bass));
      for (const r of roots) for (const [suf, iv] of CHORDS) {
        if (iv.length !== pcs.length) continue;
        const want = iv.map((i) => T.mod12(r + i));
        if (want.every((pc) => pcs.includes(pc))) return nm(r) + suf + (r !== bass ? '/' + nm(bass) : '');
      }
      return null;
    }
    // Everything written fades the same way: the newest item glows, older ones on the line stay
    // dimmed until the phrase goes quiet or the line starts over.
    const written = [], marks = [];
    let column = null, line = null, cols = 0, lastWrite = 0, quietUntil = 0, lastIntCol = -9;
    function fadeOld(now, staff) {
      written.forEach((n) => { if (n.staff === staff && !n.fadeAt && !n.dim) n.dim = now; });
      marks.forEach((m) => { if (m.staff === staff && !m.fadeAt && !m.keep) m.fadeAt = now; });
    }
    function clearLine(now, staff) {
      written.forEach((n) => { if (n.staff === staff && !n.fadeAt) n.fadeAt = now; });
      marks.forEach((m) => { if (m.staff === staff && !m.fadeAt) m.fadeAt = now; });
    }
    const hue = () => Math.floor(Math.random() * 360);
    function mark(m) { if (settings.staffMarks === false && !m.notation) return; marks.push(Object.assign({ born: performance.now(), fadeAt: 0, hue: hue(), staff: 0 }, m)); if (marks.length > 90) marks.shift(); }
    function startLine(now, midi, clk, key, bpb, slot) {
      clearLine(now, 0);
      const sig = T.keySignature(key.rootPc, key.scaleId), x0 = W * 0.08;
      line = { x0, body: x0 + headerWidth(sig), clef: midi < 57 ? 'bass' : 'treble', sig, sigKey: key.rootPc + ':' + key.scaleId, bpb, timed: !!clk,
        startBar: clk ? Math.floor(slot / bpb) : 0, curBar: clk ? -1 : 0, lastEnd: clk ? Math.floor(slot / bpb) * bpb : null, acc: new Map() };
      mark({ kind: 'clef', x: x0, keep: true, clef: line.clef, sig, bpb, notation: true });
      cols = 0; lastIntCol = -9;
    }
    const barW = () => line.bpb * PX_BEAT + BAR_PAD;
    const slotX = (slot) => { const bar = Math.floor(slot / line.bpb + 1e-9); return line.body + (bar - line.startBar) * barW() + 14 + (slot - bar * line.bpb) * PX_BEAT; };
    // Rests for the silence between the last note's end and this onset (8th, quarter or whole-bar rests).
    function restsBetween(from, to) {
      let t = Math.ceil(from * 2 - 1e-6) / 2;
      while (t < to - 1e-6) {
        const barStart = Math.floor(t / line.bpb + 1e-9) * line.bpb, barEnd = barStart + line.bpb;
        if (Math.abs(t - barStart) < 1e-6 && to >= barEnd - 1e-6) { mark({ kind: 'rest', dur: 4, x: slotX(barStart) + (line.bpb * PX_BEAT) / 2 - 14, keep: true, notation: true }); t = barEnd; continue; }
        const whole = Math.abs(t - Math.round(t)) < 1e-6 && t + 1 <= Math.min(to, barEnd) + 1e-6;
        mark({ kind: 'rest', dur: whole ? 1 : 0.5, x: slotX(t), keep: true, notation: true });
        t += whole ? 1 : 0.5;
      }
    }
    function barLinesTo(bar) {
      while (line.curBar < bar) {
        line.curBar++;
        const b = line.curBar - line.startBar;
        if (b > 0) mark({ kind: 'bar', x: line.body + b * barW() - BAR_PAD / 2 + 2, n: line.curBar - line.startBar + 1, keep: true, notation: true });
      }
    }
    function write(midi) {
      const now = performance.now(), gap = now - lastWrite;
      quietUntil = now + 5000; // the floating notes clear out while you play
      if (!staffEnabled()) return;
      const clk = staffClock(), key = staffKey(), bpb = clk ? clk.bpb : meter();
      const slot = clk ? Math.round(clk.pos * 2) / 2 : null;
      // Stack it in the same column (a chord) when it lands with the last note (same 8th, or within a
      // moment untimed) AND every note already in that column is still held down.
      const together = column && line && (clk ? column.slot === slot : gap < 120) && column.midis.every((m) => state.held.has(m));
      if (!together) {
        const prev = column;
        fadeOld(now, 0);
        let x, newLine = !line || line.sigKey !== key.rootPc + ':' + key.scaleId || line.timed !== !!clk || line.bpb !== bpb;
        if (clk && !newLine && (!prev || slot < prev.slot || slot - line.lastEnd > 2 * bpb || slotX(slot) > W * 0.92)) newLine = true;
        if (!clk && !newLine && (!prev || gap > 4000 || prev.x + COL > W * 0.9)) newLine = true;
        if (newLine) startLine(now, midi, clk, key, bpb, slot);
        if (clk) {
          const bar = Math.floor(slot / bpb + 1e-9);
          barLinesTo(bar);
          const end = line.lastEnd;
          if (end != null && slot - end >= 0.5 && !(prev && !newLine && prev.midis.some((m) => state.held.has(m)))) restsBetween(end, slot);
          line.lastEnd = Math.max(end || 0, slot + 0.5);
          x = slotX(slot);
        } else if (!cols) {
          x = line.body + 14;
        } else {
          x = prev.x + COL;
          if (gap > 1300) { mark({ kind: 'rest', dur: 1, x, keep: true, notation: true }); x += COL - 8; } // a pause becomes a rest
          if (cols % bpb === 0) { line.curBar++; mark({ kind: 'bar', x: x - COL / 2, n: line.curBar + 1, keep: true, notation: true }); x += 8; }
        }
        column = { x, midis: [], first: midi, slot, end: null, bar: clk ? Math.floor(slot / bpb + 1e-9) : line.curBar };
        cols++;
        // Interval names only for leaps of a 4th or more, and never on two notes in a row.
        const d0 = prev ? midi - prev.first : 0;
        if (prev && !newLine && Math.abs(d0) >= 5 && cols - lastIntCol >= 2) {
          lastIntCol = cols;
          const iv = Math.abs(d0) % 12 === 0 && d0 ? 12 : Math.abs(d0) % 12;
          if (prev.x < x) mark({ kind: 'int', x1: prev.x, x2: x, s1: placeNote(prev.first, line).step, s2: placeNote(midi, line).step, text: INTERVALS[iv] + (d0 > 0 ? '↑' : '↓') });
        }
      }
      column.midis.push(midi);
      const pl = placeNote(midi, line);
      written.push({ staff: 0, x: column.x, midi, step: pl.step, oct: pl.oct, accTxt: accidental(pl.sp, line, column.bar), name: pl.sp.name, hue: hue(), born: now, fadeAt: 0,
        timed: line.timed, slot: column.slot, dur: line.timed ? null : 1, col: column });
      if (written.length > 90) written.shift();
      const ch = column.midis.length >= 2 && chordOf(column.midis, line.sig);
      if (ch) {
        const old = marks.find((m) => m.kind === 'chord' && m.x === column.x && m.staff === 0);
        if (old) old.text = ch; else mark({ kind: 'chord', x: column.x, text: ch });
      }
      lastWrite = now;
      if (calm()) draw();
    }
    // Note lengths in the bar: the quantised time a key was held, as 8th, quarter, dotted, half or whole notes.
    const LENGTHS = [4, 3, 2, 1.5, 1, 0.5];
    function heldBeats(n, pos) {
      const barEnd = (Math.floor(n.slot / line.bpb + 1e-9) + 1) * line.bpb;
      const d = Math.min(barEnd - n.slot, Math.max(0.5, Math.round((pos - n.slot) * 2) / 2));
      return LENGTHS.find((l) => l <= d + 1e-6) || 0.5;
    }
    function release(midi) {
      const n = written.slice().reverse().find((o) => o.staff === 0 && o.midi === midi && o.timed && o.dur == null);
      if (!n || !line || !line.timed) return;
      const clk = staffClock();
      n.dur = clk ? heldBeats(n, clk.pos) : 1;
      n.col.end = Math.max(n.col.end || 0, n.slot + n.dur);
      line.lastEnd = Math.max(line.lastEnd || 0, n.slot + n.dur);
    }
    bgWrite = write; bgRelease = release;
    window.__staff = { written, marks }; // for tests

    // Jam Mode's staff: the suggested phrase, in the song's key and meter. The next note glows, notes
    // you've played dissipate, and the chord the song is on is written above it.
    let jamSig = '', jamChord = '', jamIdx = -1, jamLine = null;
    function syncJam(now) {
      const on = staffEnabled() && settings.staffJam !== false && state.mode === 'jam' && state.jam.key && state.riff.tab !== 'riff';
      jamOn += ((on ? 1 : 0) - jamOn) * 0.08;
      const s = on && $('g-suggest').checked ? state.jam.sugg : null;
      const key = state.jam.key, bpb = meter();
      const sig = s && s.notes.length ? s.notes.join(',') + '|' + key.rootPc + key.scaleId + bpb : '';
      if (sig !== jamSig) {
        jamSig = sig; clearLine(now, 1);
        jamChord = ''; jamIdx = -1;
        if (sig) {
          const ks = T.keySignature(key.rootPc, key.scaleId), x0 = W * 0.08;
          const sorted = s.notes.slice().sort((p, q) => p - q), median = sorted[sorted.length >> 1];
          jamLine = { x0, body: x0 + headerWidth(ks), clef: median < 57 ? 'bass' : 'treble', sig: ks, acc: new Map(), bpb };
          mark({ kind: 'clef', x: x0, keep: true, staff: 1, clef: jamLine.clef, sig: ks, bpb, notation: true });
          s.notes.forEach((m, i) => {
            const bar = Math.floor(i / bpb), x = jamLine.body + 14 + i * COL + bar * 10;
            if (i && i % bpb === 0) mark({ kind: 'bar', x: x - COL / 2 - 2, n: bar + 1, keep: true, staff: 1, notation: true });
            const pl = placeNote(m, jamLine);
            written.push({ staff: 1, i, x, midi: m, step: pl.step, oct: pl.oct, accTxt: accidental(pl.sp, jamLine, bar), name: pl.sp.name, dur: 1, hue: hue(), born: now + i * 70, fadeAt: 0 });
          });
        }
      }
      if (!sig) return;
      if (s.idx !== jamIdx) {
        jamIdx = s.idx;
        written.forEach((n) => { if (n.staff === 1 && !n.fadeAt && n.i < s.idx) n.fadeAt = now; });
      }
      const ch = on ? currentChord() : null, name = ch ? ch.name : '';
      if (name !== jamChord) {
        marks.forEach((m) => { if (m.staff === 1 && m.kind === 'chord' && !m.fadeAt) m.fadeAt = now; });
        jamChord = name;
        // The song's chord sits inside the staff, just after the phrase.
        const nN = s.notes.length, endX = jamLine.body + 14 + (nN - 1) * COL + Math.floor((nN - 1) / jamLine.bpb) * 10 + 44;
        if (name) mark({ kind: 'chord', x: endX, text: name, staff: 1, inline: true, notation: true });
      }
    }
    // How visible an item is right now, and whether it is the glowing newest one.
    function life(n, now) {
      if (n.born > now) return 0;
      if (n.fadeAt) return 0.7 * Math.max(0, 1 - (now - n.fadeAt) / 2600); // the line started over: dissipate
      if (n.staff === 1) return jamOn; // the jam phrase stays while it's the current one
      const since = now - Math.max(n.born, n.keep || n.dim ? lastWrite : 0);
      const k = since < 6000 ? 1 : Math.max(0, 1 - (since - 6000) / 3000); // hold, then fade once you stop playing
      return n.dim ? k * Math.max(0.5, 1 - (now - n.dim) / 1200 * 0.5) : k; // older notes on the line settle to half
    }
    const baseY = (staff) => (staff === 1 ? jamY() : lowY);
    const sOf = (staff) => (staff === 1 ? 3 : 2); // which wave the staff follows
    function colour(h) { return `hsl(${h} 85% ${dark ? 65 : 48}%)`; }
    function underline(x, ty, si, w) {
      ctx.beginPath();
      for (let ux = x - w; ux <= x + w; ux += 2) {
        const uy = ty + 13 + wave(ux * 6, si, 4) * 0.8;
        ux === x - w ? ctx.moveTo(ux, uy) : ctx.lineTo(ux, uy);
      }
      ctx.stroke();
    }
    let clkNow = null;
    function drawWritten(now) {
      if (!staffEnabled()) { written.length = 0; marks.length = 0; column = null; line = null; jamSig = ''; return; } // follow-along switched off
      clkNow = written.some((n) => n.dur == null) ? staffClock() : null;
      for (let i = written.length - 1; i >= 0; i--) {
        const n = written[i];
        let a = life(n, now);
        if (n.fadeAt && a <= 0.005) { written.splice(i, 1); continue; }
        if (n.staff === 0 && a <= 0.005) { written.splice(i, 1); continue; }
        // On the jam staff only the next note glows; the ones after it wait, dimmed.
        const next = n.staff === 1 && !n.fadeAt && n.i === jamIdx;
        if (n.staff === 1 && !n.fadeAt && !next) a *= 0.45;
        if (a <= 0.005) continue;
        const si = sOf(n.staff), y0 = baseY(n.staff);
        const pop = Math.max(0, Math.min(1, (now - n.born) / 160)), glow = n.staff === 0 ? !n.fadeAt && !n.dim : next;
        const c = colour(n.hue);
        const x = n.x, y = y0 + wave(x, si, 2) - n.step * 6.5;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.6;
        for (let s = 6; s <= Math.abs(n.step); s += 2) { // ledger lines above or below the staff
          const ly = y0 + wave(x, si, 2) - Math.sign(n.step) * s * 6.5;
          ctx.beginPath(); ctx.moveTo(x - 14, ly); ctx.lineTo(x + 14, ly); ctx.stroke();
        }
        if (glow) { ctx.shadowColor = c; ctx.shadowBlur = 18; }
        // Length: held notes grow with the beat; untimed notes are quarters.
        let dur = n.dur;
        if (dur == null) dur = clkNow && line && line.timed ? heldBeats(n, clkNow.pos) : 1;
        const hollow = dur >= 2, up = n.step < 0;
        ctx.beginPath(); ctx.ellipse(x, y, 8.5 * (0.6 + 0.4 * pop), 6.2 * (0.6 + 0.4 * pop), -0.35, 0, Math.PI * 2);
        if (hollow) { ctx.lineWidth = 2.2; ctx.stroke(); ctx.lineWidth = 1.6; } else ctx.fill();
        // One stem per chord column: only its outermost note carries it.
        const mates = written.filter((o) => o.staff === n.staff && o.x === x && !o.fadeAt === !n.fadeAt);
        const outer = up ? Math.min(...mates.map((o) => o.step)) === n.step : Math.max(...mates.map((o) => o.step)) === n.step;
        if (dur < 4 && (mates.length < 2 || outer)) {
          const span = mates.length > 1 ? (Math.max(...mates.map((o) => o.step)) - Math.min(...mates.map((o) => o.step))) * 6.5 : 0;
          const sx = up ? x + 7.6 : x - 7.6, sy0 = up ? y - 2 : y + 2, sy1 = up ? y - 40 - span : y + 40 + span;
          ctx.beginPath(); ctx.moveTo(sx, sy0); ctx.lineTo(sx, sy1); ctx.stroke();
          if (dur === 0.5) { // an eighth note's flag
            ctx.beginPath(); ctx.moveTo(sx, sy1);
            const dy = up ? 1 : -1; ctx.bezierCurveTo(sx + 1, sy1 + 9 * dy, sx + 13, sy1 + 11 * dy, sx + 11, sy1 + 25 * dy);
            ctx.lineWidth = 2.2; ctx.stroke(); ctx.lineWidth = 1.6;
          }
        }
        if (dur === 1.5 || dur === 3) { ctx.beginPath(); ctx.arc(x + 14, y - (n.step % 2 === 0 ? 4 : 0), 2.2, 0, Math.PI * 2); ctx.fill(); } // dotted
        ctx.font = '600 16px "Noto Music", "IBM Plex Sans", system-ui, sans-serif';
        if (n.accTxt) ctx.fillText(n.accTxt, x - 22, y + 1);
        if (n.oct) { ctx.font = '600 11px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillText(n.oct, x, n.oct === '8va' ? Math.min(y - 46, y0 - 42) : Math.max(y + 46, y0 + 44)); }
        // The letter under the staff, with an underline that ripples like the staff lines.
        // Notes stacked in one column (a chord) list their letters downwards.
        const below = written.filter((o) => o.staff === n.staff && o.x === x && o.born < n.born && !o.fadeAt === !n.fadeAt).length;
        const ty = y0 + 58 + below * 17 + wave(x, si, 4);
        ctx.font = '700 17px "Bricolage Grotesque", system-ui, sans-serif';
        ctx.fillText(n.name, x, ty);
        ctx.shadowBlur = glow ? 10 : 0; ctx.lineWidth = 2;
        if (!written.some((o) => o.staff === n.staff && o.x === x && o.born > n.born && !o.fadeAt === !n.fadeAt)) underline(x, ty, si, 16);
        ctx.restore();
      }
      for (let i = marks.length - 1; i >= 0; i--) {
        const m = marks[i], a = life(m, now) * (m.staff === 1 ? 0.85 : 1);
        if (a <= 0.005) { if (m.fadeAt || m.staff === 0) marks.splice(i, 1); continue; }
        const si = sOf(m.staff), y0 = baseY(m.staff), c = colour(m.hue), glow = !m.fadeAt;
        ctx.save();
        ctx.globalAlpha = a; ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 2;
        if (glow) { ctx.shadowColor = c; ctx.shadowBlur = 14; }
        if (m.kind === 'clef') {
          // Clef, key signature and time signature, riding the staff's ripple.
          const cy = y0 + wave(m.x, si, 2), bass = m.clef === 'bass';
          ctx.font = bass ? '400 62px "Noto Music", "Segoe UI Symbol", "Apple Symbols", serif' : '400 64px "Noto Music", "Segoe UI Symbol", "Apple Symbols", serif';
          ctx.fillText(bass ? '𝄢' : '𝄞', m.x, bass ? cy + 6 : cy + 4);
          const sg = m.sig || { count: 0 }, n = Math.abs(sg.count), steps = sg.count > 0 ? SIG_STEPS.sharp : SIG_STEPS.flat;
          ctx.font = '600 19px "Noto Music", "IBM Plex Sans", system-ui, sans-serif';
          for (let i = 0; i < n; i++) ctx.fillText(sg.count > 0 ? '♯' : '♭', m.x + 44 + i * 11, cy - (steps[i] - (bass ? 2 : 0)) * 6.5 + (sg.count > 0 ? 3 : 1));
          ctx.font = '800 22px "Bricolage Grotesque", system-ui, sans-serif';
          const tx = m.x + 50 + n * 11 + 6;
          ctx.fillText(String(m.bpb || 4), tx, cy - 12); ctx.fillText('4', tx, cy + 14);
        } else if (m.kind === 'bar') {
          ctx.beginPath();
          for (let l = 0; l < 5; l++) { const yy = y0 + (l - 2) * 13 + wave(m.x, si, l); l ? ctx.lineTo(m.x, yy) : ctx.moveTo(m.x, yy); }
          ctx.stroke();
          ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif';
          ctx.fillText(String(m.n), m.x, y0 + 38 + wave(m.x, si, 4));
        } else if (m.kind === 'rest') {
          const yy = y0 + wave(m.x, si, 2);
          if (m.dur === 4) { ctx.fillRect(m.x - 9, yy - 13, 18, 6.5); }   // whole-bar rest: hangs from the 4th line
          else if (m.dur === 0.5) {   // eighth rest: a dot and a slanted stroke
            ctx.beginPath(); ctx.arc(m.x - 3, yy - 5, 3, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.moveTo(m.x - 3, yy - 3); ctx.quadraticCurveTo(m.x + 2, yy - 2, m.x + 6, yy - 8); ctx.lineTo(m.x - 1, yy + 14);
            ctx.lineWidth = 2.2; ctx.stroke();
          } else {   // quarter rest, drawn as the usual zig-zag
            ctx.beginPath();
            ctx.moveTo(m.x - 4, yy - 18); ctx.lineTo(m.x + 5, yy - 7); ctx.lineTo(m.x - 4, yy + 3); ctx.lineTo(m.x + 5, yy + 13);
            ctx.quadraticCurveTo(m.x - 8, yy + 9, m.x - 1, yy + 20);
            ctx.lineWidth = 3; ctx.stroke();
          }
        } else if (m.kind === 'int') {
          // A slur from the previous note to this one, with the interval written over it.
          const ya = y0 + wave(m.x1, si, 2) - m.s1 * 6.5, yb = y0 + wave(m.x2, si, 2) - m.s2 * 6.5;
          const top = Math.min(ya, yb, y0 - 26) - 14;
          ctx.lineWidth = 1.8;
          ctx.beginPath(); ctx.moveTo(m.x1 + 4, ya - 9); ctx.quadraticCurveTo((m.x1 + m.x2) / 2, top - 10, m.x2 - 4, yb - 9); ctx.stroke();
          ctx.font = '700 13px "IBM Plex Sans", system-ui, sans-serif';
          ctx.fillText(m.text, (m.x1 + m.x2) / 2, top - 14);
        } else if (m.kind === 'chord') {
          const ty = m.inline ? y0 + 6 + wave(m.x, si, 2) : y0 - 58 + wave(m.x, si, 0); // the jam's chord sits inside its staff, after the clef
          ctx.font = '800 20px "Bricolage Grotesque", system-ui, sans-serif';
          ctx.fillText(m.text, m.x, ty);
          ctx.shadowBlur = 0; underline(m.x, ty - 4, si, Math.max(12, ctx.measureText(m.text).width / 2 + 4));
        }
        ctx.restore();
      }
    }
    // Drifting notes and dots.
    const GLYPHS = ['♪', '♫', '♩', '♬', '•', '•', '·'];
    let parts = [];
    function seed() {
      const n = Math.round(Math.min(95, Math.max(36, (W * H) / 15000)));
      parts = Array.from({ length: n }, (_, i) => ({
        x: Math.random() * W, y: Math.random() * H, ox: 0, oy: 0, vx: 0, vy: 0,
        sx: (Math.random() - 0.5) * 0.25, sy: -(0.08 + Math.random() * 0.3),
        fade: 1, g: GLYPHS[i % GLYPHS.length], size: 14 + Math.random() * 20, c: i % 5, ph: Math.random() * 6.28, spin: (Math.random() - 0.5) * 0.4, glow: 0,
      }));
    }
    // New notes start just below the bottom edge, out of sight, and drift up into view.
    function respawn(p) {
      p.parked = false; p.fade = 1; p.ox = p.oy = p.vx = p.vy = 0; p.push = 0; p.exit = 0;
      p.x = Math.random() * W; p.y = H + 30 + Math.random() * 120;
    }
    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1); W = window.innerWidth; H = window.innerHeight;
      cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!parts.length) seed();
      placeLowStaff(true);
    }
    const rgbCache = new Map();
    function alpha(c, a) {
      let rgb = rgbCache.get(c);
      if (!rgb) {
        ctx.fillStyle = '#000'; ctx.fillStyle = c; const v = ctx.fillStyle; // canvas normalises any CSS colour
        rgb = v[0] === '#' ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : (v.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
        rgbCache.set(c, rgb);
      }
      return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
    }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      const R = 220;
      // Staff lines
      ctx.lineWidth = 1;
      // Staves only appear with staff follow-along on, and then just the note staff under the keyboard.
      staffOn += ((staffEnabled() ? 1 : 0) - staffOn) * 0.08;
      const lines = staffOn > 0.01 ? [[lowY, 2, staffOn]] : [];
      if (jamOn > 0.01) lines.push([jamY(), 3, jamOn]); // Jam Mode's own staff under yours
      lines.forEach(([y0, si, k]) => {
        for (let l = 0; l < 5; l++) {
          const base = y0 + (l - 2) * 13;
          ctx.beginPath();
          for (let x = 0; x <= W; x += 12) {
            const y = base + wave(x, si, l);
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.strokeStyle = alpha(col.fg, (dark ? 0.14 : 0.1) * k); ctx.stroke();
        }
      });
      // Notes and dots
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const now = performance.now();
      for (const p of parts) {
        if (p.parked) continue;
        const px = p.x + p.ox, py = p.y + p.oy, dx = px - mouse.x, dy = py - mouse.y, d = Math.hypot(dx, dy) || 1;
        const near = mouse.power > 0.01 && d < R ? (1 - d / R) * mouse.power : 0;
        p.glow += (near - p.glow) * 0.12;
        const a = ((dark ? 0.28 : 0.22) + p.glow * 0.7) * p.fade;
        if (a < 0.005) continue;
        const sc = 1 + p.glow * 0.6;
        ctx.save(); ctx.translate(px, py); ctx.rotate(Math.sin(t * 0.7 + p.ph) * p.spin + p.glow * 0.5 * Math.sign(dx));
        ctx.fillStyle = alpha(p.glow > 0.15 ? col.pal[p.c] || col.mode : col.fg, Math.min(0.95, a));
        if (p.glow > 0.2) { ctx.shadowColor = col.pal[p.c] || col.mode; ctx.shadowBlur = 12 * p.glow; }
        ctx.font = `${Math.round(p.size * sc)}px "Bricolage Grotesque", system-ui, sans-serif`;
        ctx.fillText(p.g, 0, 0); ctx.restore();
      }
      syncJam(now);
      drawWritten(now);
    }
    function step() {
      t += 1 / 60; frame++;
      if (frame % 45 === 1) { readColours(); placeLowStaff(); }
      lowY += (lowTarget - lowY) * 0.08;
      const target = mouse.on ? 1 : 0;
      mouse.power += (target - mouse.power) * 0.05;
      mouse.x += (mouse.tx - mouse.x) * 0.14; mouse.y += (mouse.ty - mouse.y) * 0.14;
      const R = 220, quiet = performance.now() < quietUntil;
      for (const p of parts) {
        p.x += p.sx + Math.sin(t * 0.5 + p.ph) * 0.15; p.y += p.sy;
        // Pushed aside by the mouse, then springs back to its own path.
        const dx = p.x + p.ox - mouse.x, dy = p.y + p.oy - mouse.y, d = Math.hypot(dx, dy) || 1;
        if (mouse.power > 0.01 && d < R) { const f = (1 - d / R) * 1.6 * mouse.power; p.vx += (dx / d) * f; p.vy += (dy / d) * f; }
        p.vx += -p.ox * 0.02; p.vy += -p.oy * 0.02; p.vx *= 0.86; p.vy *= 0.86; p.ox += p.vx; p.oy += p.vy;
        if (p.parked) { if (!quiet) respawn(p); continue; }
        // While you play (and for 5 s after), every floating note is sent off screen: up if it's
        // above the staff, down if it's below.
        if (quiet) {
          const y = p.y + p.oy;
          if (!p.exit) p.exit = y < lowY ? -1 : 1;
          if (p.exit) { p.push = Math.min(16, (p.push || 2) * 1.15); p.y += p.exit * p.push; } // keeps going until it's off screen
          if (p.y > H + 30) p.parked = true; // gone: stays away until things are quiet again
        } else { p.exit = 0; p.push = 0; }
        if (p.y < -30) { if (quiet) p.parked = true; else respawn(p); }
        if (p.x < -30) p.x = W + 30; else if (p.x > W + 30) p.x = -30;
      }
      draw();
      raf = requestAnimationFrame(step);
    }
    function start() { cancelAnimationFrame(raf); readColours(); if (calm()) { draw(); return; } raf = requestAnimationFrame(step); }
    window.addEventListener('pointermove', (e) => {
      mouse.tx = e.clientX; mouse.ty = e.clientY; mouse.on = true;
      if (mouse.x < -1000) { mouse.x = e.clientX; mouse.y = e.clientY; }
    }, { passive: true });
    document.addEventListener('pointerleave', () => { mouse.on = false; });
    document.documentElement.addEventListener('mouseleave', () => { mouse.on = false; });
    window.addEventListener('blur', () => { mouse.on = false; });
    window.addEventListener('resize', () => { resize(); if (calm()) draw(); });
    window.addEventListener('scroll', () => { placeLowStaff(true); if (calm()) draw(); }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(raf); else start(); });
    document.addEventListener('mt-access', () => start()); // Accessibility settings changed (motion or colours)
    resize(); start();
  })();

  const FX_COLORS = ['--c-free', '--c-jam', '--c-scale', '--c-settings', '--c-guide'];
  const fxColor = (i) => getComputedStyle(document.documentElement).getPropertyValue(FX_COLORS[i % FX_COLORS.length]).trim();
  function playTitleRiff() {
    try { engine.ensure(); } catch (e) { return; }
    // A bright major-pentatonic run that climbs and lands on the octave.
    const riff = [[67, 0], [69, 1], [72, 2], [74, 3], [76, 4], [79, 5], [81, 6], [79, 7], [84, 8.5]];
    const step = 115;
    riff.forEach(([m, t], i) => {
      const len = i === riff.length - 1 ? 700 : step * 0.9;
      setTimeout(() => { engine.noteOn(m, 0.75); const k = keyEls.get(m); if (k) k.classList.add('down'); }, t * step);
      setTimeout(() => { engine.noteOff(m); const k = keyEls.get(m); if (k) k.classList.remove('down'); }, t * step + len);
    });
  }
  function floatNotes(cx) {
    const layer = $('fx-notes'), glyphs = ['♪', '♫', '♩', '♬', '𝄞'], w = window.innerWidth, h = window.innerHeight;
    for (let i = 0; i < 34; i++) {
      const n = el('span', { class: 'fx-note' }, glyphs[i % glyphs.length]);
      const size = 18 + Math.random() * 46, x = Math.random() < 0.4 ? cx + (Math.random() - 0.5) * 300 : Math.random() * w;
      Object.assign(n.style, { left: x + 'px', top: (h * (0.55 + Math.random() * 0.5)) + 'px', fontSize: size + 'px', color: fxColor(i) });
      layer.append(n);
      const rise = h * (0.35 + Math.random() * 0.45), drift = (Math.random() - 0.5) * 160, spin = (Math.random() - 0.5) * 70;
      const a = n.animate([
        { transform: 'translate(0,0) rotate(0) scale(.6)', opacity: 0 },
        { opacity: 0.9, offset: 0.2 },
        { transform: `translate(${drift}px,${-rise}px) rotate(${spin}deg) scale(1)`, opacity: 0 }
      ], { duration: 2400 + Math.random() * 1800, delay: Math.random() * 900, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' });
      a.onfinish = () => n.remove();
    }
  }
  function splash(cx, cy) {
    document.querySelectorAll('.fx-splash, .fx-ring').forEach((n) => n.remove());
    const far = Math.hypot(Math.max(cx, window.innerWidth - cx), Math.max(cy, window.innerHeight - cy)) + 40;
    const at = `at ${cx}px ${cy}px`;
    // Two layers: one recolours text and controls, one tints the light surfaces.
    ['fx-splash', 'fx-splash fx-tint'].forEach((cls) => {
      const wash = el('div', { class: cls }); document.body.append(wash);
      const o = +getComputedStyle(wash).getPropertyValue('--fx-o') || 1;
      wash.animate([
      { clipPath: `circle(0px ${at})`, backgroundPosition: '0% 50%', opacity: o },
      { clipPath: `circle(${far}px ${at})`, backgroundPosition: '40% 50%', opacity: o, offset: 0.35 },
      { clipPath: `circle(${far}px ${at})`, backgroundPosition: '75% 50%', opacity: o * 0.9, offset: 0.7 },
      { clipPath: `circle(${far}px ${at})`, backgroundPosition: '100% 50%', opacity: 0 }
      ], { duration: 2600, easing: 'ease-in-out', fill: 'both' }).onfinish = () => wash.remove();
    });
    for (let i = 0; i < 4; i++) {
      const ring = el('div', { class: 'fx-ring' }); ring.style.left = cx + 'px'; ring.style.top = cy + 'px'; ring.style.setProperty('--c', fxColor(i));
      document.body.append(ring);
      const d = (r) => ({ width: r * 2 + 'px', height: r * 2 + 'px', margin: -r + 'px 0 0 ' + -r + 'px' });
      ring.animate([{ ...d(6), opacity: 0.9 }, { ...d(far * (0.55 + i * 0.12)), opacity: 0 }],
        { duration: 1500, delay: i * 180, easing: 'cubic-bezier(.15,.6,.3,1)', fill: 'both' }).onfinish = () => ring.remove();
    }
  }
  function titleParty(e) {
    playTitleRiff();
    const r = $('brand-title').getBoundingClientRect();
    const cx = e && e.clientX ? e.clientX : r.left + r.width / 2, cy = e && e.clientY ? e.clientY : r.top + r.height / 2;
    floatNotes(cx);
    if (!calm()) splash(cx, cy);
  }
  $('brand-title').onclick = titleParty;
  $('brand-title').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); titleParty(); } };

  const hash = location.hash.replace('#', '');
  switchMode(['free', 'scale', 'jam', 'learn', 'guide', 'settings'].includes(hash) ? hash : store.get('mode', 'free'));
  checkCoach(false);

  // ---------------------------------------------------------------------
  // First-run tour: a guided walk through every part of the app and its settings. It opens by itself
  // the first time the app is opened (until finished or skipped), and "Getting started" (top left) replays it.
  const TOUR = [
    { title: 'Welcome to Music Theorizer', text: 'This short tour shows what each part of the app is for and where the settings live. It takes about a minute. Use Next (or the → key) to move on.' },
    { el: '.tabs', mode: 'free', title: 'Five screens', text: 'Free Play, Scale Mode and Jam Mode are the three ways to play, Exercises teaches the theory step by step, and Settings holds everything you can change. Each screen has its own colour.' },
    { el: '.kbd-wrap', title: 'The keyboard', text: 'Play with the mouse, touch, your computer keys (the letters on the keys) or a MIDI keyboard. − and + change the octaves shown; "Note names" and "Key letters" turn the labels on and off. Number keys 1–9 play the numbered suggestions.' },
    { el: '#strip-preset', title: 'Instrument and sound', text: 'Pick the sound the keyboard makes: pianos and keys, guitars, basses, strings, brass and winds, mallets, voices and synths. The ⚙ next to it sets volume, reverb and the song volume. In Riff Mode the sound follows the instrument the riff came from.' },
    { el: '.metro-menu', title: 'Metronome', text: 'Click the metronome to start or stop the click; its ⚙ sets tempo, tap tempo, beats per bar and volume. In Jam Mode it follows the song\u2019s own beat.' },
    { el: '#mode-free', mode: 'free', title: 'Free Play', text: 'Play anything. The scale identifier listens and suggests which scales your notes belong to, with a mini keyboard of each one. "Try an example riff" plays one for you.' },
    { el: '#mode-scale', mode: 'scale', title: 'Scale Mode', text: 'Pick a root and a scale to see its notes lit on the keyboard, hear it, learn its step pattern and the chords that belong to it. You can lock the keyboard to the scale so wrong notes can\u2019t sound.' },
    { el: '#mode-jam', mode: 'jam', title: 'Jam Mode', text: 'Load a demo song or upload your own. The app finds the key, tempo and chords, then lights the keys that fit so you can play along. After a song loads you get four tools: Play along, Riff Mode (learn the song\u2019s riff), Guitar (plug in a guitar, amp sounds and a tuner) and Instruments (split the song into drums, bass, vocals and more).' },
    { el: '#mode-learn', mode: 'learn', title: 'Exercises', text: 'A course from the note names on the keyboard up to chords, modes and progressions, answered on the keyboard with stars for each lesson. "Practise a scale" makes exercises for any scale and recommends the easier ones first.' },
    { el: '#coach-toggle', title: 'AI Coach', text: 'Ask questions about scales, chords or what to play. The coach sees what you\u2019re doing, and it can play examples on the keyboard: try "play me a riff". It works offline with simple answers; Settings explains how to connect the full AI.' },
    { el: '#level-settings', mode: 'settings', title: 'Settings: detail level', text: 'Beginner shows just the essentials. Advanced adds the extra tools: the staff that writes out what you play, the song map, MIDI, pitch and mod wheels, analysis engines and audio options. Switch any time; nothing is lost.' },
    { el: '#access-settings', mode: 'settings', title: 'Settings: accessibility', text: 'In Advanced detail: colour palettes for colour vision differences, chord stripes, high contrast, bigger text and reduced motion. Dark mode and keyboard size are in the groups above.' },
    { el: '#mode-guide', mode: 'settings', title: 'Settings: AI Coach setup', text: 'Step-by-step instructions for running the AI on your own computer, plus the connection settings and a button that checks every step.' },
    { el: '#tour-again', mode: 'free', title: 'You\u2019re ready', text: 'That\u2019s everything. "Getting started", top left, takes you through this tour again whenever you like. Have fun playing!' },
  ];
  const tour = { i: -1, root: null };
  function tourEls() {
    if (tour.root) return tour.root;
    const spot = el('div', { class: 'tour-spot' });
    const card = el('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' },
      el('div', { class: 'tour-step mono', id: 'tour-step' }),
      el('h3', { id: 'tour-title' }),
      el('p', { id: 'tour-text' }),
      el('div', { class: 'tour-nav' },
        el('button', { class: 'btn small tour-skip', id: 'tour-skip', onclick: () => endTour(false) }, 'Skip tour'),
        el('span', { class: 'tour-gap' }),
        el('button', { class: 'btn small', id: 'tour-back', onclick: () => showTour(tour.i - 1) }, 'Back'),
        el('button', { class: 'btn small primary', id: 'tour-next', onclick: () => showTour(tour.i + 1) }, 'Next')));
    tour.root = el('div', { class: 'tour', id: 'tour', hidden: true }, spot, card);
    tour.spot = spot; tour.card = card;
    document.body.append(tour.root);
    return tour.root;
  }
  const visible = (e) => e && e.offsetParent !== null && e.getClientRects().length > 0;
  function showTour(i) {
    if (i >= TOUR.length) return endTour(true);
    if (i < 0) return;
    tour.i = i;
    const st = TOUR[i];
    if (st.mode && state.mode !== st.mode) switchMode(st.mode);
    if (st.mode === 'settings' && st.el === '#mode-guide') $('mode-guide').open = false;
    $('tour-step').textContent = (i + 1) + ' of ' + TOUR.length;
    $('tour-title').textContent = st.title; $('tour-text').textContent = st.text;
    $('tour-back').disabled = i === 0;
    $('tour-next').textContent = i === TOUR.length - 1 ? 'Finish' : 'Next';
    const target = st.el ? document.querySelector(st.el) : null;
    tour.target = visible(target) ? target : null;
    if (tour.target) tour.target.scrollIntoView({ block: 'center', behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
    placeTour();
    setTimeout(placeTour, 80);   // after the mode switch's slide-in
    $('tour-next').focus();
  }
  function placeTour() {
    if (tour.i < 0) return;
    const spot = tour.spot, card = tour.card, pad = 8, vw = window.innerWidth, vh = window.innerHeight;
    const cw = Math.min(380, vw - 32);
    card.style.width = cw + 'px';
    const ch = card.offsetHeight;
    if (!tour.target) {
      spot.classList.add('none');
      card.style.left = (vw - cw) / 2 + 'px'; card.style.top = Math.max(16, (vh - ch) / 2) + 'px';
      return;
    }
    const r = tour.target.getBoundingClientRect();
    const top = Math.max(4, r.top - pad), bottom = Math.min(vh - 4, r.bottom + pad);
    spot.classList.remove('none');
    Object.assign(spot.style, { left: r.left - pad + 'px', top: top + 'px', width: r.width + 2 * pad + 'px', height: Math.max(0, bottom - top) + 'px' });
    // The card goes below the highlight, else above, else beside it, else over its lower edge.
    let y;
    if (bottom + 12 + ch <= vh - 8) y = bottom + 12;
    else if (top - 12 - ch >= 8) y = top - 12 - ch;
    else y = Math.max(8, vh - ch - 16);
    let x = Math.min(Math.max(16, r.left + r.width / 2 - cw / 2), vw - cw - 16);
    if (y === Math.max(8, vh - ch - 16) && r.width < vw - cw - 48) x = r.right + 16 + cw <= vw - 8 ? r.right + 16 : Math.max(16, r.left - 16 - cw);
    card.style.left = x + 'px'; card.style.top = y + 'px';
  }
  function startTour() {
    tourEls().hidden = false;
    document.body.classList.add('touring');
    setCoach(false);
    showTour(0);
  }
  function endTour(finished) {
    if (!tour.root) return;
    tour.root.hidden = true; tour.i = -1;
    document.body.classList.remove('touring');
    try { localStorage.setItem('mt.tour', finished ? 'done' : 'skipped'); } catch (e) { /* storage blocked: it shows again next time */ }
    if (finished) switchMode('free');
  }
  window.addEventListener('resize', placeTour);
  window.addEventListener('scroll', placeTour, true);
  document.addEventListener('keydown', (e) => {
    if (tour.i < 0) return;
    if (e.key === 'ArrowRight' || (e.key === 'Enter' && e.target.tagName !== 'BUTTON')) { e.preventDefault(); e.stopImmediatePropagation(); showTour(tour.i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); showTour(tour.i - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); endTour(false); }
    else if (e.key === 'Tab') {   // keep focus inside the card
      const f = [...tour.card.querySelectorAll('button:not([disabled])')];
      const k = f.indexOf(document.activeElement);
      e.preventDefault(); f[(k + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
    } else { e.stopImmediatePropagation(); e.preventDefault(); }   // the keyboard doesn't play under the tour
  }, true);
  $('tour-again').onclick = startTour;
  let seenTour = null;
  try { seenTour = localStorage.getItem('mt.tour'); } catch (e) { /* treat as new */ }
  if (!seenTour) setTimeout(startTour, 400);

  window.MT = { state, press, release, EX, engine, player, metro, chat, switchMode, loadDemo, sendToCoach, gtr, gtrNote, gtrFrame, setJamTool, highlights, setScale, setMetro, startTour }; // for tests / debugging
})();
