/* AI Coach: Qwen chat assistant (slides: "Qwen - used as an ai assistant chatbot").
 * Talks to a locally hosted Qwen through Ollama or any OpenAI-compatible server, streaming tokens
 * so long answers start showing quickly. When the model can't be reached, the offline helper
 * answers common theory questions from the app's own theory engine so the user never hits a dead end. */
(function (root) {
  'use strict';
  const T = root.Theory;

  const SYSTEM_PROMPT = [
    'You are the AI coach inside "Music Theorizer", an app that teaches beginner music theory on a virtual piano keyboard.',
    'Explain things simply, in at most 6 short sentences or a short list. Use note names (C, D#, Bb) the user can find on the keyboard.',
    'Use the app context below (mode, key, scale, chords, notes the user played). If you are not sure, say so and suggest how to check by ear.',
    'The note lists in the app context come from the app\'s theory engine and are correct: base every note name you mention on them, and never contradict them.',
    'Never invent facts about specific songs or artists. Keep the conversation about music.',
    'You can play music on the user\'s keyboard. When they ask you to play, show or demonstrate something (a riff, lick, melody, scale, chord or progression),',
    'add one play block to your answer, written exactly like [[play bpm=90: E4/0.5 G4/0.5 A4 C5+E5+G5/2 R/1]].',
    'Each item is a note name with its octave (C4 is middle C; use # or b, for example F#4 or Bb3), notes joined with + sound together as a chord,',
    '/n is the length in beats (1 when left out, 0.5 is an eighth note) and R is a rest. Use at most 32 items, inside the keyboard range in the app context,',
    'and keep to the current key unless asked otherwise. The app plays the block and lights up the keys, and hides the block itself, so say in words what you are playing.',
    'To play it with a particular sound add inst=, for example [[play bpm=90 inst=sax: E4 G4]]. When the app context lists separated instruments with their sounds and you play that instrument\'s part (or the user asks how it would sound on it), use its sound.',
  ].join(' ');

  /* Play blocks: [[play bpm=90: E4/0.5 G4 C5+E5+G5/2 R]] in a coach answer.
   * parsePlay(text) -> { text (without the blocks, and without a block still being typed), plays: [{ bpm, events: [{ midis, beats }] }] } */
  const PLAY_RE = /\[\[\s*play\b([^\]]*)\]\]/gi;
  // 'F#4' -> 66; the octave defaults to 4.
  function noteMidi(name) {
    const m = /^([A-Ga-g])(##|bb|#|b|♯|♭)?(-?\d)?$/.exec(name.trim());
    if (!m) return null;
    const acc = { '#': 1, '♯': 1, '##': 2, b: -1, '♭': -1, bb: -2 }[m[2] || ''] || 0;
    const midi = (m[3] != null ? +m[3] + 1 : 5) * 12 + T.NOTE_NAMES.indexOf(m[1].toUpperCase()) + acc;
    return midi >= 21 && midi <= 108 ? midi : null;
  }
  function parsePlayItems(body) {
    let bpm = 90;
    const head = body.match(/bpm\s*=\s*(\d+(?:\.\d+)?)/i);
    if (head) bpm = Math.max(30, Math.min(240, +head[1]));
    const im = body.split(':')[0].match(/inst\s*=\s*([\w-]+)/i);
    const inst = im ? im[1].toLowerCase() : null;
    const list = body.includes(':') ? body.slice(body.indexOf(':') + 1) : body.replace(/bpm\s*=\s*\d+(?:\.\d+)?/i, '').replace(/inst\s*=\s*[\w-]+/i, '');
    const events = [];
    for (const tok of list.split(/[\s,|]+/).filter(Boolean)) {
      const m = tok.match(/^([^/:*]+?)(?:[/:*](\d*\.?\d+))?$/);
      if (!m) continue;
      const beats = m[2] ? Math.max(0.125, Math.min(8, +m[2])) : 1;
      if (/^(r|rest|-)$/i.test(m[1])) { events.push({ midis: [], beats }); continue; }
      const midis = m[1].split('+').map(noteMidi).filter((x) => x != null);
      if (midis.length) events.push({ midis, beats });
      if (events.length >= 64) break;
    }
    return { bpm, inst, events };
  }
  function parsePlay(text) {
    const plays = [];
    let out = String(text || '').replace(PLAY_RE, (all, body) => { const p = parsePlayItems(body); if (p.events.length) plays.push(p); return ''; });
    const open = out.lastIndexOf('[[');   // a block still streaming in
    if (open >= 0 && out.indexOf(']]', open) < 0) out = out.slice(0, open);
    return { text: out.replace(/ {2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), plays };
  }
  // Writes a play block from MIDI events (the offline helper uses it).
  function playBlock(events, bpm) {
    const nm = (m) => T.NOTE_NAMES[T.mod12(m)] + (Math.floor(m / 12) - 1);
    return '[[play bpm=' + (bpm || 90) + ': ' + events.map((e) => (e.midis.length ? e.midis.map(nm).join('+') : 'R') + (e.beats !== 1 ? '/' + e.beats : '')).join(' ') + ']]';
  }

  // Context-window / token-limit errors from Ollama, LM Studio, llama.cpp and OpenAI-style servers.
  const TOO_LONG = /context (length|window|size)|too many tokens|token limit|maximum context|exceeds? .*tokens|n_ctx|prompt is too long/i;

  class CoachError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  class Coach {
    constructor() {
      this.api = 'ollama';
      this.url = 'http://localhost:11434';
      this.model = 'qwen2.5:7b-instruct';
      this.timeoutMs = 60000;
      this.label = '';   // address to show people, when url is the desktop app's relay
    }

    get where() { return this.label || this.url; }

    /* The desktop app relays to Ollama and answers 502 + X-MT-Unreachable when Ollama is down. */
    static relayDown(res) { return res.status === 502 && res.headers.get('X-MT-Unreachable') === '1'; }

    async ping(signal) {
      if (this.api === 'offline') throw new CoachError('offline', 'Offline helper selected.');
      const path = this.api === 'ollama' ? '/api/tags' : '/v1/models';
      let res;
      try {
        res = await fetch(this.url.replace(/\/$/, '') + path, { signal });
      } catch (e) {
        throw new CoachError('unreachable', 'Could not reach the AI server at ' + this.where + '.');
      }
      if (Coach.relayDown(res)) throw new CoachError('unreachable', 'Could not reach the AI server at ' + this.where + '.');
      if (!res.ok) throw new CoachError('http', 'The AI server answered with error ' + res.status + '.');
      const data = await res.json().catch(() => ({}));
      const names = this.api === 'ollama' ? (data.models || []).map((m) => m.name) : (data.data || []).map((m) => m.id);
      if (names.length && !names.some((n) => n === this.model || n.startsWith(this.model + ':'))) {
        throw new CoachError('no_model', `The server is running but the model "${this.model}" is not installed. Available: ${names.slice(0, 5).join(', ')}.`);
      }
      return names;
    }

    /* Loads the model into GPU memory ahead of the first question. The spike measured a 38 s
     * cold start versus ~2.1 s to first token once warm, so this runs as soon as the app connects. */
    async warm() {
      if (this.api !== 'ollama') return;
      const res = await fetch(this.url.replace(/\/$/, '') + '/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: '', keep_alive: '30m' }),
      });
      if (!res.ok) throw new CoachError('http', 'Could not load the model (error ' + res.status + ').');
    }

    /* Streams a reply. messages: [{role, content}]. Calls onToken(textSoFar). Resolves to full text. */
    async ask(messages, context, onToken, outerSignal) {
      if (this.api === 'offline') throw new CoachError('offline', 'Offline helper selected.');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort('timeout'), this.timeoutMs);
      const onAbort = () => ctl.abort('cancelled');
      if (outerSignal) outerSignal.addEventListener('abort', onAbort);
      const full = [{ role: 'system', content: SYSTEM_PROMPT + '\n\nApp context:\n' + context }].concat(messages);
      const base = this.url.replace(/\/$/, '');
      const isOllama = this.api === 'ollama';
      // Ollama's default context window (2048–4096 tokens) is easy to fill with a few long answers,
      // so ask for 8192 (Qwen 2.5 supports far more) and cap the answer length.
      const body = isOllama
        ? { model: this.model, messages: full, stream: true, options: { temperature: 0.4, num_ctx: 8192, num_predict: 800 } }
        : { model: this.model, messages: full, stream: true, temperature: 0.4, max_tokens: 800 };
      let res;
      try {
        res = await fetch(base + (isOllama ? '/api/chat' : '/v1/chat/completions'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
        });
      } catch (e) {
        cleanup();
        if (ctl.signal.aborted) throw new CoachError(ctl.signal.reason === 'timeout' ? 'timeout' : 'cancelled', ctl.signal.reason === 'timeout' ? 'The AI took longer than ' + this.timeoutMs / 1000 + ' seconds.' : 'Stopped.');
        throw new CoachError('unreachable', 'Could not reach the AI server at ' + this.where + '.');
      }
      if (Coach.relayDown(res)) { cleanup(); throw new CoachError('unreachable', 'Could not reach the AI server at ' + this.where + '.'); }
      if (res.status === 429) { cleanup(); throw new CoachError('rate_limit', 'The AI server is busy (rate limited).'); }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        cleanup();
        if (TOO_LONG.test(txt)) throw new CoachError('too_long', 'The conversation got too long for the model.');
        throw new CoachError(/model/i.test(txt) ? 'no_model' : 'http', 'The AI server answered with error ' + res.status + (txt ? ': ' + txt.slice(0, 160) : '.'));
      }
      let text = '', cut = false;
      try {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            let line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            if (!isOllama) { if (!line.startsWith('data:')) continue; line = line.slice(5).trim(); if (line === '[DONE]') continue; }
            let j; try { j = JSON.parse(line); } catch (e) { continue; }
            const piece = isOllama ? (j.message && j.message.content) || '' : (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
            if (j.error) throw new CoachError(TOO_LONG.test(String(j.error)) ? 'too_long' : 'http', TOO_LONG.test(String(j.error)) ? 'The conversation got too long for the model.' : String(j.error));
            if (isOllama ? j.done_reason === 'length' : j.choices && j.choices[0] && j.choices[0].finish_reason === 'length') cut = true;
            if (piece) { text += piece; onToken && onToken(text); }
          }
        }
      } catch (e) {
        cleanup();
        if (e instanceof CoachError) throw e;
        if (ctl.signal.aborted) throw new CoachError(ctl.signal.reason === 'timeout' ? 'timeout' : 'cancelled', ctl.signal.reason === 'timeout' ? 'The AI stopped responding.' : 'Stopped.');
        throw new CoachError('unreachable', 'The connection to the AI server dropped.');
      }
      cleanup();
      if (!text.trim()) throw new CoachError(cut ? 'too_long' : 'empty', cut ? 'The conversation got too long for the model.' : 'The AI returned an empty answer.');
      return cut ? text + '\n\n(Answer cut short at the length limit. Ask "continue" for the rest.)' : text;

      function cleanup() { clearTimeout(timer); if (outerSignal) outerSignal.removeEventListener('abort', onAbort); }
    }
  }

  /* Offline helper: rule-based answers built from the current app state (no AI involved). */
  function offlineAnswer(question, st) {
    const q = question.toLowerCase();
    const key = st.key; // {rootPc, scaleId}
    const keyName = key ? T.scaleLabel(key.rootPc, key.scaleId) : null;
    const notes = key ? T.scalePitchClasses(key.rootPc, key.scaleId).map((pc) => T.pcName(pc, key.rootPc)).join(' ') : '';
    const chords = key ? T.diatonicChords(key.rootPc, key.scaleId) : [];
    const lines = [];

    // "Play / show me ..." gets an example played on the keyboard.
    if (/\b(play|show me|demonstrate|hear|example|riff|lick)\b/.test(q) && !/what (should|can) i play|play over/.test(q)) {
      const k = key || { rootPc: 0, scaleId: 'major' }, kName = T.scaleLabel(k.rootPc, k.scaleId);
      const pcs = T.scalePitchClasses(k.rootPc, k.scaleId), dia = T.diatonicChords(k.rootPc, k.scaleId);
      const root = 60 + k.rootPc - (k.rootPc > 6 ? 12 : 0);   // the tonic nearest middle C
      const minorish = /minor|dorian|phrygian|locrian|blues/i.test(k.scaleId);
      if (/scale/.test(q)) {
        const up = pcs.map((pc) => root + T.mod12(pc - k.rootPc)).concat([root + 12]);
        lines.push(`Here is ${kName}, up and back down: ${up.map((m) => T.pcName(m, k.rootPc)).join(' ')}.`);
        lines.push(playBlock(up.concat(up.slice(0, -1).reverse()).map((m, i, a) => ({ midis: [m], beats: i === a.length - 1 ? 2 : 0.5 })), 96));
      } else if (/chord|progression|harmony/.test(q) && dia.length >= 6) {
        const degs = minorish ? [0, 5, 2, 6] : [0, 4, 5, 3];   // i–VI–III–VII or I–V–vi–IV
        const chs = degs.map((d) => dia[d]);
        lines.push(`Here is a ${chs.map((c) => c.roman).join('–')} progression in ${kName}: ${chs.map((c) => c.name).join(', ')}. Each chord rings for two beats.`);
        lines.push(playBlock(chs.map((c) => ({ midis: c.pcs.map((pc) => { let m = 48 + T.mod12(pc); while (m < 55) m += 12; return m; }).sort((a, b) => a - b), beats: 2 })), 80));
      } else {
        const ch = st.chord || dia[0];
        const notes = T.suggestPhrase({ scalePcs: pcs, chordPcs: ch ? ch.pcs : [k.rootPc], lowMidi: root, highMidi: root + 12, length: 8, seed: 1 + Math.floor(Math.random() * 1000) });
        const rhythm = [0.5, 0.5, 1, 0.5, 0.5, 1, 1, 3];
        lines.push(`Here is a short riff in ${kName}${st.chord ? ', built around ' + st.chord.name : ''}: ${notes.map((m) => T.pcName(m, k.rootPc)).join(' ')}. It ends on a note of the chord so it sounds finished.`);
        lines.push(playBlock(notes.map((m, i) => ({ midis: [m], beats: rhythm[i] || 1 })), 100));
      }
      lines.push('Press Play to hear it again, then try it yourself.');
      return lines.join('\n');
    }

    if (/pentatonic/.test(q)) {
      lines.push('A pentatonic scale has 5 notes instead of 7. It leaves out the two notes that create half-step clashes, so almost anything you play sounds good.');
      if (key) {
        const pent = key.scaleId === 'minor' || /minor|dorian|phrygian/i.test(key.scaleId) ? 'minorPentatonic' : 'majorPentatonic';
        lines.push(`For ${keyName}, try ${T.scaleLabel(key.rootPc, pent)}: ${T.scalePitchClasses(key.rootPc, pent).map((pc) => T.pcName(pc, key.rootPc)).join(' ')}.`);
      }
    } else if (/major.*minor|minor.*major|difference/.test(q)) {
      lines.push('Major scales sound bright; minor scales sound darker. The difference is mainly the 3rd note: major has a big jump (4 half steps) from the root to the 3rd, minor has a smaller one (3 half steps).');
      lines.push('Every major key has a "relative minor" that uses exactly the same notes, starting on the 6th note. C major and A minor are the classic pair.');
    } else if (/(what|which).*(play|solo|improv)|play over|what should/.test(q) && key) {
      const now = st.chord;
      lines.push(`Stay inside ${keyName}: ${notes}.`);
      if (now) lines.push(`Right now the chord is ${now.name}. Its notes (${now.pcs.map((pc) => T.pcName(pc, key.rootPc)).join(' ')}) are the safest landing spots, so start and end your phrases on them.`);
      lines.push('Turn on "Suggest notes" in Jam Mode and follow the numbered keys for a ready-made idea.');
    } else if (/chord|progression|harmony/.test(q) && chords.length) {
      lines.push(`The chords that fit ${keyName} are: ${chords.map((c) => c.name + ' (' + c.roman + ')').join(', ')}.`);
      lines.push('Build any of them by taking a note from the scale and stacking every other scale note on top (1-3-5). Try playing I – V – vi – IV for a very common pop progression.');
    } else if (/(why|how).*(key|detect|know)|confiden|sure|wrong/.test(q)) {
      lines.push('The song analysis measures how strongly each of the 12 notes sounds across the track, compares that with typical major and minor key patterns, and checks which chords appear most.');
      lines.push('Songs that use the notes of both a major key and its relative minor can be hard to tell apart. If the highlighted keys sound off, change the key in Jam Mode; you can undo it.');
    } else if (/scale|key|what is/.test(q) && key) {
      lines.push(`${keyName}: ${notes}.`);
      lines.push(T.SCALES[key.scaleId].blurb);
      lines.push(`Step pattern: ${T.scaleFormula(key.scaleId)} (W = whole step, 2 keys over; H = half step, the very next key).`);
    } else {
      lines.push('The offline helper can answer questions about the current scale or key, its chords, pentatonic scales, major vs. minor, and what to play over the current chord.');
      if (keyName) lines.push(`Right now you are working in ${keyName}: ${notes}.`);
    }
    return lines.join('\n');
  }

  root.CoachKit = { Coach, CoachError, offlineAnswer, SYSTEM_PROMPT, parsePlay, playBlock };
})(window);
