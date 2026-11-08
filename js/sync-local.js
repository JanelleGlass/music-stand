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
//   sync:data              { driveId, md5, fp }  the markings-and-folders file at the last sync (js/sync-data.js)
//   sync:restore           { hashes, at }     a backup was restored with Replace: its markings win once
import * as db from './db.js';
import { listFiles, getFileBlob, storePdf, removeFile, sha256, notifyLibraryChange, storageEstimate } from './data.js';
import { mergePage, pageIsEmpty, mergeFolder } from './notes-merge.js';

async function records() {
  const out = { links: new Map(), tombs: new Map(), uploads: new Map(), trashed: new Map(), state: {}, data: {}, restore: null };
  for (const [key, value] of await db.getAllWithPrefix('kv', 'sync:')) {
    const [, kind, id] = key.match(/^sync:([a-z]+):?(.*)$/) || [];
    if (kind === 'link') out.links.set(id, value);
    else if (kind === 'tomb') out.tombs.set(id, value);
    else if (kind === 'upload') out.uploads.set(id, value);
    else if (kind === 'trashed') out.trashed.set(id, value);
    else if (kind === 'state') out.state = value || {};
    else if (kind === 'data') out.data = value || {};
    else if (kind === 'restore') out.restore = value || null;
  }
  return out;
}

// Scores whose PDF is stored here, with a content hash (worked out now for
// any added without one).
//
// A score marked damaged (its PDF here couldn't be read: js/data.js
// checkDamaged) comes with damaged: true, so the plan fetches Drive's copy
// into it, keeping its name, place and markings. If it reads fine after
// all, the mark goes.
async function scores() {
  const stored = new Set(await db.getAllKeys('blobs'));
  const out = [];
  for (const f of await listFiles()) {
    if (!stored.has(f.id)) continue;
    if (f.damaged) {
      let ok = false;
      try {
        const blob = await getFileBlob(f.id);
        ok = !!blob && (await sha256(await blob.arrayBuffer())) === f.hash;
      } catch { /* still unreadable */ }
      if (!ok) {
        out.push({ id: f.id, name: f.name, hash: f.hash, addedAt: f.addedAt, damaged: true });
        continue;
      }
      await db.update('files', f.id, (m) => {
        if (!m || !m.damaged) return undefined;
        const { damaged, ...rest } = m;
        return rest;
      });
    }
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
  //
  // The blob the engine passes is made of the download's pieces, which are
  // themselves stored in IndexedDB and deleted right after. Safari can keep
  // a stored Blob tied to the files behind the Blobs it was made from, so
  // once the pieces go, the score's PDF can no longer be read and its pages
  // stay blank. storePdf makes a fresh Blob from buf's bytes instead.
  async addScore(blob, buf, fields) {
    const { meta, existing } = await storePdf(buf, fields);
    if (!meta) return existing;
    notifyLibraryChange();
    return meta.id;
  },

  // A new version of a score's PDF from Drive (or a fresh copy of one whose
  // PDF here can't be read): same id, name and reading place.
  async replaceContent(id, blob, buf, hash) {
    const { meta } = await storePdf(buf, { id, hash }, { replace: true });
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

  // ---- Markings and folders (js/sync-data.js) ----

  notesRecords: () => db.getAll('annotations'),
  // What pages say, read by text recognition (js/ocr.js).
  async pageTexts() {
    const out = [];
    for (const [k, v] of await db.getAllWithPrefix('kv', 'ocr:')) {
      const m = /^ocr:(.+):(\d+)$/.exec(k);
      if (m && v && typeof v.text === 'string') out.push({ fileId: m[1], page: Number(m[2]), text: v.text, at: Number(v.at) || 0 });
    }
    return out;
  },
  folders: () => db.getAll('lists'),
  places: () => db.getAll('positions'),

  // Pages of markings and folders from Drive, combined with what is stored
  // (a save made meanwhile is kept).
  // Scores deleted meanwhile get nothing.
  async applyData({ notes, lists, zooms = [], texts = [] }) {
    const at = Date.now();
    await db.transact(['files', 'annotations', 'lists', 'positions', 'kv'], (s) => {
      const req = s.files.getAllKeys();
      req.onsuccess = () => {
        const here = new Set(req.result);
        for (const { fileId, page, data } of notes) {
          if (!here.has(fileId)) continue;
          const key = `${fileId}:${page}`;
          const r = s.annotations.get(key);
          r.onsuccess = () => {
            const merged = mergePage(r.result, data);
            if (!pageIsEmpty(merged)) s.annotations.put({ id: key, fileId, page, ...merged, updatedAt: at });
          };
        }
        // A newer reading of a page.
        for (const t of texts) {
          if (!here.has(t.fileId)) continue;
          const key = `ocr:${t.fileId}:${t.page}`;
          const r = s.kv.get(key);
          r.onsuccess = () => {
            if (r.result && Number(r.result.at) >= t.at) return;
            s.kv.put({ v: 1, text: t.text, at: t.at }, key);
          };
        }
        // A newer zoom; the reading place stays.
        for (const z of zooms) {
          if (!here.has(z.fileId)) continue;
          const r = s.positions.get(z.fileId);
          r.onsuccess = () => {
            const p = r.result;
            if (p && p.zoomAt >= z.at) return;
            s.positions.put({ ...(p || { id: z.fileId, page: 0, frac: 0 }), zoom: z.zoom, zoomAt: z.at });
          };
        }
        for (const f of lists) {
          const r = s.lists.get(f.id);
          r.onsuccess = () => s.lists.put(mergeFolder(r.result, { ...f, members: f.members.filter((m) => here.has(m.score)) }));
        }
      };
    });
    notifyLibraryChange();
  },

  // restore: the restore mark this sync carried, now done with.
  async setDataState(state, restore) {
    await db.transact(['kv'], (s) => {
      s.kv.put(state, 'sync:data');
      if (restore) {
        const req = s.kv.get('sync:restore');
        req.onsuccess = () => { if (req.result && req.result.at === restore.at) s.kv.delete('sync:restore'); };
      }
    });
  },

  // Connecting again with the same Google account carries on where sync left
  // off. With a different account, what was synced with the old one is
  // forgotten, so this library is merged into the new account's Drive.
  async connect(account) {
    const { state } = await records();
    if (state.account === account) return;
    const keys = (await db.getAllWithPrefix('kv', 'sync:'))
      .map(([k]) => k)
      // A restored backup's mark is about this library, not the old account.
      .filter((k) => k !== 'sync:state' && k !== 'sync:restore');
    await db.transact(['kv'], (s) => {
      for (const k of keys) s.kv.delete(k);
      s.kv.put({ account }, 'sync:state');
    });
  },
};
