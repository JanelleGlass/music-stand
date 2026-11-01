// Run with: node --test tests/*.test.mjs
// Whole sync runs between fake devices that share one fake Google Drive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncOnce, SyncRefused, SyncStopped } from '../js/sync-engine.js';
import { FakeDrive } from './fake-drive.mjs';
import { FakeDevice } from './fake-device.mjs';

function setup(...names) {
  const drive = new FakeDrive();
  const clock = { now: 1_700_000_000_000 };
  const devices = names.map((n) => new FakeDevice(n, clock));
  return { drive, devices };
}

function sync(drive, device, opts = {}) {
  const lines = [];
  return syncOnce({ remote: drive, local: device, log: (t) => lines.push(t), now: () => device.now(), ...opts })
    .then((r) => Object.assign(r, { lines }));
}

const liveNames = (drive) => drive.live().map((m) => m.name).sort();

test('a score added on one iPad reaches the other', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'grace-pdf');
  assert.equal((await sync(drive, a)).uploaded, 1);
  assert.deepEqual(liveNames(drive), ['Grace.pdf']);
  assert.equal((await sync(drive, b)).downloaded, 1);
  assert.deepEqual(b.names(), ['Grace']);
  assert.equal(b.byName('Grace').id, a.byName('Grace').id);
  // Nothing more to do on either side.
  const again = await sync(drive, a);
  assert.deepEqual([again.uploaded, again.downloaded, again.renamed, again.trashed], [0, 0, 0, 0]);
});

test('the Music Stand folder is made once and new scores go in it', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'g');
  await sync(drive, a);
  b.add('Vision', 'v');
  await sync(drive, b);
  const folders = drive.live('folder');
  assert.equal(folders.length, 1);
  assert.ok(drive.live().every((m) => m.parents[0] === folders[0].id));
});

test('renames travel both ways, and a rename in Drive on the web comes in too', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  await sync(drive, b);
  a.rename(id, 'Amazing Grace');
  await sync(drive, a);
  assert.deepEqual(liveNames(drive), ['Amazing Grace.pdf']);
  await sync(drive, b);
  assert.deepEqual(b.names(), ['Amazing Grace']);
  drive.webRename(drive.live()[0].id, 'Grace (hymn).pdf');
  await sync(drive, a);
  assert.deepEqual(a.names(), ['Grace (hymn)']);
});

test('two renames of one score before either syncs: the first to sync wins on both', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  await sync(drive, b);
  a.rename(id, 'From A');
  b.rename(id, 'From B');
  await sync(drive, a);
  await sync(drive, b);
  await sync(drive, a);
  assert.deepEqual(a.names(), ['From A']);
  assert.deepEqual(b.names(), ['From A']);
  assert.deepEqual(liveNames(drive), ['From A.pdf']);
});

test('deleting on one iPad deletes on the other and puts the PDF in the Drive trash', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  a.add('Vision', 'v');
  a.add('Joy', 'j');
  await sync(drive, a);
  await sync(drive, b);
  a.delete(id);
  const r = await sync(drive, a);
  assert.equal(r.trashed, 1);
  assert.deepEqual(liveNames(drive), ['Joy.pdf', 'Vision.pdf']);
  assert.equal((await sync(drive, b)).deleted, 1);
  assert.deepEqual(b.names(), ['Joy', 'Vision']);
});

test('the same PDF added separately on two iPads ends up as one score, with Drive’s name', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'same-bytes');
  const bid = b.add('Grace hymn', 'same-bytes');
  await sync(drive, a);
  await sync(drive, b);
  assert.equal(drive.live().length, 1);
  assert.equal(b.files.size, 1);
  assert.deepEqual(b.names(), ['Grace']);
  assert.equal(b.kv.get(`sync:link:${bid}`).driveId, drive.live()[0].id);
  assert.ok(b.positions.has(bid)); // its own id, so its reading place stays
});

