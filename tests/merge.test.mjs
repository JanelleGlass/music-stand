// Run with: node --test tests/merge.test.mjs
// Rules for merging a backup from another device into this one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileMatcher, planFiles, summarise, remapIds, takeIncoming, recordsToWrite, restoredSettings } from '../js/merge.js';

const A = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const A2 = '6fa459ea-ee8a-3ca4-894e-db77e160355e';
const B = '16fd2706-8baf-433b-82eb-8c7fada847da';

test('a file copied here before matches by id', () => {
  const m = new FileMatcher([{ id: A, hash: 'h1' }]);
  assert.equal(m.match({ id: A, hash: 'h1' }), A);
});

test('the same PDF added on both devices matches by content', () => {
  const m = new FileMatcher([{ id: A, hash: 'h1' }]);
  assert.equal(m.match({ id: A2, hash: 'h1' }), A);
});

test('a different PDF is new', () => {
  const m = new FileMatcher([{ id: A, hash: 'h1' }]);
  assert.equal(m.match({ id: B, hash: 'h2' }), null);
});

test('files without a hash only match by id', () => {
  const m = new FileMatcher([{ id: A, hash: null }]);
  assert.equal(m.match({ id: A2, hash: null }), null);
  assert.equal(m.match({ id: A2 }), null);
  assert.equal(m.match({ id: A }), A);
});

test('duplicates inside one backup collapse to the first copy', () => {
  const m = new FileMatcher();
  assert.equal(m.match({ id: A, hash: 'h1' }), null);
  m.add({ id: A, hash: 'h1' });
  assert.equal(m.match({ id: A2, hash: 'h1' }), A);
});

// Fake content hashing: the "content" of a test file is its name.
function hasher() {
  const calls = [];
  return { calls, hashOf: async (f) => { calls.push(f.id); return `h:${f.name}`; } };
}

test('planning a merge: copies here, repeats in the backup, and new scores', async () => {
  const local = [{ id: A, name: 'Grace', hash: 'h:Grace', size: 10 }];
  const files = [
    { id: A2, name: 'Grace', hash: 'h:Grace', size: 10 }, // added separately on the other device
    { id: B, name: 'Vision', hash: 'h:Vision', size: 20 }, // new
    { id: 'c1', name: 'Vision', hash: 'h:Vision', size: 20 }, // repeat inside the backup
  ];
  const plan = await planFiles(files, local, hasher().hashOf);
  assert.deepEqual(plan.map((p) => [p.same, p.here]), [[A, true], [null, false], [B, false]]);
  assert.deepEqual(summarise(plan), { scores: 2, fresh: 1, here: 1 });
});

test('a backup repeating one score is not reported as already on an empty device', async () => {
  const files = [{ id: A, hash: 'h1', size: 1 }, { id: A2, hash: 'h1', size: 1 }, { id: B, hash: 'h2', size: 2 }];
  assert.deepEqual(summarise(await planFiles(files, [], hasher().hashOf)), { scores: 2, fresh: 2, here: 0 });
});

test('two backup copies of one score here count once', async () => {
  const local = [{ id: A, hash: 'h1', size: 1 }];
  const files = [{ id: A, hash: 'h1', size: 1 }, { id: A2, hash: 'h1', size: 1 }];
  assert.deepEqual(summarise(await planFiles(files, local, hasher().hashOf)), { scores: 1, fresh: 0, here: 1 });
});

test('files without a hash are hashed only when another file has the same size', async () => {
  const local = [{ id: A, name: 'Grace', hash: 'h:Grace', size: 10 }];
  const files = [
    { id: A2, name: 'Grace', hash: null, size: 10 }, // same size as a file here → hashed, matches
    { id: B, name: 'Vision', hash: null, size: 20 }, // unique size → can't be a copy, not hashed
    { id: 'c1', name: 'Fount', size: 30 }, // these two share a size → both hashed, second is a repeat
    { id: 'c2', name: 'Fount', size: 30 },
  ];
  const h = hasher();
  const plan = await planFiles(files, local, h.hashOf);
  assert.deepEqual(h.calls, [A2, 'c1', 'c2']);
  assert.deepEqual(plan.map((p) => p.same), [A, null, null, 'c1']);
  assert.equal(files[0].hash, 'h:Grace'); // kept for the import to reuse
  assert.deepEqual(summarise(plan), { scores: 3, fresh: 2, here: 1 });
});

