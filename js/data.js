// App-level data API: settings, the PDF library, reading positions.
import * as db from './db.js';
import { openPdf, readPageSizes, renderThumb } from './pdfdoc.js';
import { syncAccount } from './gdrive-auth.js';

export const DEFAULT_SETTINGS = {
  // Page turning
  turnMode: 'scroll',      // 'scroll' (one long strip) | 'page' (one page at a time)
  scrollAmount: 80,        // % of screen height per turn
  scrollDuration: 400,     // ms; 0 = jump
  readingGuide: true,      // flash a line where the old screen edge was
  tapToTurn: true,         // tap top third = back, bottom third = forward
  keepAwake: true,
  nightMode: false,
  // Wink control
  winkEnabled: false,
  winkForwardEye: 'right', // 'right' | 'left'
  winkBack: true,          // other eye scrolls back
  winkSensitivity: 5,      // 1..10
  winkHoldMs: 200,         // how long the wink must be held
  winkSwap: false,         // swap if the camera reports eyes mirrored
  winkFps: 20,
  winkPreview: false,
  // Notes
  pencilDraws: true,       // Apple Pencil writes without opening the notes toolbar
  notesTool: 'pen',        // 'pen' | 'hl' (last one used; the eraser isn't kept)
  penColor: 0,
  penWidth: 1,
  hlColor: 0,
  // Adjust pages
  cropShape: 'free',       // 'free' | 'page' (the page's own shape) | 'screen' (fills the screen)
};

let settings = { ...DEFAULT_SETTINGS };
const settingsListeners = new Set();
let saveTimer = 0;

export async function loadSettings() {
  const saved = await db.get('kv', 'settings');
  settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  return settings;
}

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.put('kv', settings, 'settings'), 250);
  for (const fn of settingsListeners) fn(settings, patch);
}

// Swaps in a whole set of settings (restoring a backup) and tells everyone.
export async function replaceSettings(next) {
  clearTimeout(saveTimer);
  settings = { ...DEFAULT_SETTINGS, ...(next || {}) };
  await db.put('kv', settings, 'settings');
  for (const fn of settingsListeners) fn(settings, { ...settings });
}

export function onSettings(fn) {
  settingsListeners.add(fn);
  return () => settingsListeners.delete(fn);
}

// ---- Library ----

const libraryListeners = new Set();
export function onLibraryChange(fn) {
  libraryListeners.add(fn);
  return () => libraryListeners.delete(fn);
}
export function notifyLibraryChange() {
  for (const fn of libraryListeners) fn();
}

// Changes the person made here (add, rename, delete, notes, folders), as
// opposed to ones Google Drive sync brought in. Sync listens so it can send
// them on.
const editListeners = new Set();
export function onLibraryEdit(fn) {
  editListeners.add(fn);
  return () => editListeners.delete(fn);
}
export function libraryEdited() {
  notifyLibraryChange();
  for (const fn of editListeners) fn();
}
const edited = libraryEdited;

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export async function sha256(buf) {
  if (!crypto.subtle) return null;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function listFiles() {
  return db.getAll('files');
}

export function getFile(id) {
  return db.get('files', id);
}

export function getFileBlob(id) {
  return db.get('blobs', id);
}

export function getThumb(id) {
  return db.get('thumbs', id);
}

function cleanName(filename) {
  return filename.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
}

// Reads a PDF's pages and stores it with its thumbnail. Reading a big PDF
// takes seconds, so the store happens in one transaction that looks at the
// library as it is by then. fields: id, name, hash, addedAt. Options:
//   replace  new content for the score fields.id, keeping its name and
//            reading details; nothing is stored if it was deleted meanwhile
// Resolves to { meta, existing }. meta is null when nothing was stored;
// existing is then the id of a score that already has this PDF, if any.
export async function storePdf(buf, fields, { onProgress, replace = false } = {}) {
  // Always a fresh Blob made from the bytes: iOS can discard the temp file
  // behind a picked File, and a Blob made from Blobs that came out of
  // IndexedDB (a download's pieces) can stop being readable once those are
  // deleted. The Blob constructor copies the bytes, so PDF.js may take
  // ownership of buf.
  const blob = new Blob([buf], { type: 'application/pdf' });
  const pdf = await openPdf(buf);
  try {
    const pageSizes = await readPageSizes(pdf, onProgress);
    const thumb = await renderThumb(pdf).catch(() => null);
    const read = { size: blob.size, pageCount: pdf.numPages, pageSizes };
    const out = { meta: null, existing: null };
    await db.transact(['files', 'blobs', 'thumbs'], (s) => {
      const req = s.files.getAll();
      req.onsuccess = () => {
        const current = req.result.find((f) => f.id === fields.id);
        if (replace) {
          if (!current) return;
          out.meta = { ...current, hash: fields.hash, ...read };
          delete out.meta.damaged;
        } else {
          const same = req.result.find((f) => f.id === fields.id || (fields.hash && f.hash === fields.hash));
          if (same) {
            out.existing = same.hash === fields.hash ? same.id : null;
            return;
          }
          out.meta = { openedAt: 0, ...fields, ...read };
        }
        s.files.put(out.meta);
        s.blobs.put(blob, out.meta.id);
        if (thumb) s.thumbs.put(thumb, out.meta.id);
        else s.thumbs.delete(out.meta.id);
      };
    });
    return out;
  } finally {
    pdf.destroy();
  }
}

// Adds a PDF File/Blob to the library. Returns { status: 'added'|'duplicate', meta }.
export async function addPdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  if (hash) {
    const existing = (await listFiles()).find((f) => f.hash === hash);
    if (existing) return { status: 'duplicate', meta: existing };
  }
  const { meta, existing } = await storePdf(buf, { id: newId(), name: cleanName(file.name || 'Untitled'), hash, addedAt: Date.now() }, { onProgress });
  // The same PDF arrived meanwhile (Google Drive sync).
  if (!meta) return { status: 'duplicate', meta: await getFile(existing) };
  edited();
  return { status: 'added', meta };
}