test('two iPads uploading the same PDF at once: the duplicate is cleaned up', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const aid = a.add('Grace', 'same');
  const bid = b.add('Grace', 'same');
  // Both list Drive before either uploads.
  const before = await drive.list();
  const realList = drive.list.bind(drive);
  drive.list = async () => before;
  await sync(drive, a);
  await sync(drive, b);
  drive.list = realList;
  assert.equal(drive.live().length, 2);
  await sync(drive, a);
  await sync(drive, b);
  await sync(drive, a);
  assert.equal(drive.live().length, 1);
  assert.equal(a.files.size, 1);
  assert.equal(b.files.size, 1);
  assert.equal(a.kv.get(`sync:link:${aid}`).driveId, drive.live()[0].id);
  assert.equal(b.kv.get(`sync:link:${bid}`).driveId, drive.live()[0].id);
});

test('deleting a score and adding the same PDF again keeps it', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  await sync(drive, b);
  a.delete(id);
  a.add('Grace again', 'g');
  await sync(drive, a);
  await sync(drive, b);
  assert.equal(drive.live().length, 1);
  assert.equal(b.files.size, 1);
  assert.equal(a.files.size, 1);
});

test('deleting a score that was never synced from a connected iPad deletes the other copy too', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'g');
  await sync(drive, a);
  const id = b.add('Grace', 'g'); // B has its own copy, not synced yet
  b.delete(id);
  await sync(drive, b);
  assert.equal(drive.live().length, 0);
  await sync(drive, a);
  assert.equal(a.files.size, 0);
});

test('putting the Music Stand folder in the Drive trash holds the deletions for the person to decide', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  for (const n of ['1', '2', '3', '4']) a.add(n, n);
  await sync(drive, a);
  await sync(drive, b);
  const folder = drive.live('folder')[0];
  drive.webTrash(folder.id);
  b.add('5', '5'); // the rest of the sync still happens
  const r = await sync(drive, b);
  assert.equal(r.deleted, 0);
  assert.deepEqual(r.held.names.sort(), ['1', '2', '3', '4']);
  assert.deepEqual(r.held.folders, [folder.id]);
  assert.equal(r.uploaded, 1);
  assert.equal(b.files.size, 5);
  // Restoring the folder brings everything back, with nothing to ask.
  await drive.update(folder.id, { trashed: false });
  const again = await sync(drive, b);
  assert.equal(again.held, null);
  assert.equal(b.files.size, 5);
  assert.equal((await sync(drive, a)).downloaded, 1);
});

test('keeping held deletions sends the scores back to Drive; other iPads keep them too', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  for (const n of ['1', '2', '3', '4']) a.add(n, n);
  await sync(drive, a);
  await sync(drive, b);
  drive.webTrash(drive.live('folder')[0].id);
  const r = await sync(drive, b);
  for (const id of r.held.ids) await b.dropLink(id); // what "Keep them" does
  const kept = await sync(drive, b);
  assert.equal(kept.uploaded, 4);
  assert.equal(drive.live().length, 4);
  assert.equal(drive.live('folder').length, 1);
  const ra = await sync(drive, a);
  assert.equal(ra.held, null);
  assert.equal(ra.deleted, 0);
  assert.equal(a.files.size, 4);
});

test('agreeing to held deletions deletes them here', async () => {
  const { drive, devices: [a] } = setup('A');
  for (const n of ['1', '2', '3']) a.add(n, n);
  await sync(drive, a);
  for (const m of drive.live()) drive.webTrash(m.id);
  const r = await sync(drive, a);
  assert.equal(r.held.ids.length, 3);
  const r2 = await sync(drive, a, { decision: { delete: new Set(r.held.ids) } });
  assert.equal(r2.deleted, 3);
  assert.equal(r2.held, null);
  assert.equal(a.files.size, 0);
});

test('keeping scores trashed in Drive takes them out of the trash instead of uploading again', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  for (const n of ['1', '2', '3']) a.add(n, n);
  await sync(drive, a);
  await sync(drive, b);
  for (const m of drive.live()) drive.webTrash(m.id);
  const r = await sync(drive, b);
  const kept = await sync(drive, b, { decision: { keep: new Set(r.held.ids) } });
  assert.equal(kept.uploaded, 0);
  assert.equal(kept.held, null);
  assert.equal(drive.live().length, 3);
  assert.equal((await sync(drive, a)).held, null);
  assert.equal(a.files.size, 3);
});

