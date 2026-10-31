// Rules for bringing a backup into the library. No DOM or IndexedDB here, so
// they can be unit tested (tests/merge.test.mjs).

// Finds the file on this device that a backup's file is a copy of: first by
// id (it was copied here before), then by content hash (the same PDF was
// added on both devices). Files added as the import goes count too, so
// duplicates inside one backup collapse into a single score.
export class FileMatcher {
  constructor(files = []) {
    this.ids = new Set();
    this.hashes = new Map();
    for (const f of files) this.add(f);
  }

  add(meta) {
    this.ids.add(meta.id);
    if (meta.hash && !this.hashes.has(meta.hash)) this.hashes.set(meta.hash, meta.id);
  }

  // The id of the matching file here, or null if the file is new.
  match(meta) {
    if (this.ids.has(meta.id)) return meta.id;
    return (meta.hash && this.hashes.get(meta.hash)) || null;
  }
}

// Decides what happens to each backup file. local: this device's files (empty
// when replacing). Returns, in order, { file, same, here }: same is the id of
// the matching score (here, or earlier in the backup), null if the file is new;
// here says the match is on this device. Shared by the import and its preview
// so their counts agree.
// A file without a hash (added without HTTPS) gets one from hashOf(file), but
// only when another file has the same size, since identical content means
// identical size. The hash is kept on the entry so the import can reuse it.
export async function planFiles(files, local, hashOf) {
  const sizes = new Map();
  for (const f of [...local, ...files]) sizes.set(f.size, (sizes.get(f.size) || 0) + 1);
  const matcher = new FileMatcher(local);
  const localIds = new Set(local.map((f) => f.id));
  const plan = [];
  for (const file of files) {
    let same = matcher.match(file);
    if (!same && !file.hash && sizes.get(file.size) > 1) {
      file.hash = await hashOf(file);
      same = matcher.match(file);
    }
    if (!same) matcher.add(file);
    plan.push({ file, same, here: !!same && localIds.has(same) });
  }
  return plan;
}

// Counts for a plan: distinct scores in the backup, how many are new to this
// device, and how many are already here. Copies of one score count once.
export function summarise(plan) {
  const fresh = plan.filter((p) => !p.same).length;
  const here = new Set(plan.filter((p) => p.here).map((p) => p.same)).size;
  return { scores: fresh + here, fresh, here };
}

// Points a record at this device's copy of a file. Any string equal to a
// remapped file id, or starting with "<fileId>:" (annotation ids are
// "fileId:page"), gets the local id. File ids are random UUIDs, so nothing
// else can match by accident.
export function remapIds(value, remap) {
  if (!remap.size) return value;
  if (typeof value === 'string') {
    if (remap.has(value)) return remap.get(value);
    const i = value.indexOf(':');
    if (i > 0 && remap.has(value.slice(0, i))) return remap.get(value.slice(0, i)) + value.slice(i);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => remapIds(v, remap));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = remapIds(value[k], remap);
    return out;
  }
  return value;
}

// A record that is both here and in the backup keeps this device's copy,
// unless both carry an updatedAt and the backup's is newer.
export function takeIncoming(here, incoming) {
  if (!here) return true;
  return typeof here.updatedAt === 'number' && typeof incoming.updatedAt === 'number' && incoming.updatedAt > here.updatedAt;
}

// The backup records (reading places, notes, lists) to write, given the
// records already here and the backup-id → local-id map from the files.
export function recordsToWrite(here, incoming, remap) {
  const current = new Map(here.map((r) => [r.id, r]));
  const out = new Map();
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (!raw || raw.id == null) continue;
    const r = remapIds(raw, remap);
    if (takeIncoming(current.get(r.id), r)) {
      current.set(r.id, r);
      out.set(r.id, r);
    }
  }
  return [...out.values()];
}

// Settings that belong to the device rather than the person. Eye calibration
// depends on how this device's camera reports left and right.
export const DEVICE_SETTINGS = ['winkSwap'];

// Settings after replacing this device's data with a backup: the backup's,
// but keeping this device's own calibration.
export function restoredSettings(fromBackup, current) {
  const out = { ...(fromBackup || {}) };
  for (const k of DEVICE_SETTINGS) {
    if (current && k in current) out[k] = current[k];
    else delete out[k];
  }
  return out;
}
