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
//     notes: { <hash>: { <page>: { strokes, erased, view?, marks? } } },
//     folders: [{ id, name, nameAt, createdAt, deleted, deletedAt,
//                 members: [{ score: <hash>, in, at }] }],
//     zooms: { <hash>: { zoom, at } },
//     texts: { <hash>: { <page>: { text, at } } } }
//
// zooms is each score's zoom while scrolling (on a device it's kept with the
// reading place, which isn't synced). Older versions of the app leave it out
// of what they write; the devices that have it keep it.
//
// texts is what each page says, read by text recognition (js/ocr.js), so
// a hymnal is read once, not on every device. On a device it's kept in kv
// ("ocr:<score>:<page>"). The newer reading of a page wins.
//
// Every copy combines with the rules in js/notes-merge.js, which never lose a
// change, so a run can stop anywhere, and two devices writing at once only
// cost another round. A run downloads, combines and uploads only when
// something changed: Drive's copy (its md5), or what this device has (a
// fingerprint of its markings, folders and scores, recorded at the last
// sync: a score that arrives brings markings and folders to apply).
import { mergePage, pageIsEmpty, mergeNotes, mergeFolder, mergeFolders, normaliseFolder, sameContent, fingerprint, mergeZoom, mergeZooms, normZoom } from './notes-merge.js';

export const DATA_NAME = 'Music Stand notes and folders.json';
export const DATA_VERSION = 1;

const emptyDoc = () => ({ notes: {}, folders: [], zooms: {}, texts: {} });

// ---- Page texts ----

const MAX_TEXT = 20000; // characters kept of a page's text

export function normText(t) {
  if (!t || typeof t !== 'object' || typeof t.text !== 'string') return null;
  const at = Number(t.at) || 0;
  return at ? { text: t.text.slice(0, MAX_TEXT), at } : null;
}

export function mergeText(a, b) {
  a = normText(a);
  b = normText(b);
  if (!a || !b) return a || b;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return a.text >= b.text ? a : b;
}

// Texts by score, then page.
export function mergeTexts(a = {}, b = {}) {
  const out = {};
  for (const h of [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort()) {
    const pa = (a || {})[h] || {};
    const pb = (b || {})[h] || {};
    const pages = {};
    for (const n of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((k) => /^\d+$/.test(k)).sort((x, y) => x - y)) {
      const t = mergeText(pa[n], pb[n]);
      if (t) pages[n] = t;
    }
    if (Object.keys(pages).length) out[h] = pages;
  }
  return out;
}

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

// This device's markings, folders, zooms and page texts, with scores known
// by hash. scores: [{ id, hash }]; records: annotation records; folders:
// lists records; positions: reading places ({ id, zoom, zoomAt }); texts:
// [{ fileId, page, text, at }].
export function localDoc(scores, records, folders, positions = [], texts = []) {
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
  const zooms = {};
  for (const p of positions) {
    const h = p && hashOf.get(p.id);
    if (h && p.zoomAt) zooms[h] = mergeZoom(zooms[h], { zoom: p.zoom, at: p.zoomAt });
  }
  const read = {};
  for (const t of texts) {
    const h = t && hashOf.get(t.fileId);
    if (!h) continue;
    const pages = read[h] || (read[h] = {});
    pages[t.page] = mergeText(pages[t.page], t);
  }
  return { notes: sortedNotes(notes), folders: mergeFolders(translated), zooms: mergeZooms(zooms), texts: mergeTexts(read) };
}

export function mergeDocs(a, b) {
  const notes = {};
  for (const h of new Set([...Object.keys(a.notes || {}), ...Object.keys(b.notes || {})])) {
    notes[h] = mergeNotes({ pages: (a.notes || {})[h] }, { pages: (b.notes || {})[h] }).pages;
  }
  return { notes: sortedNotes(notes), folders: mergeFolders(a.folders || [], b.folders || []), zooms: mergeZooms(a.zooms, b.zooms), texts: mergeTexts(a.texts, b.texts) };
}

// The part of a doc about the scores on this device (what localDoc gives
// once the doc is applied here).
export function restrictTo(doc, hashes) {
  const notes = {};
  for (const h of Object.keys(doc.notes)) if (hashes.has(h)) notes[h] = doc.notes[h];
  return {
    notes,
    folders: doc.folders.map((f) => normaliseFolder({ ...f, members: f.members.filter((m) => hashes.has(m.score)) })),
    zooms: Object.fromEntries(Object.entries(doc.zooms || {}).filter(([h]) => hashes.has(h))),
    texts: Object.fromEntries(Object.entries(doc.texts || {}).filter(([h]) => hashes.has(h))),
  };
}

export function isEmptyDoc(doc) {
  return !Object.keys(doc.notes).length && !doc.folders.length && !Object.keys(doc.zooms || {}).length && !Object.keys(doc.texts || {}).length;
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
      notes[h][n] = mergePage({ strokes: page.strokes.map((s) => (gone.has(s.id) ? { ...s, id: revived(s.id) } : s)), erased: page.erased, view: page.view, marks: page.marks }, null);
    }
  }
  return { notes: sortedNotes(notes), folders: local.folders, zooms: local.zooms || {}, texts: local.texts || {} };
}