test('one or two deletions elsewhere happen without asking', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  for (const n of ['1', '2', '3', '4', '5']) a.add(n, n);
  await sync(drive, a);
  await sync(drive, b);
  a.delete(a.byName('1').id);
  a.delete(a.byName('2').id);
  await sync(drive, a);
  const r = await sync(drive, b);
  assert.equal(r.held, null);
  assert.equal(r.deleted, 2);
});

test('a score deleted from Drive for good (trash emptied) is deleted here, not sent back', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  for (const n of ['1', '2', '3', '4']) a.add(n, n);
  await sync(drive, a);
  await sync(drive, b);
  drive.webPurge(drive.live().find((m) => m.name === '1.pdf').id);
  const r = await sync(drive, b);
  assert.equal(r.deleted, 1);
  assert.equal(r.uploaded, 0);
  assert.deepEqual(b.names(), ['2', '3', '4']);
});

test('most scores missing from Drive altogether wait for the person; keeping sends them again', async () => {
  const { drive, devices: [a] } = setup('A');
  for (const n of ['1', '2', '3', '4']) a.add(n, n);
  await sync(drive, a);
  for (const m of drive.live()) drive.webPurge(m.id);
  const r = await sync(drive, a);
  assert.equal(r.held.ids.length, 4);
  assert.equal(a.files.size, 4);
  const kept = await sync(drive, a, { decision: { keep: new Set(r.held.ids) } });
  assert.equal(kept.uploaded, 4);
  assert.equal(drive.live().length, 4);
});

test('a download stopped part way carries on from the pieces it has', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Hymnal', 'x'.repeat(20 * 1024 * 1024)); // three 8 MiB pieces
  await sync(drive, a);
  let ranges = 0;
  const real = drive.downloadRange.bind(drive);
  drive.downloadRange = async (...args) => { ranges++; return real(...args); };
  await assert.rejects(sync(drive, b, { shouldStop: () => ranges >= 2 }), SyncStopped);
  assert.equal(b.files.size, 0);
  assert.equal((await b.partial(drive.live()[0].id)).length, 2);
  ranges = 0;
  const r = await sync(drive, b);
  assert.equal(r.downloaded, 1);
  assert.equal(ranges, 1); // only the last piece
  assert.equal(b.parts.size, 0);
  assert.equal(b.files.values().next().value.hash, a.files.values().next().value.hash);
});

test('a nearly full iPad stops downloading with a message', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'g');
  await sync(drive, a);
  b.free = 100 * 1024 * 1024;
  await assert.rejects(sync(drive, b), /nearly out of storage/);
  assert.equal(b.files.size, 0);
});

test('a lost reply after Drive made the file does not make a duplicate', async () => {
  const { drive, devices: [a] } = setup('A');
  a.add('Grace', 'g');
  drive.failNext('upload', Object.assign(new TypeError('Load failed')), { after: true });
  await assert.rejects(sync(drive, a), TypeError);
  await sync(drive, a);
  assert.equal(drive.live().length, 1);
  assert.equal(a.kv.has(`sync:link:${a.byName('Grace').id}`), true);
});

test('opening a score pauses the sync; the next sync finishes the job', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  for (const n of ['1', '2', '3']) a.add(n, n);
  await sync(drive, a);
  let calls = 0;
  await assert.rejects(sync(drive, b, { shouldStop: () => ++calls > 4 }), SyncStopped);
  assert.ok(b.files.size < 3);
  await sync(drive, b);
  assert.equal(b.files.size, 3);
});

test('a backup Replace on a synced iPad gets the Drive scores back', async () => {
  const { drive, devices: [a] } = setup('A');
  a.add('Grace', 'g');
  await sync(drive, a);
  a.files.clear();
  a.blobs.clear(); // Replace import keeps kv (and so the links)
  const r = await sync(drive, a);
  assert.equal(r.downloaded, 1);
  assert.deepEqual(a.names(), ['Grace']);
});

