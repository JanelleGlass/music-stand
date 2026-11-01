// This device's side of Google Drive sync: the library and the sync records
// in IndexedDB, in the shape js/sync-engine.js expects (tests/fake-device.mjs
// is the test version).
//
// Sync records live in the kv store:
//   sync:link:<scoreId>    { driveId, name }  the Drive file and the agreed name at the last sync
//   sync:tomb:<scoreId>    { hash, at }       deleted here, to delete in Drive (written by data.deleteFile)
//   sync:upload:<scoreId>  { session, size, at } an upload to carry on with
//   sync:part:<driveId>:<n> Blob             pieces of a download to carry on with
//   sync:trashed:<driveId> at                 trashed here lately (Drive's listing can lag)
//   sync:state             { account, lastSync }
import * as db from './db.js';
import { listFiles, getFileBlob, storePdf, removeFile, sha256, notifyLibraryChange, storageEstimate } from './data.js';

async function records() {
  const out = { links: new Map(), tombs: new Map(), uploads: new Map(), trashed: new Map(), state: {} };
  for (const [key, value] of await db.getAllWithPrefix('kv', 'sync:')) {
    const [, kind, id] = key.match(/^sync:([a-z]+):?(.*)$/) || [];
    if (kind === 'link') out.links.set(id, value);
    else if (kind === 'tomb') out.tombs.set(id, value);
    else if (kind === 'upload') out.uploads.set(id, value);
    else if (kind === 'trashed') out.trashed.set(id, value);
    else if (kind === 'state') out.state = value || {};
  }
  return out;
}

// Scores whose PDF is stored here, with a content hash (worked out now for
// any added without one).
async function scores() {
  const stored = new Set(await db.getAllKeys('blobs'));
  const out = [];
  for (const f of await listFiles()) {
    if (!stored.has(f.id)) continue;
    if (!f.hash) {
      const blob = await getFileBlob(f.id);
      const hash = blob && (await sha256(await blob.arrayBuffer()));
      if (hash) await db.update('files', f.id, (m) => (m && !m.hash ? { ...m, hash } : undefined));
      f.hash = hash || null;
    }
    out.push({ id: f.id, name: f.name, hash: f.hash, addedAt: f.addedAt });
  }
  return out;
}

export const localStore = {
  scores,
  records,

  pdf: (id) => getFileBlob(id),

  // Resolves to the id the PDF is now stored under: fields.id, or the score
  // that already has the same PDF (added while it downloaded). null if
  // fields.id is taken by another PDF.
  async addScore(blob, buf, fields) {
    const { meta, existing } = await storePdf(buf, fields, { blob });
    if (!meta) return existing;
    notifyLibraryChange();
    return meta.id;
  },

  // A new version of a score's PDF from Drive: same id, name and reading place.
  async replaceContent(id, blob, buf, hash) {
    const { meta } = await storePdf(buf, { id, hash }, { blob, replace: true });
    if (meta) notifyLibraryChange();
    return meta ? id : null;
  },

  // Bytes this site may still store here (Infinity if Safari won't say).
  async room() {
    const est = await storageEstimate();
    return est && est.quota ? est.quota - (est.usage || 0) : Infinity;
  },

  // The pieces of a download kept so far, in order.
  async partial(driveId) {
    const entries = await db.getAllWithPrefix('kv', `sync:part:${driveId}:`);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const parts = entries.map(([, blob]) => blob);
    // A gap would mean pieces in the wrong place: start again.
    if (entries.some(([key], i) => !key.endsWith(`:${String(i).padStart(5, '0')}`))) {
      await this.dropPartial(driveId);
      return [];
    }
    return parts;
  },
  savePart: (driveId, index, blob) => db.put('kv', blob, `sync:part:${driveId}:${String(index).padStart(5, '0')}`),
  async dropPartial(driveId) {
    const keys = (await db.getAllWithPrefix('kv', `sync:part:${driveId}:`)).map(([k]) => k);
    if (keys.length) await db.transact(['kv'], (s) => { for (const k of keys) s.kv.delete(k); });
  },
  async partials() {
    const ids = new Set();
    for (const [k] of await db.getAllWithPrefix('kv', 'sync:part:')) ids.add(k.slice('sync:part:'.length, k.lastIndexOf(':')));
    return [...ids];
  },

  // Only if it is still called expect: a rename here wins until the next sync.
  async renameScore(id, name, expect) {
    const wrote = await db.update('files', id, (m) => (m && m.name === expect ? { ...m, name } : undefined));
    if (wrote) notifyLibraryChange();
    return wrote;
  },

  async deleteScore(id) {
    await removeFile(id);
    notifyLibraryChange();
  },

  setLink: (id, link) => db.put('kv', link, `sync:link:${id}`),
  dropLink: (id) => db.del('kv', `sync:link:${id}`),
  dropTomb: (id) => db.del('kv', `sync:tomb:${id}`),
  setUpload: (id, rec) => db.put('kv', rec, `sync:upload:${id}`),
  noteTrashed: (driveId, at) => db.put('kv', at, `sync:trashed:${driveId}`),
  forgetTrashed: (driveId) => db.del('kv', `sync:trashed:${driveId}`),
  dropUpload: (id) => db.del('kv', `sync:upload:${id}`),
  setState: (patch) => db.update('kv', 'sync:state', (s) => ({ ...(s || {}), ...patch })),

  // Connecting again with the same Google account carries on where sync left
  // off. With a different account, what was synced with the old one is
  // forgotten, so this library is merged into the new account's Drive.
  async connect(account) {
    const { state } = await records();
    if (state.account === account) return;
    const keys = (await db.getAllWithPrefix('kv', 'sync:'))
      .map(([k]) => k)
      .filter((k) => k !== 'sync:state');
    await db.transact(['kv'], (s) => {
      for (const k of keys) s.kv.delete(k);
      s.kv.put({ account }, 'sync:state');
    });
  },
};
