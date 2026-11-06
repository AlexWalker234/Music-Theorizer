/* Song library: songs the user adds in Jam Mode are kept on this device (IndexedDB) so they
 * show up in the song list next time, with their analysis cached so they open instantly. */
(function (root) {
  'use strict';

  const DB_NAME = 'music-theorizer', STORE = 'songs';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('This browser cannot store songs.'));
      let req;
      try { req = root.indexedDB.open(DB_NAME, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open song storage.'));
    }).catch((e) => { dbPromise = null; throw e; });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode), store = t.objectStore(STORE);
      let out;
      Promise.resolve(fn(store)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage is full.'));
    });
  }
  const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  const SongLibrary = {
    // [{id, name, size, added}] newest first, without the audio.
    async list() {
      const all = await tx('readonly', (s) => reqP(s.getAll()));
      return (all || []).map(({ id, name, size, added }) => ({ id, name, size, added })).sort((a, b) => b.added - a.added);
    },
    async get(id) { return tx('readonly', (s) => reqP(s.get(id))); },
    // Same file name and size = same song; re-adding replaces it.
    async add(file) {
      const id = 'song:' + file.name + ':' + file.size;
      const rec = { id, name: file.name.replace(/\.[^.]+$/, ''), size: file.size, type: file.type, added: Date.now(), blob: file, analysis: null, engine: null };
      await tx('readwrite', (s) => reqP(s.put(rec)));
      return rec;
    },
    async saveAnalysis(id, analysis, engine) {
      return tx('readwrite', async (s) => {
        const rec = await reqP(s.get(id));
        if (!rec) return;
        rec.analysis = analysis; rec.engine = engine;
        await reqP(s.put(rec));
      });
    },
    async remove(id) { return tx('readwrite', (s) => reqP(s.delete(id))); },
  };

  root.SongLibrary = SongLibrary;
})(window);