test('a damaged download is skipped and the rest carry on', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'g');
  a.add('Vision', 'v');
  await sync(drive, a);
  const first = drive.live()[0];
  drive.files.get(first.id).bytes = new TextEncoder().encode('tampered');
  const r = await sync(drive, b);
  assert.equal(r.failed, 1);
  assert.equal(r.downloaded, 1);
});

test('an old delete doesn’t trash the same PDF when it is added again later on another iPad', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  await sync(drive, b);
  a.delete(id);
  // A's sync trashes Grace but the reply is lost, so A still has its delete.
  drive.failNext('update', new TypeError('Load failed'), { after: true });
  await assert.rejects(sync(drive, a), TypeError);
  await sync(drive, b); // B deletes Grace
  assert.equal(b.files.size, 0);
  drive.clock += 60 * 60 * 1000;
  b.add('Grace', 'g'); // added back on B an hour later
  await sync(drive, b);
  await sync(drive, a); // A's leftover delete must not take it
  await sync(drive, b);
  assert.equal(drive.live().length, 1);
  assert.equal(b.files.size, 1);
  assert.equal(a.files.size, 1);
  assert.equal(a.kv.has(`sync:tomb:${id}`), false);
});

test('a new version of a PDF uploaded in Drive reaches the iPads', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'first scan');
  await sync(drive, a);
  await sync(drive, b);
  drive.webNewVersion(drive.live()[0].id, 'better scan');
  assert.equal((await sync(drive, a)).downloaded, 1);
  await sync(drive, b);
  const want = drive.live()[0].sha256Checksum;
  assert.equal(a.files.get(id).hash, want);
  assert.equal(b.files.get(id).hash, want);
  assert.equal(new TextDecoder().decode(a.blobs.get(id)), 'better scan');
});

test('two Music Stand folders are merged into one', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'g');
  b.add('Vision', 'v');
  // Both connect at once: neither sees the other's folder.
  const empty = await drive.list();
  const realList = drive.list.bind(drive);
  drive.list = async () => empty;
  await sync(drive, a);
  await sync(drive, b);
  drive.list = realList;
  assert.equal(drive.live('folder').length, 2);
  await sync(drive, a);
  const inUse = drive.live('folder').sort((x, y) => (x.createdTime < y.createdTime ? -1 : 1))[0];
  assert.ok(drive.live().every((m) => m.parents.includes(inUse.id)));
  assert.equal(drive.live().length, 2);
  await sync(drive, b);
  assert.deepEqual(a.names(), ['Grace', 'Vision']);
  assert.deepEqual(b.names(), ['Grace', 'Vision']);
  // The emptied spare folder is taken out of use, not trashed: the person may
  // have put their own files in it.
  assert.deepEqual(drive.live('folder').map((f) => f.id), [inUse.id]);
  const spare = [...drive.files.values()].map((f) => f.meta).find((m) => m.mimeType === 'application/vnd.google-apps.folder' && m.id !== inUse.id);
  assert.equal(spare.trashed, false);
  assert.equal(spare.name, 'Music Stand (old)');
});

test('a paused upload whose folder went to the trash starts again in the new folder', async () => {
  const { drive, devices: [a] } = setup('A');
  a.add('Grace', 'g');
  await sync(drive, a);
  a.add('Requiem', 'r'.repeat(3 * 256 * 1024));
  let pieces = 0;
  await assert.rejects(sync(drive, a, { progress: () => { pieces++; }, shouldStop: () => pieces >= 1 }), SyncStopped);
  drive.webTrash(drive.live('folder')[0].id);
  const r = await sync(drive, a);
  assert.equal(r.uploaded, 1);
  const req = drive.live().find((m) => m.name === 'Requiem.pdf');
  assert.ok(req && !req.trashed);
  await sync(drive, a);
  assert.ok(a.byName('Requiem'));
});

