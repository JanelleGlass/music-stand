// Run with: node --test tests/*.test.mjs
// Markings, favorites and folders travelling between fake devices through
// one fake Google Drive, in whole sync runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncOnce, SyncRefused } from '../js/sync-engine.js';
import { dataPending } from '../js/sync-data.js';
import { restampFolder } from '../js/notes-merge.js';
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

const dataFiles = (drive) => drive.live('data');

test('markings travel both ways, and both devices’ strokes are kept', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'grace-pdf');
  await sync(drive, a);
  await sync(drive, b);
  const s1 = a.draw(id, 1);
  await sync(drive, a);
  assert.equal(dataFiles(drive).length, 1);
  assert.equal((await sync(drive, b)).notes, 1);
  assert.deepEqual(b.marks(id, 1), [s1]);
  // Both write before syncing again.
  const s2 = a.draw(id, 1);
  const s3 = b.draw(id, 2);
  await sync(drive, a);
  await sync(drive, b);
  await sync(drive, a);
  assert.deepEqual(a.marks(id, 1), [s1, s2].sort());
  assert.deepEqual(a.marks(id, 2), [s3]);
  assert.deepEqual(b.marks(id, 1), [s1, s2].sort());
});

test('an erased stroke goes on the other device too', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  const s1 = a.draw(id, 1);
  const s2 = a.draw(id, 1);
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(b.marks(id, 1), [s1, s2].sort());
  b.erase(id, 1, s1);
  await sync(drive, b);
  await sync(drive, a);
  assert.deepEqual(a.marks(id, 1), [s2]);
});

test('the same PDF added separately on each device shares its markings and folders', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const ida = a.add('Grace', 'same-pdf');
  const idb = b.add('Amazing Grace', 'same-pdf');
  assert.notEqual(ida, idb);
  const s = a.draw(ida, 3);
  const folder = a.makeFolder('Sunday');
  a.setMember(folder, ida, true);
  a.setMember('favorites', ida, true);
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(b.marks(idb, 3), [s]);
  assert.equal(b.folderNames(folder).length, 1);
  assert.equal(b.folderNames('favorites').length, 1);
  assert.equal(b.lists.get(folder).name, 'Sunday');
});

test('a score that arrives in the same run gets its markings and folders', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  a.draw(id, 1);
  a.setMember('favorites', id, true);
  await sync(drive, a);
  const r = await sync(drive, b); // downloads Grace, then its markings
  assert.equal(r.downloaded, 1);
  assert.equal(b.marks(id, 1).length, 1);
  assert.deepEqual(b.folderNames('favorites'), ['Grace']);
  // And nothing more to do after.
  const before = drive.calls.length;
  const again = await sync(drive, b);
  assert.deepEqual([again.notes, again.folders], [0, 0]);
  assert.deepEqual(drive.calls.slice(before), ['list', 'listData']);
});

test('a score that arrives in a later run still gets its folder (nothing was edited meanwhile)', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  a.setMember('favorites', id, true);
  await sync(drive, a);
  // B's download fails this time, but the data file is read.
  b.failNext('addScore', new Error('damaged'));
  const r1 = await sync(drive, b);
  assert.equal(r1.failed, 1);
  assert.deepEqual(b.folderNames('favorites'), []);
  await sync(drive, b);
  assert.deepEqual(b.folderNames('favorites'), ['Grace']);
});

test('nothing changed: the data file isn’t downloaded or written', async () => {
  const { drive, devices: [a] } = setup('A');
  const id = a.add('Grace', 'g');
  a.draw(id, 1);
  await sync(drive, a);
  const before = drive.calls.length;
  await sync(drive, a);
  const calls = drive.calls.slice(before);
  assert.ok(calls.includes('listData'));
  assert.ok(!calls.some((c) => c.startsWith('readData') || c.startsWith('writeData') || c === 'createData'));
});

test('folders: renames travel, the newer change wins, and a delete reaches the other device', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  const f = a.makeFolder('Christmas');
  a.setMember(f, id, true);
  await sync(drive, a);
  await sync(drive, b);
  b.renameFolder(f, 'Advent');
  await sync(drive, b);
  await sync(drive, a);
  assert.equal(a.lists.get(f).name, 'Advent');
  // A takes the score out, B puts... nothing: A's change arrives.
  a.setMember(f, id, false);
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(b.folderNames(f), []);
  b.deleteFolder(f);
  await sync(drive, b);
  await sync(drive, a);
  assert.equal(a.folderNames(f), null);
});

