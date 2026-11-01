// Backup = one .zip holding manifest.json (settings, file info, positions,
// annotations, lists) plus every PDF under files/.
import * as db from './db.js';
import { ZipWriter, ZipReader } from './zip.js';
import { getSettings, replaceSettings, libraryEdited, sha256 } from './data.js';
import { planFiles, summarise, recordsToWrite, restoredSettings } from './merge.js';

const FORMAT = 1;

function safeName(s) {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';
}

export function backupFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `music-stand-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;
}

export async function exportBackup(onProgress = () => {}) {
  const files = await db.getAll('files');
  const manifest = {
    app: 'music-stand',
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    settings: (await db.get('kv', 'settings')) || null,
    files: [],
    positions: await db.getAll('positions'),
    annotations: await db.getAll('annotations'),
    lists: await db.getAll('lists'),
  };
  const zip = new ZipWriter();
  const used = new Set();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress(i, files.length, f.name);
    const blob = await db.get('blobs', f.id);
    if (!blob) continue;
    let path = `files/${safeName(f.name)}.pdf`;
    if (used.has(path.toLowerCase())) path = `files/${safeName(f.name)} (${f.id.slice(0, 8)}).pdf`;
    used.add(path.toLowerCase());
    await zip.addBlob(path, blob);
    manifest.files.push({ ...f, path });
  }
  zip.addText('manifest.json', JSON.stringify(manifest, null, 1));
  onProgress(files.length, files.length, '');
  return zip.finish();
}

// Every PDF the manifest lists must be in the archive.
function checkFiles(zip, files) {
  if (!Array.isArray(files)) throw new Error('This backup is damaged: its list of scores is unreadable.');
  for (const f of files) {
    if (!f || !f.id || !f.path || !zip.has(f.path)) throw new Error('This backup is damaged: a PDF listed in it is missing.');
  }
}

// Reads a backup's manifest so the UI can describe it before importing.
export async function inspectBackup(file) {
  const zip = await ZipReader.open(file);
  if (!zip.has('manifest.json')) throw new Error('This ZIP is not a Music Stand backup (no manifest.json).');
  const manifest = JSON.parse(await zip.text('manifest.json'));
  if (!manifest || manifest.app !== 'music-stand') throw new Error('This ZIP is not a Music Stand backup.');
  if (manifest.format > FORMAT) throw new Error('This backup was made by a newer version of the app. Update the app first.');
  checkFiles(zip, manifest.files || []);
  return { zip, manifest };
}

const RECORD_STORES = ['positions', 'annotations', 'lists'];

// This device's files that can stand in for a backup's copy (those whose PDF
// is actually stored). Works out missing content hashes for files the backup
// could match (same size), so they can be recognised.
async function localFiles(backupFiles) {
  const stored = new Set(await db.getAllKeys('blobs'));
  const sizes = new Set(backupFiles.map((f) => f.size));
  const out = [];
  for (const f of await db.getAll('files')) {
    if (!stored.has(f.id)) continue;
    if (!f.hash && sizes.has(f.size)) {
      const blob = await db.get('blobs', f.id);
      const hash = blob && (await sha256(await blob.arrayBuffer()));
      if (hash) {
        f.hash = hash;
        await db.put('files', f);
      }
    }
    out.push(f);
  }
  return out;
}

function plan(zip, files, local) {
  return planFiles(files, local, async (f) => sha256(await (await zip.read(f.path)).arrayBuffer()));
}

// What importing would find: { scores, fresh, here } (see summarise).
export async function previewImport({ zip, manifest }) {
  const files = manifest.files || [];
  return summarise(await plan(zip, files, await localFiles(files)));
}

// Merge (the default) adds the scores this device doesn't have. A score that
// is already here, matched by id or by identical content, keeps this device's
// copy. Its reading place here wins; markings and folders from the backup are
// combined with the ones here (js/merge.js combineRecord). This device's
// settings are left alone.
// Replace makes this device a copy of the backup, apart from its own eye
// calibration. With Google Drive sync on, the next sync combines it with
// Drive's markings and folders; the backup's win where they disagree
// (markings erased since come back; folders deleted since come back).
export async function importBackup({ zip, manifest }, { replace }, onProgress = () => {}) {
  const files = manifest.files || [];
  checkFiles(zip, files); // before changing anything
  const steps = await plan(zip, files, replace ? [] : await localFiles(files));
  if (replace) {
    // Settings (kv) are swapped in at the end instead, so a failed import keeps them.
    for (const s of db.ALL_STORES) if (s !== 'kv') await db.clear(s);
    // Google Drive sync starts afresh with these scores: each is matched to
    // Drive again, so the restore wins and Drive's names are used.
    const synced = (await db.getAllWithPrefix('kv', 'sync:')).map(([k]) => k).filter((k) => /^sync:(link|upload):/.test(k));
    if (synced.length) await db.transact(['kv'], (st) => { for (const k of synced) st.kv.delete(k); });
  }

  const remap = new Map(); // backup file id → id of the same score here
  for (let i = 0; i < steps.length; i++) {
    const { file, same } = steps[i];
    onProgress(i, steps.length, file.name);
    if (same) {
      if (same !== file.id) remap.set(file.id, same);
      continue;
    }
    const { path, ...meta } = file;
    // Materialise the bytes so the stored Blob doesn't depend on the picked file.
    const bytes = await (await zip.read(path, 'application/pdf')).arrayBuffer();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    await db.transact(['files', 'blobs', 'thumbs'], (s) => {
      s.files.put(meta);
      s.blobs.put(blob, meta.id);
      s.thumbs.delete(meta.id); // regenerated lazily
    });
  }

  const writes = {};
  const now = Date.now();
  for (const s of RECORD_STORES) writes[s] = recordsToWrite(await db.getAll(s), manifest[s], remap, s, { replace, now });
  // Restored markings win once over erasures made since (see sync-data.js).
  let restore = null;
  if (replace && writes.annotations.length) {
    const hashOf = new Map((await db.getAll('files')).map((f) => [f.id, f.hash]));
    const hashes = [...new Set(writes.annotations.map((r) => hashOf.get(r.fileId)).filter(Boolean))];
    if (hashes.length) restore = { hashes, at: now };
  }
  await db.transact([...RECORD_STORES, 'kv'], (s) => {
    for (const name of RECORD_STORES) for (const r of writes[name]) s[name].put(r);
    if (restore) s.kv.put(restore, 'sync:restore');
  });
  // Read the calibration now, not at the start: it may have been redone meanwhile.
  if (replace) await replaceSettings(restoredSettings(manifest.settings, getSettings()));
  onProgress(steps.length, steps.length, '');
  libraryEdited(); // sync sends on what came in
  const { fresh, here } = summarise(steps);
  return { added: fresh, here };
}

// Hands the file to the iPad share sheet ("Save to Files"), or downloads it.
// Must be called directly from a tap so Safari allows the share sheet.
export async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
