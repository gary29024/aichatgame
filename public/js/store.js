// Where things are saved.
//
// - Store.get/set/del/keys: this browser's own storage (IndexedDB). Used for settings
//   and as a fast local copy of everything.
// - Store.cloud: your Cloudflare R2 storage, reached through our server (/api/store/...).
//   This is the master copy, shared by all your devices.

window.Store = (() => {
  const DB_NAME = 'storychat';
  const STORE = 'kv';
  let dbPromise = null;
  const memoryFallback = new Map(); // used if the browser blocks storage (e.g. some private modes)

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- Cloud (our server → Cloudflare R2) ----
  const cloud = {
    password: () => '', // set by app.js

    async request(method, key, body, type) {
      for (let attempt = 0; ; attempt++) {
        try {
          const headers = { authorization: 'Bearer ' + cloud.password() };
          if (type) headers['content-type'] = type;
          const res = await fetch('/api/store/' + encodeURIComponent(key), { method, headers, body });
          if (res.headers.get('x-kindred-server') !== '1') {
            throw Object.assign(new Error(`storage server not reachable (HTTP ${res.status})`), { fatal: true });
          }
          if (res.status === 404 && method === 'GET') return null;
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            const err = new Error(data.error?.message || `storage error ${res.status}`);
            err.fatal = res.status < 500; // don't retry mistakes, only server hiccups
            throw err;
          }
          return res;
        } catch (e) {
          if (e.fatal || attempt >= 2) throw e;
          await sleep(700 * (attempt + 1)); // network hiccup: try again
        }
      }
    },
    async getJSON(key) {
      const res = await cloud.request('GET', key);
      return res ? res.json() : null;
    },
    async getText(key) {
      const res = await cloud.request('GET', key);
      return res ? res.text() : null;
    },
    async getBlob(key) {
      const res = await cloud.request('GET', key);
      return res ? res.blob() : null;
    },
    async put(key, value) {
      if (value instanceof Blob) return cloud.request('PUT', key, value, value.type || 'application/octet-stream');
      if (typeof value === 'string') return cloud.request('PUT', key, value, 'text/plain;charset=utf-8');
      return cloud.request('PUT', key, JSON.stringify(value), 'application/json');
    },
    async del(key) {
      return cloud.request('DELETE', key);
    },
  };

  // ---- This device (IndexedDB) ----
  return {
    cloud,
    async get(key, fallback = null) {
      try {
        const db = await open();
        if (!db) return memoryFallback.has(key) ? memoryFallback.get(key) : fallback;
        const value = await run('readonly', (s) => s.get(key));
        return value === undefined ? fallback : value;
      } catch {
        return fallback;
      }
    },
    async set(key, value) {
      try {
        const db = await open();
        if (!db) return memoryFallback.set(key, value);
        await run('readwrite', (s) => s.put(value, key));
      } catch (e) {
        console.warn('Could not save', key, e);
        memoryFallback.set(key, value);
      }
    },
    async keys(prefix = '') {
      try {
        const db = await open();
        const all = db ? await run('readonly', (s) => s.getAllKeys()) : [...memoryFallback.keys()];
        return (all || []).filter((k) => typeof k === 'string' && k.startsWith(prefix));
      } catch {
        return [];
      }
    },
    async del(key) {
      try {
        const db = await open();
        if (!db) return memoryFallback.delete(key);
        await run('readwrite', (s) => s.delete(key));
      } catch (e) {
        console.warn('Could not delete', key, e);
      }
    },
  };
})();
