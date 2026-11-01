// Thin promise wrapper around IndexedDB. Every piece of app data lives here.
//
// Stores:
//   files        { id, name, size, pageCount, pageSizes, hash, addedAt, openedAt }
//   blobs        fileId -> Blob (the PDF itself)
//   thumbs       fileId -> Blob (JPEG of page 1)
//   kv           key -> any (settings, etc.)
//   positions    { id, page, frac, zoom }        last reading position per file/list
//   annotations  { id: "fileId:page", fileId, page, strokes }   (Phase 2)
//   lists        { id, name, entries: [...] }                    (Phase 3)

const DB_NAME = 'music-stand';
const DB_VERSION = 1;

export const ALL_STORES = ['files', 'blobs', 'thumbs', 'kv', 'positions', 'annotations', 'lists'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const has = (n) => db.objectStoreNames.contains(n);
      if (!has('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!has('blobs')) db.createObjectStore('blobs');
      if (!has('thumbs')) db.createObjectStore('thumbs');
      if (!has('kv')) db.createObjectStore('kv');
      if (!has('positions')) db.createObjectStore('positions', { keyPath: 'id' });
      if (!has('annotations')) {
        const s = db.createObjectStore('annotations', { keyPath: 'id' });
        s.createIndex('fileId', 'fileId');
      }
      if (!has('lists')) db.createObjectStore('lists', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => { dbPromise = null; }; // closed by the system
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is open in another tab. Close other copies of the app.'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

// Runs use(tx) on a new transaction, straight away (a transaction must get
// its first request before anything else is awaited). iPadOS can drop the
// connection while the app is in the background; then it is opened again.
async function withTx(stores, mode, use) {
  const db = await openDb();
  let tx;
  try {
    tx = db.transaction(stores, mode);
  } catch (e) {
    if (e.name !== 'InvalidStateError') throw e;
    dbPromise = null;
    tx = (await openDb()).transaction(stores, mode);
  }
  return use(tx);
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // tx.error is still null while a failed request's error is bubbling.
    tx.onerror = (e) => reject((e && e.target && e.target.error) || tx.error || new Error('Saving to the database failed'));
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export function get(store, key) {
  return withTx(store, 'readonly', (tx) => wrap(tx.objectStore(store).get(key)));
}

export function getAll(store) {
  return withTx(store, 'readonly', (tx) => wrap(tx.objectStore(store).getAll()));
}

export function getAllKeys(store) {
  return withTx(store, 'readonly', (tx) => wrap(tx.objectStore(store).getAllKeys()));
}

// [key, value] pairs of every entry whose key is a string starting with prefix.
export async function getAllWithPrefix(store, prefix) {
  const range = IDBKeyRange.bound(prefix, prefix + '￿');
  const [keys, values] = await withTx(store, 'readonly', (tx) => {
    const s = tx.objectStore(store);
    return Promise.all([wrap(s.getAllKeys(range)), wrap(s.getAll(range))]);
  });
  return keys.map((k, i) => [k, values[i]]);
}

export function getAllByIndex(store, index, value) {
  return withTx(store, 'readonly', (tx) => wrap(tx.objectStore(store).index(index).getAll(value)));
}

export function put(store, value, key) {
  return withTx(store, 'readwrite', (tx) => {
    if (key === undefined) tx.objectStore(store).put(value);
    else tx.objectStore(store).put(value, key);
    return done(tx);
  });
}

export function del(store, key) {
  return withTx(store, 'readwrite', (tx) => {
    tx.objectStore(store).delete(key);
    return done(tx);
  });
}

export function clear(store) {
  return withTx(store, 'readwrite', (tx) => {
    tx.objectStore(store).clear();
    return done(tx);
  });
}

// Reads one entry and writes back what fn returns, in one transaction, so
// nothing can change it in between. fn returning undefined writes nothing.
// Resolves to whether it wrote.
export function update(store, key, fn) {
  return withTx(store, 'readwrite', async (tx) => {
    const s = tx.objectStore(store);
    let wrote = false;
    const req = s.get(key);
    req.onsuccess = () => {
      const next = fn(req.result);
      if (next === undefined) return;
      wrote = true;
      if (s.keyPath === null) s.put(next, key);
      else s.put(next);
    };
    await done(tx);
    return wrote;
  });
}

// Run several operations atomically. fn receives { storeName: IDBObjectStore }.
export function transact(stores, fn) {
  return withTx(stores, 'readwrite', (tx) => {
    const map = {};
    for (const s of stores) map[s] = tx.objectStore(s);
    fn(map);
    return done(tx);
  });
}
