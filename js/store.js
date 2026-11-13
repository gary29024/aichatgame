// Saves everything (settings, chats, pictures) inside this browser using IndexedDB.
// Nothing is sent anywhere except the Gemini calls in gemini.js.

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

  return {
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