test('a folder deleted by mistake comes back with a restored backup', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  const f = a.makeFolder('Wedding');
  a.setMember(f, id, true);
  await sync(drive, a);
  await sync(drive, b);
  const backup = structuredClone(a.lists.get(f));
  a.deleteFolder(f);
  await sync(drive, a);
  await sync(drive, b);
  assert.equal(b.folderNames(f), null);
  // Replace import: the backup's folder, stamped as just restored.
  a.lists.set(f, restampFolder(backup, a.now()));
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(b.folderNames(f), ['Grace']);
});

test('strokes erased since a backup come back when it is restored with Replace', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  a.draw(id, 1);
  a.draw(id, 1);
  await sync(drive, a);
  await sync(drive, b);
  const backup = structuredClone(a.annotations.get(`${id}:1`));
  for (const s of a.marks(id, 1)) a.erase(id, 1, s); // Clear page, by mistake
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(b.marks(id, 1), []);
  // Replace import puts the backup's page back and marks the score restored.
  a.annotations.set(`${id}:1`, backup);
  a.kv.set('sync:restore', { hashes: [a.files.get(id).hash], at: a.now() });
  await sync(drive, a);
  await sync(drive, b);
  assert.equal(a.marks(id, 1).length, 2);
  assert.equal(b.marks(id, 1).length, 2);
  assert.equal(a.kv.get('sync:restore'), undefined);
  // Only once: erasing again sticks.
  for (const s of a.marks(id, 1)) a.erase(id, 1, s);
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(b.marks(id, 1), []);
});

test('a score deleted in Drive and restored from its trash gets its markings and folders back', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  const s = a.draw(id, 1);
  a.setMember('favorites', id, true);
  await sync(drive, a);
  await sync(drive, b);
  const file = drive.live()[0];
  drive.webTrash(file.id);
  await sync(drive, a);
  await sync(drive, b);
  assert.equal(a.files.size, 0);
  assert.equal(b.files.size, 0);
  drive.webRestore(file.id);
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(a.marks(id, 1), [s]);
  assert.deepEqual(b.folderNames('favorites'), ['Grace']);
});

test('two devices that each made a data file end up with one, holding everything', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  await sync(drive, b);
  const sa = a.draw(id, 1);
  const sb = b.draw(id, 1);
  // B's listing lags and doesn't show A's new data file yet.
  await sync(drive, a);
  const listData = drive.listData.bind(drive);
  drive.listData = async () => [];
  await sync(drive, b);
  drive.listData = listData;
  assert.equal(dataFiles(drive).length, 2);
  await sync(drive, a);
  assert.equal(dataFiles(drive).length, 1);
  await sync(drive, b);
  assert.deepEqual(a.marks(id, 1), [sa, sb].sort());
  assert.deepEqual(b.marks(id, 1), [sa, sb].sort());
});

test('an upload of the data file whose reply was lost is finished by the next run', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  const s = a.draw(id, 1);
  drive.failNext('createData', new TypeError('Load failed'), { after: true });
  await assert.rejects(sync(drive, a), TypeError);
  await sync(drive, a);
  assert.equal(dataFiles(drive).length, 1);
  await sync(drive, b);
  assert.deepEqual(b.marks(id, 1), [s]);
});

test('markings still sync when the iPad is too full for a new PDF', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  await sync(drive, b);
  a.add('Hymnal', 'h'.repeat(1000));
  const s = a.draw(id, 1);
  await sync(drive, a);
  b.free = 0;
  await assert.rejects(sync(drive, b), SyncRefused);
  assert.deepEqual(b.marks(id, 1), [s]);
});

test('markings and folders wait while deletions wait for the person', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  for (let i = 0; i < 8; i++) a.add(`Score ${i}`, `s${i}`);
  const id = a.byName('Score 0').id;
  a.setMember('favorites', id, true);
  await sync(drive, a);
  await sync(drive, b);
  drive.webTrash(drive.live('folder')[0].id); // the whole Music Stand folder
  b.draw(id, 1);
  const r = await sync(drive, b);
  assert.ok(r.held);
  assert.ok(r.lines.some((l) => l.includes('Markings and folders will sync once you decide')));
  assert.equal(dataFiles(drive).length, 0); // not recreated outside the trashed folder
  assert.equal(drive.live('folder').length, 0);
});

