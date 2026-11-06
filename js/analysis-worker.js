/* Music Theorizer analysis worker: runs Analysis.analyzeSong off the main thread so the page stays
 * responsive while the note model listens. Loaded by js/analysis.js as new Worker('js/analysis-worker.js');
 * the model scripts (js/vendor/tfjs.min.js, js/ml/basic-pitch-model.js) are pulled in on first use.
 * Messages in:  {type:'analyze', id, samples: Float32Array, sampleRate, opts} | {type:'cancel', id}
 * Messages out: {type:'stage', id, stage, p} | {type:'result', id, result} | {type:'error', id, error:{code,message}} */
importScripts('theory.js', 'analysis.js');
const running = new Map();
self.onmessage = async (ev) => {
  const m = ev.data || {};
  if (m.type === 'cancel') { const ctl = running.get(m.id); if (ctl) ctl.abort(); return; }
  if (m.type !== 'analyze') return;
  const ctl = new AbortController();
  running.set(m.id, ctl);
  try {
    const opts = Object.assign({}, m.opts || {}, {
      signal: ctl.signal,
      onStage: (stage, p) => self.postMessage({ type: 'stage', id: m.id, stage, p }),
    });
    const result = await self.Analysis.analyzeSong(m.samples, m.sampleRate, opts);
    self.postMessage({ type: 'result', id: m.id, result });
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, error: { code: e && e.code, message: (e && e.message) || String(e) } });
  } finally {
    running.delete(m.id);
  }
};
