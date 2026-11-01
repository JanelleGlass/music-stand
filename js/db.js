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
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is open in another tab. Close other copies of the app.'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
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

export async function get(store, key) {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function getAllKeys(store) {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAllKeys());
}

// [key, value] pairs of every entry whose key is a string starting with prefix.
export async function getAllWithPrefix(store, prefix) {
  const db = await openDb();
  const s = db.transaction(store).objectStore(store);
  const range = IDBKeyRange.bound(prefix, prefix + '￿');
  const [keys, values] = await Promise.all([wrap(s.getAllKeys(range)), wrap(s.getAll(range))]);
  return keys.map((k, i) => [k, values[i]]);
}

export async function getAllByIndex(store, index, value) {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(value));
}

export async function put(store, value, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  if (key === undefined) tx.objectStore(store).put(value);
  else tx.objectStore(store).put(value, key);
  return done(tx);
}

export async function del(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export async function clear(store) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return done(tx);
}

// Reads one entry and writes back what fn returns, in one transaction, so
// nothing can change it in between. fn returning undefined writes nothing.
// Resolves to whether it wrote.
export async function update(store, key, fn) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
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
}

// Run several operations atomically. fn receives { storeName: IDBObjectStore }.
export async function transact(stores, fn) {
  const db = await openDb();
  const tx = db.transaction(stores, 'readwrite');
  const map = {};
  for (const s of stores) map[s] = tx.objectStore(s);
  fn(map);
  return done(tx);
}