export async function renameFile(id, name) {
  const meta = await getFile(id);
  if (!meta || !name.trim() || name.trim() === meta.name) return;
  meta.name = name.trim();
  await db.put('files', meta);
  edited();
}

export async function touchFile(id) {
  const meta = await getFile(id);
  if (!meta) return;
  meta.openedAt = Date.now();
  await db.put('files', meta);
}

// Deletes a score the person chose to delete. With Google Drive sync on, the
// note left behind tells sync to delete it everywhere.
export async function deleteFile(id) {
  const meta = await getFile(id);
  await removeFile(id, syncAccount() ? { hash: (meta && meta.hash) || null, at: Date.now() } : null);
  edited();
}

// Deletes a score's PDF, thumbnail, reading place and notes, and takes it out
// of its folders. tomb: the sync note to leave, or null when sync itself is
// deleting it.
export async function removeFile(id, tomb = null) {
  const notes = await db.getAllByIndex('annotations', 'fileId', id);
  await db.transact(['files', 'blobs', 'thumbs', 'positions', 'annotations', 'lists', 'kv'], (s) => {
    s.files.delete(id);
    s.blobs.delete(id);
    s.thumbs.delete(id);
    s.positions.delete(id);
    for (const n of notes) s.annotations.delete(n.id);
    const req = s.lists.getAll();
    req.onsuccess = () => {
      for (const f of req.result) {
        const members = (f.members || []).filter((m) => m.score !== id);
        if (members.length !== (f.members || []).length) s.lists.put({ ...f, members });
      }
    };
    if (tomb) s.kv.put(tomb, `sync:tomb:${id}`);
    // What its pages say (js/ocr.js).
    s.kv.delete(IDBKeyRange.bound(`ocr:${id}:`, `ocr:${id}:\uffff`));
  });
}

// Called when a score's PDF wouldn't open. True if what is stored here can't
// be read, or isn't the PDF that was stored (a score downloaded by an older
// version could lose its PDF this way). The score is then marked damaged,
// and Google Drive sync fetches a fresh copy (js/sync-local.js).
export async function checkDamaged(id) {
  const meta = await getFile(id);
  if (!meta || !meta.hash || !crypto.subtle) return false;
  let ok = false;
  try {
    const blob = await getFileBlob(id);
    ok = !!blob && (!meta.size || blob.size === meta.size) && (await sha256(await blob.arrayBuffer())) === meta.hash;
  } catch { /* not readable */ }
  if (ok) return false;
  const wrote = await db.update('files', id, (m) => (m && m.hash === meta.hash && !m.damaged ? { ...m, damaged: true } : undefined));
  if (wrote) libraryEdited(); // sync fetches it again
  return true;
}

// Rebuilds missing thumbnails (e.g. after restoring a backup).
export async function ensureThumb(meta) {
  const existing = await getThumb(meta.id);
  if (existing) return existing;
  const blob = await getFileBlob(meta.id);
  if (!blob) return null;
  const pdf = await openPdf(await blob.arrayBuffer());
  try {
    const thumb = await renderThumb(pdf);
    if (!thumb) return null;
    // Keep it only if the PDF wasn't replaced (a new version from Google
    // Drive) and no thumbnail was stored meanwhile.
    let kept = thumb;
    await db.transact(['files', 'thumbs'], (s) => {
      // Requests finish in order, so file is done when stored is.
      const file = s.files.get(meta.id);
      const stored = s.thumbs.get(meta.id);
      stored.onsuccess = () => {
        if (stored.result) kept = stored.result;
        else if (file.result && file.result.hash === meta.hash) s.thumbs.put(thumb, meta.id);
        else kept = null;
      };
    });
    return kept;
  } finally {
    pdf.destroy();
  }
}

// ---- Reading positions ----

export function getPosition(key) {
  return db.get('positions', key);
}

export function savePosition(pos) {
  return db.put('positions', pos);
}

// ---- Storage ----

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* not supported */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch { /* not supported */ }
  return null;
}