test('a download that finds the same PDF just added here links it instead of adding a second copy', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'g');
  await sync(drive, a);
  // B adds the same PDF while its download is under way.
  const real = drive.downloadRange.bind(drive);
  let bid;
  drive.downloadRange = async (...args) => { bid = b.add('Grace', 'g'); return real(...args); };
  await sync(drive, b);
  drive.downloadRange = real;
  assert.equal(b.files.size, 1);
  assert.equal(b.kv.get(`sync:link:${bid}`).driveId, drive.live()[0].id);
});

test('after a backup Replace (links forgotten), the restore wins and Drive’s names are used', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  a.add('Vision', 'v');
  await sync(drive, a);
  await sync(drive, b);
  b.delete(b.byName('Vision').id);
  b.rename(id, 'Amazing Grace');
  await sync(drive, b);
  // A restores an old backup with Replace: same scores, old names, no links.
  for (const k of [...a.kv.keys()]) if (k.startsWith('sync:link:')) a.kv.delete(k);
  await sync(drive, a);
  assert.deepEqual(a.names(), ['Amazing Grace', 'Vision']);
  assert.deepEqual(liveNames(drive), ['Amazing Grace.pdf', 'Vision.pdf']);
});

test('an upload that finishes in a Music Stand folder another iPad trashed is moved out, not lost', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'g');
  await sync(drive, a);
  const keep = drive.live('folder')[0];
  // B made its own folder (it couldn't see A's yet) and is part way through a hymnal.
  const spare = await drive.createFolder('Music Stand', { msKind: 'folder' });
  b.add('Hymnal', 'h'.repeat(3 * 256 * 1024));
  const list = drive.list.bind(drive);
  drive.list = async () => (await list()).filter((m) => m.id !== keep.id && m.appProperties.msKind !== 'score');
  let pieces = 0;
  await assert.rejects(sync(drive, b, { progress: () => { pieces++; }, shouldStop: () => pieces >= 1 }), SyncStopped);
  drive.list = list;
  drive.webTrash(spare.id); // say someone tidied it away meanwhile
  // B's upload carries on only into the folder in use now, so it starts again there.
  await sync(drive, b);
  const hymnal = drive.live().find((m) => m.name === 'Hymnal.pdf');
  assert.ok(hymnal);
  assert.deepEqual(hymnal.parents, [keep.id]);
  await sync(drive, a);
  assert.deepEqual(a.names(), ['Grace', 'Hymnal']);
});

test('a live score inside a trashed Music Stand folder is moved into the folder in use', async () => {
  const { drive, devices: [a] } = setup('A');
  a.add('Grace', 'g');
  await sync(drive, a);
  const keep = drive.live('folder')[0];
  const spare = await drive.createFolder('Music Stand', { msKind: 'folder' });
  drive.webTrash(spare.id);
  // A file created inside it after it went to the trash (an upload in flight).
  const late = await drive.upload({ name: 'Late.pdf', parents: [spare.id], appProperties: { msKind: 'score', msId: 'late-id' } }, new Blob(['late']));
  await sync(drive, a);
  assert.deepEqual(drive.files.get(late.id).meta.parents, [keep.id]);
  assert.ok(a.byName('Late'));
});

test('a score Drive’s list doesn’t show yet (just uploaded) isn’t taken for deleted', async () => {
  const { drive, devices: [a] } = setup('A');
  a.add('Grace', 'g');
  a.add('Vision', 'v');
  await sync(drive, a);
  const grace = drive.live().find((m) => m.name === 'Grace.pdf');
  const list = drive.list.bind(drive);
  drive.list = async () => (await list()).filter((m) => m.id !== grace.id); // the listing lags
  const r = await sync(drive, a);
  drive.list = list;
  assert.equal(r.deleted, 0);
  assert.equal(r.held, null);
  assert.deepEqual(a.names(), ['Grace', 'Vision']);
});

