// Tiny key-value storage over IndexedDB, with an in-memory twin for "don't remember" / private mode.
const DB_NAME = 'chess-coach';
const DB_VERSION = 1;
export const STORES = ['kv', 'practice', 'attempts', 'games', 'moves'];

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

class IdbStore {
  constructor(db) { this.db = db; this.persistent = true; }
  _tx(store, mode = 'readonly') { return this.db.transaction(store, mode).objectStore(store); }
  get(store, key) { return req2p(this._tx(store).get(key)); }
  all(store) { return req2p(this._tx(store).getAll()); }
  keys(store) { return req2p(this._tx(store).getAllKeys()); }
  put(store, key, value) { return req2p(this._tx(store, 'readwrite').put(value, key)); }
  del(store, key) { return req2p(this._tx(store, 'readwrite').delete(key)); }
  clear(store) { return req2p(this._tx(store, 'readwrite').clear()); }
  /** entries: [[key, value], ...] in one transaction */
  putMany(store, entries) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const [k, v] of entries) os.put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('transaction aborted'));
    });
  }
}

class MemStore {
  constructor() { this.m = Object.fromEntries(STORES.map((s) => [s, new Map()])); this.persistent = false; }
  async get(s, k) { return this.m[s].get(k); }
  async all(s) { return [...this.m[s].values()]; }
  async keys(s) { return [...this.m[s].keys()]; }
  async put(s, k, v) { this.m[s].set(k, v); }
  async del(s, k) { this.m[s].delete(k); }
  async clear(s) { this.m[s].clear(); }
  async putMany(s, entries) { for (const [k, v] of entries) this.m[s].set(k, v); }
}

export const memoryStore = () => new MemStore();

/** Persistent store, or null when IndexedDB is unavailable (old private mode, blocked storage, ...). */
export async function openIdb() {
  try {
    if (!('indexedDB' in self)) return null;
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    const db = await Promise.race([req2p(r), new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB timeout')), 4000))]);
    const st = new IdbStore(db);
    await st.get('kv', 'probe'); // throws in some private modes
    return st;
  } catch (e) {
    console.warn('IndexedDB unavailable:', e);
    return null;
  }
}

/** Wipe everything this app stored on the device. */
export async function wipeAll(open) {
  try { open?.db?.close(); } catch { /* ignore */ }
  try {
    const r = indexedDB.deleteDatabase(DB_NAME);
    await Promise.race([req2p(r), new Promise((res) => { r.onblocked = res; setTimeout(res, 3000); })]);
  } catch { /* ignore */ }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('cc.')) localStorage.removeItem(k);
  } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
}
