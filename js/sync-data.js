// Google Drive sync of markings, favorites and folders: one small JSON file,
// "Music Stand notes and folders.json" (appProperties msKind 'data'), in the
// Music Stand folder. Talks to Drive and the device only through the
// adapters (js/sync-remote.js, js/sync-local.js; fakes in the tests).
//
// In the file a score is known by its PDF's SHA-256, which is the same on
// every device (sync already treats equal PDFs as one score). On a device
// markings and folder members use the device's own score ids.
//
//   { app: 'music-stand', kind: 'data', v: 1,
//     notes: { <hash>: { <page>: { strokes, erased } } },
//     folders: [{ id, name, nameAt, createdAt, deleted, deletedAt,
//                 members: [{ score: <hash>, in, at }] }] }
//
// Every copy combines with the rules in js/notes-merge.js, which never lose a
// change, so a run can stop anywhere, and two devices writing at once only
// cost another round. A run downloads, combines and uploads only when
// something changed: Drive's copy (its md5), or what this device has (a
// fingerprint of its markings, folders and scores, recorded at the last
// sync: a score that arrives brings markings and folders to apply).
import { mergePage, pageIsEmpty, mergeNotes, mergeFolder, mergeFolders, normaliseFolder, sameContent, fingerprint } from './notes-merge.js';

export const DATA_NAME = 'Music Stand notes and folders.json';
export const DATA_VERSION = 1;

const emptyDoc = () => ({ notes: {}, folders: [] });