test('a data file from a newer version of the app is left alone', async () => {
  const { drive, devices: [a] } = setup('A');
  const id = a.add('Grace', 'g');
  a.draw(id, 1);
  await sync(drive, a);
  const file = dataFiles(drive)[0];
  const newer = JSON.stringify({ app: 'music-stand', kind: 'data', v: 2, notes: {}, folders: [], setlists: [1] });
  drive.webWriteData(file.id, newer);
  a.draw(id, 2);
  const r = await sync(drive, a);
  assert.ok(r.lines.some((l) => l.includes('newer version of Music Stand')));
  assert.equal(JSON.stringify(drive.data()), newer);
});

test('an unreadable data file is set aside and rebuilt from the devices', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  const s = a.draw(id, 1);
  await sync(drive, a);
  await sync(drive, b);
  drive.webWriteData(dataFiles(drive)[0].id, '{ not json');
  await sync(drive, b);
  assert.equal(drive.live('data-bad').length, 1);
  assert.deepEqual(drive.data().notes[a.files.get(id).hash][1].strokes.map((x) => x.id), [s]);
});

test('restoring the same backup twice, or on two devices, doesn’t double the strokes', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  a.draw(id, 1);
  a.draw(id, 1);
  await sync(drive, a);
  await sync(drive, b);
  const backup = structuredClone(a.annotations.get(`${id}:1`));
  for (const s of a.marks(id, 1)) a.erase(id, 1, s);
  await sync(drive, a);
  await sync(drive, b);
  const restore = (d) => {
    d.annotations.set(`${id}:1`, structuredClone(backup));
    d.kv.set('sync:restore', { hashes: [d.files.get(id).hash], at: d.now() });
  };
  restore(a);
  restore(b); // both before either syncs
  await sync(drive, a);
  await sync(drive, b);
  await sync(drive, a);
  assert.equal(a.marks(id, 1).length, 2);
  assert.equal(b.marks(id, 1).length, 2);
  restore(a); // and once more
  await sync(drive, a);
  await sync(drive, b);
  assert.equal(a.marks(id, 1).length, 2);
  assert.equal(b.marks(id, 1).length, 2);
});

test('two copies of one PDF here don’t look like changes waiting to sync', async () => {
  const { drive, devices: [a] } = setup('A');
  const id = a.add('Grace', 'g');
  a.draw(id, 1);
  // A second score with the same PDF (a new version made identical to it).
  a.files.set('copy', { ...a.files.get(id), id: 'copy' });
  a.blobs.set('copy', a.blobs.get(id));
  await sync(drive, a);
  await sync(drive, a);
  assert.equal(await dataPending(a), false);
  a.draw(id, 2);
  assert.equal(await dataPending(a), true);
});

test('page adjustments travel, and the newer one wins', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const id = a.add('Grace', 'g');
  const s1 = a.draw(id, 2);
  a.adjust(id, 2, 90, [0.1, 0.1, 0.8, 0.8]);
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(b.view(id, 2), { rot: 90, crop: [0.1, 0.1, 0.8, 0.8] });
  assert.deepEqual(b.marks(id, 2), [s1]); // the markings come too
  // Both change it; B's is later.
  a.adjust(id, 2, 180);
  b.clock.now += 1000;
  b.adjust(id, 2, 0, [0, 0.2, 1, 0.6]);
  await sync(drive, a);
  await sync(drive, b);
  await sync(drive, a);
  assert.deepEqual(a.view(id, 2), { rot: 0, crop: [0, 0.2, 1, 0.6] });
  assert.deepEqual(b.view(id, 2), { rot: 0, crop: [0, 0.2, 1, 0.6] });
  // Putting a page back as it was travels too.
  a.clock.now += 1000;
  a.adjust(id, 2, 0, null);
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(b.view(id, 2), { rot: 0, crop: null });
});

test('a score\u2019s zoom travels, and the newer one wins', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const ida = a.add('Grace', 'g');
  await sync(drive, a);
  await sync(drive, b);
  const idb = [...b.files.keys()][0];
  a.setZoom(ida, 0.7);
  await sync(drive, a);
  const r = await sync(drive, b);
  assert.equal(r.zooms, 1);
  assert.equal(b.zoomOf(idb), 0.7);
  // B changes it later than A does.
  a.setZoom(ida, 0.9);
  b.setZoom(idb, 0.6);
  await sync(drive, a);
  await sync(drive, b);
  await sync(drive, a);
  assert.equal(a.zoomOf(ida), 0.6);
  assert.equal(b.zoomOf(idb), 0.6);
  // Nothing new: nothing sent.
  assert.equal((await sync(drive, a)).zooms, 0);
});