// Whether this device has markings or folder changes Drive hasn't had yet
// (for the "waiting to sync" sign at start-up).
export async function dataPending(local) {
  const scores = (await local.scores()).filter((s) => s.hash);
  const here = localDoc(scores, await local.notesRecords(), await local.folders(), local.places ? await local.places() : [], local.pageTexts ? await local.pageTexts() : []);
  const { data: state = {} } = await local.records();
  if (isEmptyDoc(here) && !state.fp) return false;
  return (await fingerprintOf(here, scores.map((s) => s.hash))) !== state.fp;
}

// What the device's markings, folders and scores looked like, in short.
function fingerprintOf(doc, hashes) {
  return fingerprint({ doc, scores: [...new Set(hashes)].sort() });
}

export function serialize(doc) {
  return JSON.stringify({ app: 'music-stand', kind: 'data', v: DATA_VERSION, notes: doc.notes, folders: doc.folders, zooms: doc.zooms || {}, texts: doc.texts || {} });
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
      notes[h][n] = mergePage({ strokes: (Array.isArray(p.strokes) ? p.strokes : []).filter(validStroke), erased: (Array.isArray(p.erased) ? p.erased : []).filter((id) => typeof id === 'string'), view: p.view, marks: p.marks }, null);
    }
  }
  const folders = (Array.isArray(raw.folders) ? raw.folders : []).filter((f) => f && typeof f.id === 'string');
  const zooms = {};
  for (const [h, z] of Object.entries(raw.zooms && typeof raw.zooms === 'object' ? raw.zooms : {})) {
    const n = normZoom(z);
    if (n) zooms[h] = n;
  }
  const texts = raw.texts && typeof raw.texts === 'object' ? raw.texts : {};
  return { doc: mergeDocs({ notes, folders, zooms, texts }, emptyDoc()) };
}

function validStroke(s) {
  return s && typeof s.id === 'string' && Array.isArray(s.pts) && s.pts.length >= 2 && s.pts.length % 2 === 0 &&
    s.pts.every((n) => typeof n === 'number' && Number.isFinite(n)) && typeof s.color === 'string' && Number.isFinite(s.w);
}

// What to write on this device to bring it up to doc: pages of markings,
// folders, zooms and page texts that differ. scores: [{ id, hash }].
export function localWrites(doc, scores, records, folders, positions = [], texts = []) {
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
  const posOf = new Map(positions.map((p) => [p.id, p]));
  const zooms = [];
  for (const s of scores) {
    const z = s.hash && (doc.zooms || {})[s.hash];
    if (!z) continue;
    const p = posOf.get(s.id);
    if (!p || !p.zoomAt || z.at > p.zoomAt) zooms.push({ fileId: s.id, zoom: z.zoom, at: z.at });
  }
  const textOf = new Map(texts.map((t) => [`${t.fileId}:${t.page}`, t]));
  const reads = [];
  for (const s of scores) {
    const pages = s.hash && (doc.texts || {})[s.hash];
    if (!pages) continue;
    for (const [n, t] of Object.entries(pages)) {
      const here = normText(textOf.get(`${s.id}:${n}`));
      if (!here || !sameContent(mergeText(here, t), here)) reads.push({ fileId: s.id, page: Number(n), text: t.text, at: t.at });
    }
  }
  return { notes, lists, zooms, texts: reads };
}

// One round of markings-and-folders sync. Returns { notes, folders, sent }:
// the ids of the scores whose markings changed here and of the folders that
// changed here, and whether Drive's copy was updated.
//   ensureFolder()  the Music Stand folder in use (made if there is none)
//   check()         throws to pause the run
export async function syncData({ remote, local, log = () => {}, check = () => {}, ensureFolder }) {
  const out = { notes: [], folders: [], zooms: 0, texts: 0, sent: false };
  const scores = (await local.scores()).filter((s) => s.hash);
  const records = await local.notesRecords();
  const folders = await local.folders();
  const positions = local.places ? await local.places() : [];
  const pageTexts = local.pageTexts ? await local.pageTexts() : [];
  const { data: state = {}, restore = null } = await local.records();
  const here = localDoc(scores, records, folders, positions, pageTexts);
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
  const writes = localWrites(merged, scores, records, folders, positions, pageTexts);
  if (writes.notes.length || writes.lists.length || writes.zooms.length || writes.texts.length) {
    check();
    await local.applyData(writes);
    out.notes = [...new Set(writes.notes.map((w) => w.fileId))];
    out.folders = writes.lists.map((f) => f.id);
    out.zooms = writes.zooms.length;
    out.texts = new Set(writes.texts.map((t) => t.fileId)).size;
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