test('a score this iPad just trashed isn’t downloaded again while Drive’s list catches up', async () => {
  const { drive, devices: [a] } = setup('A');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  const before = await drive.list(); // still shows Grace live
  a.delete(id);
  await sync(drive, a);
  const list = drive.list.bind(drive);
  drive.list = async () => before;
  const r = await sync(drive, a);
  drive.list = list;
  assert.equal(r.downloaded, 0);
  assert.equal(a.files.size, 0);
});

test('a score whose upload reply was lost, then deleted on another iPad, is deleted here too', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  b.add('Mistake', 'm');
  drive.failNext('upload', new TypeError('Load failed'), { after: true });
  await assert.rejects(sync(drive, b), TypeError);
  await sync(drive, a);
  a.delete(a.byName('Mistake').id);
  await sync(drive, a);
  const r = await sync(drive, b);
  assert.equal(r.uploaded, 0);
  assert.equal(r.deleted, 1);
  assert.equal(drive.live().length, 0);
  assert.equal((await sync(drive, a)).downloaded, 0);
});

test('one score put in the trash with its Music Stand folder waits for the person', async () => {
  const { drive, devices: [a] } = setup('A');
  for (const n of ['1', '2', '3', '4', '5']) a.add(n, n);
  await sync(drive, a);
  // A second, older-looking folder holds just one score, and goes to the trash.
  const other = drive.live().find((m) => m.name === '1.pdf');
  const extra = await drive.createFolder('Music Stand', { msKind: 'folder' });
  await drive.move(other.id, other.parents[0], extra.id);
  drive.webTrash(extra.id);
  const r = await sync(drive, a);
  assert.equal(r.deleted, 0);
  assert.deepEqual(r.held.names, ['1']);
});

test('a Keep that stops part way is finished by the next run with the same answer', async () => {
  const { drive, devices: [a] } = setup('A');
  for (const n of ['1', '2', '3', '4', '5', '6']) a.add(n, n);
  await sync(drive, a);
  for (const m of drive.live()) drive.webTrash(m.id);
  const r = await sync(drive, a);
  const decision = { keep: new Set(r.held.ids) };
  let updates = 0;
  const update = drive.update.bind(drive);
  drive.update = async (...args) => { if (++updates === 3) throw new TypeError('Load failed'); return update(...args); };
  await assert.rejects(sync(drive, a, { decision }), TypeError);
  drive.update = update;
  const again = await sync(drive, a, { decision });
  assert.equal(again.deleted, 0);
  assert.equal(a.files.size, 6);
  assert.equal(drive.live().length, 6);
});

test('a file Drive won’t hand over (403) fails on its own; the other downloads go on', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'g');
  a.add('Vision', 'v');
  await sync(drive, a);
  const range = drive.downloadRange.bind(drive);
  let first = true;
  drive.downloadRange = async (...args) => {
    if (first) { first = false; throw Object.assign(new Error('flagged'), { status: 403, reason: 'cannotDownloadAbusiveFile' }); }
    return range(...args);
  };
  const r = await sync(drive, b);
  assert.equal(r.failed, 1);
  assert.equal(r.downloaded, 1);
});

test('the same PDF added here while it downloads keeps one copy, with Drive’s name', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  a.add('Grace', 'g');
  await sync(drive, a);
  b.beforeStore = async () => { b.beforeStore = null; b.add('My scan', 'g'); };
  await sync(drive, b);
  assert.equal(b.files.size, 1);
  await sync(drive, b);
  assert.deepEqual(b.names(), ['Grace']);
  assert.deepEqual(liveNames(drive), ['Grace.pdf']);
});

test('a score restored from a backup isn’t deleted again when its upload is interrupted', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g'.repeat(3 * 256 * 1024));
  await sync(drive, a);
  await sync(drive, b);
  b.delete(b.byName('Grace').id);
  await sync(drive, b);
  await sync(drive, a); // A deletes Grace too
  assert.equal(a.files.size, 0);
  drive.clock += 60 * 60 * 1000;
  a.clock.now += 60 * 60 * 1000;
  // A restores a backup with Replace: Grace is back, with no sync records.
  a.files.set(id, { id, name: 'Grace', addedAt: 1 });
  const bytes = new TextEncoder().encode('g'.repeat(3 * 256 * 1024));
  a.blobs.set(id, bytes);
  a.files.get(id).hash = (await import('./sha256.mjs')).sha256Hex(bytes);
  let pieces = 0;
  await assert.rejects(sync(drive, a, { progress: () => { pieces++; }, shouldStop: () => pieces >= 1 }), SyncStopped);
  const r = await sync(drive, a);
  assert.equal(r.deleted, 0);
  assert.equal(r.uploaded, 1);
  assert.ok(a.byName('Grace'));
});

