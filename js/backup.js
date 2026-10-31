// Backup = one .zip holding manifest.json (settings, file info, positions,
// annotations, lists) plus every PDF under files/.
import * as db from './db.js';
import { ZipWriter, ZipReader } from './zip.js';
import { loadSettings, notifyLibraryChange } from './data.js';

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

// Reads a backup's manifest so the UI can describe it before importing.
export async function inspectBackup(file) {
  const zip = await ZipReader.open(file);
  if (!zip.has('manifest.json')) throw new Error('This ZIP is not a Music Stand backup (no manifest.json).');
  const manifest = JSON.parse(await zip.text('manifest.json'));
  if (manifest.app !== 'music-stand') throw new Error('This ZIP is not a Music Stand backup.');
  if (manifest.format > FORMAT) throw new Error('This backup was made by a newer version of the app. Update the app first.');
  return { zip, manifest };
}

// replace: wipe everything first. Otherwise merge; items in the backup
// overwrite items with the same id.
export async function importBackup({ zip, manifest }, { replace }, onProgress = () => {}) {
  if (replace) {
    for (const s of db.ALL_STORES) await db.clear(s);
  }
  const files = manifest.files || [];
  for (let i = 0; i < files.length; i++) {
    const { path, ...meta } = files[i];
    onProgress(i, files.length, meta.name);
    const part = await zip.read(path, 'application/pdf');
    // Materialise the bytes so the stored Blob doesn't depend on the picked file.
    const blob = new Blob([await part.arrayBuffer()], { type: 'application/pdf' });
    await db.transact(['files', 'blobs', 'thumbs'], (s) => {
      s.files.put(meta);
      s.blobs.put(blob, meta.id);
      s.thumbs.delete(meta.id); // regenerated lazily
    });
  }
  await db.transact(['positions', 'annotations', 'lists'], (s) => {
    for (const p of manifest.positions || []) s.positions.put(p);
    for (const a of manifest.annotations || []) s.annotations.put(a);
    for (const l of manifest.lists || []) s.lists.put(l);
  });
  if (manifest.settings) {
    await db.put('kv', manifest.settings, 'settings');
    await loadSettings();
  }
  onProgress(files.length, files.length, '');
  notifyLibraryChange();
  return { files: files.length };
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