test('the preview and the import agree, since the import reuses the preview\'s hashes', async () => {
  const local = [{ id: A, name: 'Grace', hash: 'h:Grace', size: 10 }];
  const files = [{ id: A2, name: 'Grace', hash: null, size: 10 }];
  const h = hasher();
  const preview = summarise(await planFiles(files, local, h.hashOf));
  const actual = summarise(await planFiles(files, local, h.hashOf));
  assert.deepEqual(preview, actual);
  assert.equal(h.calls.length, 1);
});

test('remapping rewrites file ids, "fileId:page" ids and nested entries', () => {
  const remap = new Map([[A2, A]]);
  assert.deepEqual(remapIds({ id: A2, page: 3, frac: 0.5, zoom: 1 }, remap), { id: A, page: 3, frac: 0.5, zoom: 1 });
  assert.deepEqual(remapIds({ id: `${A2}:4`, fileId: A2, page: 4, strokes: [[0.1, 0.2]] }, remap),
    { id: `${A}:4`, fileId: A, page: 4, strokes: [[0.1, 0.2]] });
  assert.deepEqual(remapIds({ id: 'list-1', name: 'Offertory', entries: [{ fileId: A2, from: 3, to: 4 }, { fileId: B }] }, remap),
    { id: 'list-1', name: 'Offertory', entries: [{ fileId: A, from: 3, to: 4 }, { fileId: B }] });
});

test('remapping leaves everything else alone', () => {
  const remap = new Map([[A2, A]]);
  const rec = { id: B, name: `Hymn: ${A2}x`, note: 'Hymn: Amazing Grace', n: 5, ok: true, none: null };
  assert.deepEqual(remapIds(rec, remap), rec);
  assert.equal(remapIds(rec, new Map()), rec);
});

test('records already here are kept unless the backup copy is newer', () => {
  assert.equal(takeIncoming(undefined, { id: A }), true);
  assert.equal(takeIncoming({ id: A }, { id: A }), false);
  assert.equal(takeIncoming({ id: A, updatedAt: 5 }, { id: A, updatedAt: 9 }), true);
  assert.equal(takeIncoming({ id: A, updatedAt: 9 }, { id: A, updatedAt: 5 }), false);
  assert.equal(takeIncoming({ id: A }, { id: A, updatedAt: 9 }), false);
});

test('reading places attach to this device\'s copy without overwriting one already here', () => {
  const here = [{ id: A, page: 7, frac: 0.2, zoom: 0.8 }];
  const incoming = [
    { id: A2, page: 2, frac: 0, zoom: 1 }, // same score, already has a place here → keep ours
    { id: B, page: 4, frac: 0.5, zoom: 1 }, // new score → add
    null,
    { page: 1 }, // damaged → skip
  ];
  assert.deepEqual(recordsToWrite(here, incoming, new Map([[A2, A]])), [{ id: B, page: 4, frac: 0.5, zoom: 1 }]);
});

test('two backup records for the same score keep the first, or the newer', () => {
  const remap = new Map([[A2, A]]);
  assert.deepEqual(recordsToWrite([], [{ id: A, page: 1 }, { id: A2, page: 9 }], remap), [{ id: A, page: 1 }]);
  assert.deepEqual(recordsToWrite([], [{ id: A, updatedAt: 1 }, { id: A2, updatedAt: 2 }], remap), [{ id: A, updatedAt: 2 }]);
});

test('replacing keeps this device\'s eye calibration', () => {
  assert.deepEqual(restoredSettings({ scrollAmount: 70, winkSwap: true }, { scrollAmount: 80, winkSwap: false }),
    { scrollAmount: 70, winkSwap: false });
  assert.deepEqual(restoredSettings(null, { winkSwap: true, nightMode: true }), { winkSwap: true });
  assert.deepEqual(restoredSettings({ winkSwap: true }, {}), {});
});

test('page adjustments: Merge keeps the newer, Replace makes the backup’s win', async () => {
  const { combineRecord } = await import('../js/merge.js');
  const here = { id: 'f:2', fileId: 'f', page: 2, strokes: [], erased: [], view: { rot: 90, crop: null, at: 500 } };
  const backup = { id: 'f:2', fileId: 'f', page: 2, strokes: [], erased: [], view: { rot: 0, crop: [0.1, 0.1, 0.8, 0.8], at: 100 } };
  assert.equal(combineRecord('annotations', here, backup, { now: 1000 }).view.rot, 90);
  const replaced = combineRecord('annotations', here, backup, { replace: true, now: 1000 }).view;
  assert.deepEqual([replaced.rot, replaced.crop, replaced.at], [0, [0.1, 0.1, 0.8, 0.8], 1000]);
});
