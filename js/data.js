// App-level data API: settings, the PDF library, reading positions.
import * as db from './db.js';
import { openPdf, readPageSizes, renderThumb } from './pdfdoc.js';

export const DEFAULT_SETTINGS = {
  // Page turning
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

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function sha256(buf) {
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

// Adds a PDF File/Blob to the library. Returns { status: 'added'|'duplicate', meta }.
export async function addPdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  if (hash) {
    const existing = (await listFiles()).find((f) => f.hash === hash);
    if (existing) return { status: 'duplicate', meta: existing };
  }
  // Copy into a fresh Blob: iOS can discard the temp file behind a picked File.
  // (The Blob constructor copies the bytes, so PDF.js may take ownership of buf.)
  const blob = new Blob([buf], { type: 'application/pdf' });
  const pdf = await openPdf(buf);
  try {
    const pageSizes = await readPageSizes(pdf, onProgress);
    const thumb = await renderThumb(pdf).catch(() => null);
    const meta = {
      id: newId(),
      name: cleanName(file.name || 'Untitled'),
      size: blob.size,
      pageCount: pdf.numPages,
      pageSizes,
      hash,
      addedAt: Date.now(),
      openedAt: 0,
    };
    await db.transact(['files', 'blobs', 'thumbs'], (s) => {
      s.files.put(meta);
      s.blobs.put(blob, meta.id);
      if (thumb) s.thumbs.put(thumb, meta.id);
    });
    notifyLibraryChange();
    return { status: 'added', meta };
  } finally {
    pdf.destroy();
  }
}

export async function renameFile(id, name) {
  const meta = await getFile(id);
  if (!meta) return;
  meta.name = name.trim() || meta.name;
  await db.put('files', meta);
  notifyLibraryChange();
}

export async function touchFile(id) {
  const meta = await getFile(id);
  if (!meta) return;
  meta.openedAt = Date.now();
  await db.put('files', meta);
}

export async function deleteFile(id) {
  const notes = await db.getAllByIndex('annotations', 'fileId', id);
  await db.transact(['files', 'blobs', 'thumbs', 'positions', 'annotations'], (s) => {
    s.files.delete(id);
    s.blobs.delete(id);
    s.thumbs.delete(id);
    s.positions.delete(id);
    for (const n of notes) s.annotations.delete(n.id);
  });
  notifyLibraryChange();
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
    if (thumb) await db.put('thumbs', thumb, meta.id);
    return thumb;
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
