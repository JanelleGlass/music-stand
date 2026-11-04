// Runs one sync with Google Drive: lists Drive, plans (sync-plan.js), then
// carries the plan out. Talks to Drive and to this device's library only
// through the two adapters it is given (js/sync-remote.js and
// js/sync-local.js in the app; fakes in the tests), so the whole run can be
// tested in Node.
//
// Every run plans afresh from what is actually there, so a run that stops
// part way (the iPad slept, a score was opened, the network dropped) is
// simply finished by the next one. Uploads and downloads go in pieces that
// are kept, so a big hymnal carries on where it stopped.
import { planSync, pickFolder, needsDeleteConfirmation, scoreName, driveName, hashOf, scoreIdOf, FOLDER_NAME } from './sync-plan.js';
import { syncData } from './sync-data.js';

const DOWNLOAD_PIECE = 8 * 1024 * 1024;
const STORAGE_SPARE = 300 * 1024 * 1024; // room to leave on the iPad after a download
const SESSION_MS = 6 * 24 * 60 * 60 * 1000; // Drive keeps an upload session for a week
const RECENT_MS = 10 * 60 * 1000; // how long Drive's listing may lag behind a trash
const MAX_CHECKS = 20; // missing scores to look up one by one before just asking
// 403s that are about the whole account rather than one file.
const ACCOUNT_403 = new Set(['storageQuotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'domainPolicy', 'insufficientPermissions', 'authError']);

export class SyncStopped extends Error {
  constructor() {
    super('Sync paused');
  }
}

// The run was stopped on purpose, with a message for the person.
export class SyncRefused extends Error {}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

// A problem with one score (a damaged PDF, a file Drive won't give back)
// shouldn't hold up the rest. Losing the network, the sign-in or the
// storage should.
function stopsTheRun(e) {
  if (!e || e instanceof SyncStopped || e instanceof SyncRefused) return true;
  if (e.name === 'TypeError' || e.name === 'AbortError' || e.name === 'QuotaExceededError') return true;
  return e.status === 401 || (e.status === 403 && ACCOUNT_403.has(e.reason)) || e.status === 429 || e.status >= 500;
}

// options:
//   remote, local       the adapters
//   log(text)           one line for the sync report
//   progress(info)      { step: 'upload'|'download', index, count, name, sent, size }
//   shouldStop()        true to pause, even part way through an upload (a score
//                       is being opened)
//   needsToken()        true to pause before the next step that needs the
//                       sign-in (it is about to run out); upload pieces don't
//   decision            the person's answer about held deletions:
//                       { delete: Set of ids } or { keep: Set of ids }
//   now()               the time, in ms
// Resolves to { uploaded, downloaded, renamed, deleted, trashed, failed, held,
// notes, folders }: notes and folders count the scores whose markings, and
// the folders, that changed here.
// held is null, or { ids, names, folders }: deletions waiting for the
// person's say (too many at once to be sure they were meant). folders: ids of
// Music Stand folders in the Drive trash with those scores in them.
export async function syncOnce({ remote, local, log = () => {}, progress = () => {}, shouldStop = () => false, needsToken = () => false, decision = null, now = () => Date.now() }) {
  const done = { uploaded: 0, downloaded: 0, renamed: 0, deleted: 0, trashed: 0, failed: 0, held: null, notes: 0, folders: 0, zooms: 0 };
  const check = () => {
    if (shouldStop() || needsToken()) throw new SyncStopped();
  };
  const trash = async (id) => {
    try {
      await remote.update(id, { trashed: true });
      done.trashed++;
    } catch (e) {
      if (e.status !== 404) throw e; // gone already
    }
    await local.noteTrashed(id, now());
  };
  const each = async (what, fn) => {
    try {
      await fn();
      return true;
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      done.failed++;
      log(`Couldn’t ${what}: ${(e && e.message) || e}`);
      return false;
    }
  };

  const scores = await local.scores();
  let records = await local.records();
  let listing = await remote.list();
  const makePlan = () => {
    const recent = new Set([...records.trashed].filter(([, at]) => now() - at < RECENT_MS).map(([id]) => id));
    return planSync({ local: scores, links: records.links, tombs: records.tombs, uploads: records.uploads, recent, listing });
  };
  let plan = makePlan();
  for (const [id, at] of records.trashed) if (now() - at >= RECENT_MS) await local.forgetTrashed(id);

  // "Keep them": take them out of the Drive trash (the folder first), or send
  // them again if they are gone for good, then look again.
  if (decision && decision.keep) {
    const kept = plan.deleteLocal.filter((d) => decision.keep.has(d.id));
    for (const f of new Set(kept.map((d) => d.folder).filter(Boolean))) await remote.update(f, { trashed: false });
    for (const d of kept) {
      if (d.driveId) await remote.update(d.driveId, { trashed: false });
      else await local.dropLink(d.id);
    }
    if (kept.length) {
      log(`Kept ${kept.length} scores that were deleted in Google Drive.`);
      records = await local.records();
      listing = await remote.list();
      plan = makePlan();
    }
  }
  const { links, uploads } = records;
  for (const s of plan.skipped) log(`Left alone: ${s.id} (${s.why})`);

  // Missing from the listing isn't proof: Drive's listing can lag behind a
  // file uploaded a moment ago. Ask about each one directly.
  let deletions = plan.deleteLocal.filter((d) => !(decision && decision.keep && decision.keep.has(d.id)));
  const missing = deletions.filter((d) => !d.driveId && d.linked);
  if (missing.length && missing.length <= MAX_CHECKS) {
    const stillThere = new Set();
    for (const d of missing) {
      check();
      try {
        const file = await remote.get(d.linked);
        if (!file.trashed) stillThere.add(d.id);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    if (stillThere.size) log(`${stillThere.size} scores are still in Google Drive though its list doesn’t show them yet.`);
    deletions = deletions.filter((d) => !stillThere.has(d.id));
  }

  // Deletions wait for the person's say when there are many at once, or
  // when they come from a Music Stand folder in the Drive trash. The rest of
  // the sync goes on.
  const approved = (decision && decision.delete) || new Set();
  const many = needsDeleteConfirmation(deletions.length, scores.length);
  const held = deletions.filter((d) => !approved.has(d.id) && (many || d.folder));
  deletions = deletions.filter((d) => !held.includes(d));
  if (held.length) {
    done.held = { ids: held.map((d) => d.id), names: held.map((d) => d.name), folders: [...new Set(held.map((d) => d.folder).filter(Boolean))] };
    log(`Waiting for you: ${held.length} scores were deleted in Google Drive or are missing from it.`);
  }
  check();

  // Deleted here: each delete is done with once its Drive files are trashed.
  for (const t of plan.tombs) {
    check();
    let ok = true;
    for (const id of t.targets) {
      ok = (await each('move a deleted score to the Google Drive trash', () => trash(id))) && ok;
    }
    if (ok) {
      await local.dropTomb(t.id);
      await local.dropLink(t.id);
    }
  }
  for (const id of plan.trash) {
    check();
    await each('move a duplicate to the Google Drive trash', () => trash(id));
  }

  // One Music Stand folder.
  const stuck = new Set();
  for (const m of plan.moves) {
    check();
    const moved = await each('move a score into the Music Stand folder', () => remote.move(m.driveId, m.from, m.to));
    if (!moved) stuck.add(m.from);
  }
  // A spare folder is only taken out of use, never trashed: the person may
  // have put files of their own in it, which the app can't see.
  for (const f of plan.spareFolders) {
    if (stuck.has(f)) continue;
    await each('retire a spare Music Stand folder', () => remote.update(f, { name: `${FOLDER_NAME} (old)`, appProperties: { msKind: 'retired' } }));
  }

  // Scores in both places: agree on the name.
  for (const m of plan.matches) {
    check();
    await each(`sync the name of “${m.expect}”`, async () => {
      if (m.rename === 'local') {
        // Renamed here meanwhile: leave it for the next sync.
        if (!(await local.renameScore(m.id, m.name, m.expect))) return;
        done.renamed++;
      } else if (m.rename === 'remote') {
        const file = await remote.update(m.driveId, { name: driveName(m.name) });
        m.name = scoreName(file.name);
        done.renamed++;
      }
      if (!links.has(m.id) || links.get(m.id).driveId !== m.driveId || links.get(m.id).name !== m.name) {
        await local.setLink(m.id, { driveId: m.driveId, name: m.name });
      }
    });
  }

  for (const d of deletions) {
    check();
    await local.deleteScore(d.id);
    await local.dropLink(d.id);
    done.deleted++;
  }
  for (const id of plan.dropLinks) await local.dropLink(id);
  const here = new Set(scores.map((s) => s.id));
  // An upload record says Drive may have the file though the reply was lost;
  // it goes once the score is linked, or gone from here.
  const pending = new Set([...plan.upload, ...plan.deleteLocal.map((d) => d.id)]);
  for (const id of uploads.keys()) if (!here.has(id) || !pending.has(id)) await local.dropUpload(id);

  // The Music Stand folder new files go into, made once when first needed.
  let inUse = pickFolder(listing);
  const ensureFolder = async () => {
    if (!inUse) {
      inUse = await remote.createFolder(FOLDER_NAME, { msKind: 'folder' });
      log('Made the “Music Stand” folder in Google Drive.');
    }
    return inUse;
  };

  // Markings and folders go before the PDFs, which can take long or stop
  // for lack of storage. They wait while deletions are waiting for the
  // person: the Music Stand folder may be in the trash.
  const notesChanged = new Set();
  const foldersChanged = new Set();
  const dataRound = async () => {
    if (done.held) return;
    await each('sync markings and folders', async () => {
      const r = await syncData({ remote, local, log, check, ensureFolder });
      for (const id of r.notes) notesChanged.add(id);
      for (const id of r.folders) foldersChanged.add(id);
      done.notes = notesChanged.size;
      done.folders = foldersChanged.size;
      done.zooms += r.zooms || 0;
    });
  };
  if (done.held) log('Markings and folders will sync once you decide about the deleted scores.');
  await dataRound();

  if (plan.upload.length) {
    const folder = await ensureFolder();
    const byId = new Map((await local.scores()).map((s) => [s.id, s]));
    for (let i = 0; i < plan.upload.length; i++) {
      check();
      const s = byId.get(plan.upload[i]);
      if (!s) continue; // deleted meanwhile
      await each(`upload “${s.name}”`, async () => {
        const blob = await local.pdf(s.id);
        if (!blob) return;
        // A paused upload carries on only into the folder in use now, and
        // while Drive still keeps its session.
        const previous = uploads.get(s.id);
        const resume = previous && previous.folder === folder.id && now() - previous.at < SESSION_MS ? previous : null;
        let file = await remote.upload({
          name: driveName(s.name),
          mimeType: 'application/pdf',
          parents: [folder.id],
          appProperties: { msKind: 'score', msId: s.id, msHash: s.hash || '', msAdded: String(s.addedAt || 0) },
        }, blob, {
          resumeFrom: resume && resume.session,
          onSession: (session) => local.setUpload(s.id, { session, folder: folder.id, name: s.name, at: now() }),
          onProgress: (sent, size) => progress({ step: 'upload', index: i, count: plan.upload.length, name: s.name, sent, size }),
          shouldStop,
        });
        if (!file) throw new SyncStopped();
        // It may have landed in a folder that went to the trash meanwhile.
        if (file.trashed) file = await remote.update(file.id, { trashed: false });
        const away = (file.parents || []).find((p) => p !== folder.id);
        if (away) file = await remote.move(file.id, away, folder.id);
        // The name Drive has, which is older if the upload began before a rename.
        await local.setLink(s.id, { driveId: file.id, name: scoreName(file.name) });
        await local.dropUpload(s.id);
        done.uploaded++;
      });
    }
  }

  // Pieces of downloads no longer wanted.
  const fetches = [...plan.download.map((driveId) => ({ driveId, id: null })), ...plan.replace];
  const wanted = new Set(fetches.map((f) => f.driveId));
  for (const id of await local.partials()) if (!wanted.has(id)) await local.dropPartial(id);

  const byDriveId = new Map(listing.map((r) => [r.id, r]));
  // A storage refusal waits until the scores that did arrive have their
  // markings and folders.
  let refused = null;
  try {
    await fetchAll();
  } catch (e) {
    if (!(e instanceof SyncRefused)) throw e;
    refused = e;
  }
  if (done.downloaded) await dataRound();
  if (refused) throw refused;

  async function fetchAll() {
    for (let i = 0; i < fetches.length; i++) {
      check();
      const r = byDriveId.get(fetches[i].driveId);
      const into = fetches[i].id; // a new version of a score that is here
      const name = scoreName(r.name);
      const size = Number(r.size) || 0;
      if ((await local.room()) < size + STORAGE_SPARE) {
        const left = fetches.length - i;
        throw new SyncRefused(`This iPad is nearly out of storage, so ${left} ${left === 1 ? 'score wasn’t' : 'scores weren’t'} downloaded.`);
      }
      await each(`download “${name}”`, async () => {
        const blob = await downloadInPieces(r, size, (sent) => progress({ step: 'download', index: i, count: fetches.length, name, sent, size }));
        const buf = await blob.arrayBuffer();
        const hash = await sha256Hex(buf);
        const expected = hashOf(r);
        if (expected && hash !== expected) {
          await local.dropPartial(r.id);
          throw new Error('the PDF Drive sent doesn’t match the one that was uploaded');
        }
        check();
        if (into) {
          if (await local.replaceContent(into, blob, buf, hash)) done.downloaded++;
          await local.dropPartial(r.id);
          return;
        }
        // Linked first, so a score stored here is never without its link.
        const fields = { id: scoreIdOf(r), name, hash, addedAt: Number((r.appProperties || {}).msAdded) || Date.parse(r.createdTime) || now() };
        await local.setLink(fields.id, { driveId: r.id, name });
        const id = await local.addScore(blob, buf, fields);
        await local.dropPartial(r.id);
        if (id !== fields.id) {
          await local.dropLink(fields.id);
          // The same PDF was added here meanwhile, under its own name: no
          // agreed name yet, so Drive's wins.
          if (id) await local.setLink(id, { driveId: r.id, name: null });
          return;
        }
        done.downloaded++;
      });
    }
  }

  // Pieces are kept as they arrive, so a stopped download carries on later.
  async function downloadInPieces(r, size, onProgress) {
    if (!size) return remote.download(r.id);
    const parts = await local.partial(r.id);
    let got = parts.reduce((n, b) => n + b.size, 0);
    if (got > size) {
      await local.dropPartial(r.id);
      parts.length = 0;
      got = 0;
    }
    onProgress(got);
    while (got < size) {
      check();
      const piece = await remote.downloadRange(r.id, got, Math.min(size, got + DOWNLOAD_PIECE) - 1);
      if (piece.whole) {
        // Drive sent the whole file instead of the piece asked for.
        await local.dropPartial(r.id);
        return new Blob([piece.bytes], { type: 'application/pdf' });
      }
      if (!piece.bytes.length) throw new Error('Google Drive sent an empty piece');
      const blob = new Blob([piece.bytes]);
      await local.savePart(r.id, parts.length, blob);
      parts.push(blob);
      got += blob.size;
      onProgress(got);
    }
    return new Blob(parts, { type: 'application/pdf' });
  }

  await local.setState({ lastSync: now() });
  return done;
}
