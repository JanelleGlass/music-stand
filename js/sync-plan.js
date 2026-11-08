// Decides what one sync with Google Drive does, from this device's library,
// its sync records and a listing of the app's files in Drive. No DOM,
// IndexedDB or network here, so the rules can be unit tested
// (tests/sync-plan.test.mjs, tests/sync-engine.test.mjs).
//
// In Drive every score is one PDF, "<name>.pdf", whose appProperties carry
// msKind 'score', msId (the id of the device copy it was uploaded from),
// msHash (SHA-256 of the PDF) and msAdded (when it was added, in ms). Two
// files with the same content are the same score: the oldest is kept and
// the other copies go to the trash. A device keeps its own id for a score
// and remembers which Drive file it goes with (its link), so ids don't have
// to match across devices.
//
// Names: each link remembers the name both sides agreed on last time. A
// side that differs from it was renamed; if both were (or there is nothing to
// compare with yet), the name in Drive wins.

export const FOLDER_NAME = 'Music Stand';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

// A delete only takes Drive copies of the same PDF that were already there
// when it was made (give or take clock differences), not ones added since.
const TOMB_SLACK_MS = 10 * 60 * 1000;

const props = (r) => r.appProperties || {};
export const kindOf = (r) => props(r).msKind || '';
export const scoreIdOf = (r) => props(r).msId || null;
// Drive's own checksum follows the content, even after "Manage versions".
export const hashOf = (r) => r.sha256Checksum || props(r).msHash || null;

// "Grace.pdf" → "Grace"
export function scoreName(driveName) {
  return String(driveName || '').replace(/\.pdf$/i, '').trim() || 'Untitled';
}

export function driveName(name) {
  return `${name}.pdf`;
}

// The oldest first; ties go to the smaller id, so every device picks the same one.
function older(a, b) {
  const ta = Date.parse(a.createdTime) || 0;
  const tb = Date.parse(b.createdTime) || 0;
  return ta !== tb ? ta < tb : a.id < b.id;
}

// The "Music Stand" folder new uploads go into: the oldest one not in the trash.
export function pickFolder(listing) {
  let best = null;
  for (const r of listing) {
    if (kindOf(r) === 'folder' && r.mimeType === FOLDER_MIME && !r.trashed && (!best || older(r, best))) best = r;
  }
  return best;
}