test('a zoom change alone counts as waiting to sync', async () => {
  const { drive, devices: [a] } = setup('A');
  const id = a.add('Grace', 'g');
  await sync(drive, a);
  assert.equal(await dataPending(a), false);
  a.setZoom(id, 0.8);
  assert.equal(await dataPending(a), true);
  await sync(drive, a);
  assert.equal(await dataPending(a), false);
});

// ---- The index, and what the pages say ----

test('a hymnal’s index travels: hymns, sections and tap areas, changes and deletes', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const ida = a.add('Hymnal', 'hymnal-pdf');
  await sync(drive, a);
  await sync(drive, b);
  const idb = b.byName('Hymnal').id;
  a.addMarks(ida, 12, [{ kind: 'section', title: 'Advent', y: 0 }, { kind: 'hymn', n: '1', title: '', y: 0 }]);
  a.addMarks(ida, 1, [{ kind: 'link', box: [50, 100, 400, 30], hymn: '1' }]);
  await sync(drive, a);
  assert.equal((await sync(drive, b)).notes, 1);
  assert.deepEqual(b.marksOn(idb, 12).map((m) => m.title || m.n).sort(), ['1', 'Advent']);
  assert.equal(b.marksOn(idb, 1)[0].hymn, '1');
  // B names the hymn; A deletes the section meanwhile. Both changes stay.
  const hymn = b.marksOn(idb, 12).find((m) => m.kind === 'hymn');
  b.changeMark(idb, 12, hymn.id, { title: 'O Come, O Come, Emmanuel' });
  const advent = a.marksOn(ida, 12).find((m) => m.kind === 'section');
  a.changeMark(ida, 12, advent.id, { gone: true });
  await sync(drive, b);
  await sync(drive, a);
  await sync(drive, b);
  for (const [d, id] of [[a, ida], [b, idb]]) {
    assert.deepEqual(d.marksOn(id, 12).map((m) => [m.kind, m.title]), [['hymn', 'O Come, O Come, Emmanuel']]);
  }
});

test('typed notes travel: text, place, shown or collapsed, and deletes', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const ida = a.add('Suzuki Violin Book 1', 'book-pdf');
  await sync(drive, a);
  await sync(drive, b);
  const idb = b.byName('Suzuki Violin Book 1').id;
  a.addMarks(ida, 8, [{ kind: 'note', x: 0.2, y: 0.4, w: 0.3, r: 0, text: 'spider fingers\nbow lane 3', color: '#d0312d', size: 2, open: true }]);
  await sync(drive, a);
  assert.equal((await sync(drive, b)).notes, 1);
  const [onB] = b.marksOn(idb, 8);
  assert.equal(onB.text, 'spider fingers\nbow lane 3');
  assert.deepEqual([onB.x, onB.y, onB.w, onB.color, onB.size, onB.open], [0.2, 0.4, 0.3, '#d0312d', 2, true]);
  // B collapses it; then A deletes it. The delete, being newer, wins on both.
  b.changeMark(idb, 8, onB.id, { open: false });
  await sync(drive, b);
  await sync(drive, a);
  assert.equal(a.marksOn(ida, 8)[0].open, false);
  a.changeMark(ida, 8, onB.id, { gone: true });
  await sync(drive, a);
  await sync(drive, b);
  assert.deepEqual(a.marksOn(ida, 8), []);
  assert.deepEqual(b.marksOn(idb, 8), []);
});

test('what the pages say is read once and reaches the other devices', async () => {
  const { drive, devices: [a, b] } = setup('A', 'B');
  const ida = a.add('Hymnal', 'hymnal-pdf');
  await sync(drive, a);
  await sync(drive, b);
  const idb = b.byName('Hymnal').id;
  a.readPage(ida, 2, 'Amazing grace, how sweet the sound');
  a.readPage(ida, 3, 'Abide with me');
  assert.equal(await dataPending(a), true);
  await sync(drive, a);
  const r = await sync(drive, b);
  assert.equal(r.texts, 1);
  assert.equal(b.textOf(idb, 2), 'Amazing grace, how sweet the sound');
  assert.equal(b.textOf(idb, 3), 'Abide with me');
  // B reads page 3 again later: the newer reading wins everywhere.
  b.readPage(idb, 3, 'Abide with me; fast falls the eventide');
  await sync(drive, b);
  await sync(drive, a);
  assert.equal(a.textOf(ida, 3), 'Abide with me; fast falls the eventide');
  // Nothing more to do.
  assert.equal((await sync(drive, a)).texts, 0);
  assert.equal(await dataPending(a), false);
});