const older = (a, b) => (Date.parse(a.createdTime) || 0) - (Date.parse(b.createdTime) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Members of one folder that point at the same key (two copies of a PDF on
// one device) become one: the newer wins.
function oneMemberEach(folder) {
  return mergeFolder(folder, { ...folder, members: [] });
}

function sortedNotes(notes) {
  const out = {};
  for (const h of Object.keys(notes).sort()) {
    const pages = mergeNotes({ pages: notes[h] }, null).pages;
    if (Object.keys(pages).length) out[h] = pages;
  }
  return out;
}

// This device's markings and folders, with scores known by hash.
// scores: [{ id, hash }]; records: annotation records; folders: lists records.
export function localDoc(scores, records, folders) {
  const hashOf = new Map(scores.filter((s) => s.hash).map((s) => [s.id, s.hash]));
  const notes = {};
  for (const r of records) {
    const h = hashOf.get(r.fileId);
    if (!h) continue;
    const pages = notes[h] || (notes[h] = {});
    pages[r.page] = mergePage(pages[r.page], r);
  }
  const translated = folders.map((f) => oneMemberEach({
    ...f,
    members: (Array.isArray(f.members) ? f.members : [])
      .filter((m) => hashOf.has(m.score))
      .map((m) => ({ ...m, score: hashOf.get(m.score) })),
  }));
  return { notes: sortedNotes(notes), folders: mergeFolders(translated) };
}

export function mergeDocs(a, b) {
  const notes = {};
  for (const h of new Set([...Object.keys(a.notes || {}), ...Object.keys(b.notes || {})])) {
    notes[h] = mergeNotes({ pages: (a.notes || {})[h] }, { pages: (b.notes || {})[h] }).pages;
  }
  return { notes: sortedNotes(notes), folders: mergeFolders(a.folders || [], b.folders || []) };
}

// The part of a doc about the scores on this device (what localDoc gives
// once the doc is applied here).
export function restrictTo(doc, hashes) {
  const notes = {};
  for (const h of Object.keys(doc.notes)) if (hashes.has(h)) notes[h] = doc.notes[h];
  return {
    notes,
    folders: doc.folders.map((f) => normaliseFolder({ ...f, members: f.members.filter((m) => hashes.has(m.score)) })),
  };
}

export function isEmptyDoc(doc) {
  return !Object.keys(doc.notes).length && !doc.folders.length;
}

// A backup restored with Replace may hold strokes that were erased since
// (in Drive's copy): they come back as new strokes, so the erase doesn't win.
// The new id comes from the old one (the first "<id>~rN" Drive hasn't
// erased), so restoring the same backup twice, or on two devices, gives the
// same copy rather than another one.
export function resurrect(local, remote, hashes) {
  const notes = {};
  for (const [h, pages] of Object.entries(local.notes)) {
    if (!hashes.has(h)) {
      notes[h] = pages;
      continue;
    }
    notes[h] = {};
    for (const [n, page] of Object.entries(pages)) {
      const gone = new Set((((remote.notes[h] || {})[n]) || {}).erased || []);
      const revived = (id) => {
        const base = id.replace(/(~rd+)+$/, '');
        let k = 1;
        while (gone.has(`${base}~r${k}`)) k++;
        return `${base}~r${k}`;
      };
      notes[h][n] = mergePage({ strokes: page.strokes.map((s) => (gone.has(s.id) ? { ...s, id: revived(s.id) } : s)), erased: page.erased }, null);
    }
  }
  return { notes: sortedNotes(notes), folders: local.folders };
}

// Whether this device has markings or folder changes Drive hasn't had yet
// (for the "waiting to sync" sign at start-up).
export async function dataPending(local) {
  const scores = (await local.scores()).filter((s) => s.hash);
  const here = localDoc(scores, await local.notesRecords(), await local.folders());
  const { data: state = {} } = await local.records();
  if (isEmptyDoc(here) && !state.fp) return false;
  return (await fingerprintOf(here, scores.map((s) => s.hash))) !== state.fp;
}

// What the device's markings, folders and scores looked like, in short.
function fingerprintOf(doc, hashes) {
  return fingerprint({ doc, scores: [...new Set(hashes)].sort() });
}

export function serialize(doc) {
  return JSON.stringify({ app: 'music-stand', kind: 'data', v: DATA_VERSION, notes: doc.notes, folders: doc.folders });
}

// The doc in a file's text: { doc }, { newer: true } from a later version
// of the app, or { bad: true } if it can't be read.
export function parse(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { bad: true };
  }
  if (!raw || raw.app !== 'music-stand' || raw.kind !== 'data') return { bad: true };
  if (Number(raw.v) > DATA_VERSION) return { newer: true };
  const notes = {};
  for (const [h, pages] of Object.entries(raw.notes && typeof raw.notes === 'object' ? raw.notes : {})) {
    if (!pages || typeof pages !== 'object') continue;
    notes[h] = {};
    for (const [n, p] of Object.entries(pages)) {
      if (!/^\d+$/.test(n) || !p) continue;
      notes[h][n] = mergePage({ strokes: (Array.isArray(p.strokes) ? p.strokes : []).filter(validStroke), erased: (Array.isArray(p.erased) ? p.erased : []).filter((id) => typeof id === 'string') }, null);
    }
  }
  const folders = (Array.isArray(raw.folders) ? raw.folders : []).filter((f) => f && typeof f.id === 'string');
  return { doc: mergeDocs({ notes, folders }, emptyDoc()) };
}

function validStroke(s) {
  return s && typeof s.id === 'string' && Array.isArray(s.pts) && s.pts.length >= 2 && s.pts.length % 2 === 0 &&
    s.pts.every((n) => typeof n === 'number' && Number.isFinite(n)) && typeof s.color === 'string' && Number.isFinite(s.w);
}

// What to write on this device to bring it up to doc: pages of markings and
// folders that differ. scores: [{ id, hash }].
export function localWrites(doc, scores, records, folders) {
  const notes = [];
  const byKey = new Map(records.map((r) => [`${r.fileId}:${r.page}`, r]));
  for (const s of scores) {
    const pages = s.hash && doc.notes[s.hash];
    if (!pages) continue;
    for (const [n, page] of Object.entries(pages)) {
      const here = byKey.get(`${s.id}:${n}`);
      const after = mergePage(here, page);
      if (!here || !sameContent(after, mergePage(here, null))) notes.push({ fileId: s.id, page: Number(n), data: page });
    }
  }
  const idsOf = new Map();
  for (const s of scores) if (s.hash) idsOf.set(s.hash, [...(idsOf.get(s.hash) || []), s.id]);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const lists = [];
  for (const f of doc.folders) {
    const members = [];
    for (const m of f.members) for (const id of idsOf.get(m.score) || []) members.push({ ...m, score: id });
    const incoming = { ...f, members };
    const here = byId.get(f.id);
    const after = mergeFolder(here, incoming);
    if (!here || !sameContent(after, normaliseFolder(here))) lists.push(incoming);
  }
  return { notes, lists };
}

// One round of markings-and-folders sync. Returns { notes, folders, sent }:
// the ids of the scores whose markings changed here and of the folders that
// changed here, and whether Drive's copy was updated.
//   ensureFolder()  the Music Stand folder in use (made if there is none)
//   check()         throws to pause the run
export async function syncData({ remote, local, log = () => {}, check = () => {}, ensureFolder }) {
  const out = { notes: [], folders: [], sent: false };
  const scores = (await local.scores()).filter((s) => s.hash);
  const records = await local.notesRecords();
  const folders = await local.folders();
  const { data: state = {}, restore = null } = await local.records();
  const here = localDoc(scores, records, folders);
  const hashes = new Set(scores.map((s) => s.hash));
  const fp = await fingerprintOf(here, hashes);

  let files = (await remote.listData()).sort(older);
  // Drive's listing can lag behind a file made a moment ago: this device's
  // own file still counts if it's there.
  if (!files.length && state.driveId) {
    try {
      const own = await remote.get(state.driveId);
      if (own && !own.trashed && (own.appProperties || {}).msKind === 'data') files = [own];
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const [first] = files;
  const unchanged = files.length === 1 && first.id === state.driveId && first.md5Checksum === state.md5 && fp === state.fp && !restore;
  if (unchanged || (!files.length && isEmptyDoc(here))) return out;

  // Every copy in Drive (normally one; two if devices made one each at once).
  check();
  let remoteDoc = emptyDoc();
  const read = new Map();
  for (const f of files) {
    const parsed = parse(await remote.readData(f.id));
    if (parsed.newer) {
      log('Markings and folders weren’t synced: another device has a newer version of Music Stand. Update Music Stand on this device (Update now).');
      return out;
    }
    if (parsed.bad) {
      log('Set aside an unreadable notes-and-folders file in Google Drive.');
      await remote.setAside(f.id);
      continue;
    }
    read.set(f.id, parsed.doc);
    remoteDoc = mergeDocs(remoteDoc, parsed.doc);
  }
  files = files.filter((f) => read.has(f.id));

  const mine = restore ? resurrect(here, remoteDoc, new Set(restore.hashes || [])) : here;
  const merged = mergeDocs(remoteDoc, mine);

  // Bring this device up to date.
  const writes = localWrites(merged, scores, records, folders);
  if (writes.notes.length || writes.lists.length) {
    check();
    await local.applyData(writes);
    out.notes = [...new Set(writes.notes.map((w) => w.fileId))];
    out.folders = writes.lists.map((f) => f.id);
  }

  // Bring Drive up to date: one file with everything.
  check();
  let file = files[0];
  if (!file) {
    const folder = await ensureFolder();
    file = await remote.createData(folder.id, serialize(merged));
    out.sent = true;
  } else if (!sameContent(read.get(file.id), merged)) {
    file = await remote.writeData(file.id, serialize(merged));
    out.sent = true;
  }
  for (const extra of files.slice(1)) {
    try {
      await remote.update(extra.id, { trashed: true });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  await local.setDataState({ driveId: file.id, md5: file.md5Checksum, fp: await fingerprintOf(restrictTo(merged, hashes), hashes) }, restore);
  return out;
}