// local: [{ id, name, hash, damaged? }] (damaged: the PDF here can't be read,
//   so Drive's copy is fetched again)
// links: Map scoreId → { driveId, name }: the Drive file each score was last
//   synced with, and the name both sides had then (null: don't know).
// tombs: Map scoreId → { hash, at }: scores deleted here since the last sync.
// uploads: Map scoreId → { name, at, … }: upload under way (its reply may have
//   been lost); name is the name it was uploaded with.
// recent: Drive ids this device trashed in the last few minutes (Drive's
//   listing can lag behind and still show them).
// listing: every file the app can see in Drive, trashed ones included.
//
// Returns:
//   tombs        [{ id, targets }]: Drive ids to trash for each delete made here
//                (one may be missing from the listing if it lags; a 404 then
//                means it is gone already)
//   trash        Drive ids of duplicates to trash
//   moves        [{ driveId, from, to }]: scores to move out of a spare or
//                trashed Music Stand folder into the one in use
//   spareFolders spare Music Stand folders with no live scores left in them, to
//                retire: renamed and marked msKind 'retired', never trashed
//                (the person may have put their own files in them, which the
//                app can't see). Scores that still land in one are moved out.
//   matches      [{ id, driveId, rename, name, expect }]: a score here and its
//                file in Drive. rename is 'local', 'remote' or null; name is
//                the name both end up with; expect is the name here now.
//   replace      [{ id, driveId }]: Drive has a different PDF for the score
//                (a new version was uploaded in Drive), or the one here is
//                damaged: fetch it
//   deleteLocal  [{ id, name, driveId, linked, folder }]: synced before, and now
//                in the Drive trash (driveId) or missing from the listing
//                (driveId null; linked is the Drive id to check). folder: the
//                Music Stand folder, when the score went to the trash with it.
//   upload       score ids not in Drive yet
//   download     Drive ids of scores this device doesn't have
//   dropLinks    links of scores no longer here
//   skipped      [{ id, why }] scores left alone this time
export function planSync({ local, links, tombs, listing, uploads = new Map(), recent = new Set() }) {
  const plan = { tombs: [], trash: [], moves: [], spareFolders: [], matches: [], replace: [], deleteLocal: [], upload: [], download: [], dropLinks: [], skipped: [] };
  const scores = listing.filter((r) => kindOf(r) === 'score');
  // Music Stand folders, including retired spares (see spareFolders).
  const folders = new Map(listing.filter((r) => kindOf(r) === 'folder' || kindOf(r) === 'retired').map((r) => [r.id, r]));
  const byDriveId = new Map(scores.map((r) => [r.id, r]));
  const localIds = new Set(local.map((s) => s.id));
  const localHashes = new Set(local.map((s) => s.hash).filter(Boolean));
  const gone = new Set(); // Drive ids this plan trashes

  // Deleted here: the Drive file it was linked to, and copies of the same PDF
  // that were in Drive then, unless the same PDF has been added back here.
  // Files this device trashed lately count as trashed even if the listing,
  // a moment behind, still shows them.
  const live = scores.filter((r) => !r.trashed && !recent.has(r.id));
  for (const [id, tomb] of tombs) {
    const linked = links.get(id) && links.get(id).driveId;
    const targets = [];
    if (linked && !byDriveId.has(linked) && !recent.has(linked)) targets.push(linked);
    for (const r of live) {
      const h = hashOf(r);
      if (h && localHashes.has(h)) continue;
      const before = (Date.parse(r.createdTime) || 0) <= (tomb.at || 0) + TOMB_SLACK_MS;
      if (r.id === linked || scoreIdOf(r) === id || (tomb.hash && h === tomb.hash && before)) {
        targets.push(r.id);
        gone.add(r.id);
      }
    }
    plan.tombs.push({ id, targets });
  }

  // One survivor per PDF content; the other copies are duplicates.
  const keep = live.filter((r) => !gone.has(r.id));
  const byHash = new Map();
  for (const r of keep) {
    const h = hashOf(r);
    if (h && (!byHash.has(h) || older(r, byHash.get(h)))) byHash.set(h, r);
  }
  const survivors = [];
  for (const r of keep) {
    const h = hashOf(r);
    if (h && byHash.get(h).id !== r.id) plan.trash.push(r.id);
    else if (!survivors.some((x) => x.id === r.id)) survivors.push(r);
  }
  const survivorIds = new Set(survivors.map((r) => r.id));
  const byScoreId = new Map();
  for (const r of survivors) {
    const id = scoreIdOf(r);
    if (id && !byScoreId.has(id)) byScoreId.set(id, r);
  }

  // A single Music Stand folder: scores in spare ones, or still live in one
  // in the trash, move to the oldest.
  const inUse = pickFolder(listing);
  for (const f of folders.values()) {
    if (!inUse || f.id === inUse.id) continue;
    const inside = scores.filter((r) => (r.parents || []).includes(f.id));
    for (const r of survivors) if (inside.includes(r)) plan.moves.push({ driveId: r.id, from: f.id, to: inUse.id });
    if (kindOf(f) === 'folder' && !f.trashed && !inside.some((r) => !r.trashed)) plan.spareFolders.push(f.id);
  }

  // Scores here. The one Drive knows by this id claims its file first; a
  // second copy of the same PDF here is left alone.
  const order = [...local].sort((a, b) => Number(!byScoreId.has(a.id)) - Number(!byScoreId.has(b.id)));
  const claimed = new Set();
  for (const s of order) {
    const link = links.get(s.id);
    const linked = link && survivorIds.has(link.driveId) ? byDriveId.get(link.driveId) : null;
    const r = byScoreId.get(s.id) || linked || (s.hash && byHash.get(s.hash)) || null;
    if (r && claimed.has(r.id)) {
      plan.skipped.push({ id: s.id, why: 'another score here is the same PDF' });
      continue;
    }
    if (r) {
      claimed.add(r.id);
      const remote = scoreName(r.name);
      // Without a link, an upload whose reply was lost still knows the name
      // Drive was given.
      const upload = !link && uploads.get(s.id);
      const agreed = link ? link.name : upload && upload.name;
      const base = typeof agreed === 'string' ? agreed : null;
      let rename = null;
      if (s.name === remote) rename = null;
      else if (base !== null && remote === base) rename = 'remote';
      else rename = 'local';
      plan.matches.push({ id: s.id, driveId: r.id, rename, name: rename === 'remote' ? s.name : remote, expect: s.name });
      // A new version in Drive, or the PDF here can't be read any more.
      if (s.hash && hashOf(r) && (hashOf(r) !== s.hash || s.damaged)) plan.replace.push({ id: s.id, driveId: r.id });
      continue;
    }
    // Synced before and no copy left in Drive: deleted elsewhere, whether it
    // is in the trash or gone for good (trash emptied, or 30 days passed).
    // An upload whose reply was lost counts as synced: Drive has its file
    // (made after the upload started, so not an older copy from before a
    // backup was restored).
    const started = !link && uploads.has(s.id) ? (uploads.get(s.id).at || 0) - TOMB_SLACK_MS : null;
    const uploaded = started !== null ? scores.find((x) => scoreIdOf(x) === s.id && x.trashed && (Date.parse(x.createdTime) || 0) >= started) : null;
    if (link || uploaded) {
      const before = uploaded || byDriveId.get(link.driveId) || null;
      const parent = before && !before.explicitlyTrashed && (before.parents || []).map((p) => folders.get(p)).find((f) => f && f.trashed);
      plan.deleteLocal.push({ id: s.id, name: s.name, driveId: before ? before.id : null, linked: link ? link.driveId : null, folder: parent ? parent.id : null });
      continue;
    }
    if (s.damaged) {
      plan.skipped.push({ id: s.id, why: 'its PDF on this device is damaged and Google Drive has no copy' });
      continue;
    }
    plan.upload.push(s.id);
  }

  // In Drive but not here.
  for (const r of survivors) {
    if (claimed.has(r.id)) continue;
    const id = scoreIdOf(r);
    if (!id || localIds.has(id) || tombs.has(id) || recent.has(r.id)) continue;
    plan.download.push(r.id);
  }

  for (const id of links.keys()) if (!localIds.has(id) && !tombs.has(id)) plan.dropLinks.push(id);
  return plan;
}

// Deleting this many scores at once looks more like an accident (the Music
// Stand folder put in the Drive trash, or lost access) than a decision, so
// sync waits for the person's say.
export function needsDeleteConfirmation(count, librarySize) {
  return count > 5 || (count > 1 && count * 2 > librarySize);
}