test('adding a PDF back just after deleting it keeps it, while Drive’s list lags', async () => {
  const { drive, devices: [a] } = setup('A');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  const before = await drive.list(); // still shows Grace live
  a.delete(id);
  await sync(drive, a);
  a.add('Grace again', 'g');
  const list = drive.list.bind(drive);
  drive.list = async () => before;
  await sync(drive, a);
  drive.list = list;
  const r = await sync(drive, a);
  assert.equal(r.deleted, 0);
  assert.ok(a.byName('Grace again'));
  assert.equal(drive.live().length, 1);
});

test('deleting a score right after it uploads still deletes it, while Drive’s list lags', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const before = await drive.list(); // Drive's list before the upload shows up
  const id = a.add('Mistake', 'm');
  await sync(drive, a);
  a.delete(id);
  const list = drive.list.bind(drive);
  drive.list = async () => before;
  await sync(drive, a);
  drive.list = list;
  assert.equal(drive.live().length, 0);
  assert.equal((await sync(drive, a)).downloaded, 0);
  assert.equal((await sync(drive, b)).downloaded, 0);
});

test('a rename made after an upload whose reply was lost is kept', async () => {
  const { drive, devices: [a] } = setup('A');
  const id = a.add('Scan 001', 's');
  drive.failNext('upload', new TypeError('Load failed'), { after: true });
  await assert.rejects(sync(drive, a), TypeError);
  a.rename(id, 'Grace');
  await sync(drive, a);
  assert.deepEqual(a.names(), ['Grace']);
  assert.deepEqual(liveNames(drive), ['Grace.pdf']);
});

test('a file listed twice (pages shifting while read) isn’t taken for its own duplicate', async () => {
  const { drive, devices: [a] } = setup('A');
  a.add('Grace', 'g');
  await sync(drive, a);
  const list = drive.list.bind(drive);
  drive.list = async () => { const all = await list(); return [...all, ...all.filter((m) => m.appProperties.msKind === 'score')]; };
  const r = await sync(drive, a);
  drive.list = list;
  assert.equal(r.trashed, 0);
  assert.equal(drive.live().length, 1);
});

test('a score that lands in a retired spare folder is moved out, and trashing that folder asks first', async () => {
  const { drive, devices: [a] } = setup('A');
  for (const n of ['1', '2', '3', '4', '5']) a.add(n, n);
  await sync(drive, a);
  const keep = drive.live('folder')[0];
  const spare = await drive.createFolder('Music Stand', { msKind: 'folder' });
  await sync(drive, a); // retires the empty spare
  assert.equal(drive.files.get(spare.id).meta.appProperties.msKind, 'retired');
  // An upload from another iPad that was already heading there lands in it.
  const late = await drive.upload({ name: 'Late.pdf', parents: [spare.id], appProperties: { msKind: 'score', msId: 'late-id' } }, new Blob(['late']));
  await sync(drive, a);
  assert.deepEqual(drive.files.get(late.id).meta.parents, [keep.id]);
  // Another one lands there and the person trashes the old folder.
  const late2 = await drive.upload({ name: 'Late 2.pdf', parents: [spare.id], appProperties: { msKind: 'score', msId: 'late-2' } }, new Blob(['late 2']));
  await sync(drive, a);
  assert.ok(a.byName('Late 2'));
  await drive.move(late2.id, keep.id, spare.id);
  drive.webTrash(spare.id);
  const r = await sync(drive, a);
  assert.equal(r.deleted, 0);
  assert.deepEqual(r.held.names, ['Late 2']);
});
