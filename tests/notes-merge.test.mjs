// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePage, mergeNotes, mergeFolder, mergeFolders, restampFolder, sameContent } from '../js/notes-merge.js';

const stroke = (id, at) => ({ id, at, tool: 'pen', color: '#000000', w: 2, pts: [0, 0, 10, 10] });

test('strokes drawn on two devices are all kept, in drawing order', () => {
  const a = { strokes: [stroke('a1', 1), stroke('a2', 3)], erased: [] };
  const b = { strokes: [stroke('b1', 2)], erased: [] };
  assert.deepEqual(mergePage(a, b).strokes.map((s) => s.id), ['a1', 'b1', 'a2']);
});

test('a stroke erased on one device goes on the other, even if it is still there', () => {
  const a = { strokes: [stroke('s1', 1), stroke('s2', 2)], erased: [] };
  const b = { strokes: [stroke('s2', 2)], erased: ['s1'] };
  const m = mergePage(a, b);
  assert.deepEqual(m.strokes.map((s) => s.id), ['s2']);
  assert.deepEqual(m.erased, ['s1']);
});

test('merging notes is order-free and repeatable', () => {
  const x = { pages: { 1: { strokes: [stroke('x', 1)], erased: [] }, 3: { strokes: [], erased: ['y'] } } };
  const y = { pages: { 1: { strokes: [stroke('y', 2)], erased: [] } } };
  const z = { pages: { 2: { strokes: [stroke('z', 3)], erased: [] } } };
  const one = mergeNotes(mergeNotes(x, y), z);
  const two = mergeNotes(z, mergeNotes(y, x));
  assert.ok(sameContent(one, two));
  assert.ok(sameContent(mergeNotes(one, one), one));
  assert.deepEqual(Object.keys(one.pages), ['1', '2', '3']);
  assert.deepEqual(one.pages[1].strokes.map((s) => s.id), ['x', 'y']); // erased lists are per page
});

test('the newer folder name wins, and a deleted folder stays deleted', () => {
  const a = { id: 'f', name: 'Christmas', nameAt: 10, createdAt: 1, members: [] };
  const b = { id: 'f', name: 'Advent', nameAt: 20, createdAt: 1, members: [] };
  assert.equal(mergeFolder(a, b).name, 'Advent');
  assert.equal(mergeFolder(b, a).name, 'Advent');
  const gone = { ...a, deleted: true, deletedAt: 30 };
  assert.equal(mergeFolder(gone, b).deleted, true);
  assert.equal(mergeFolder(b, gone).deleted, true);
  // Restoring a backup brings it back: the newer change wins.
  const back = restampFolder(a, 40);
  assert.equal(mergeFolder(gone, back).deleted, false);
  assert.equal(mergeFolder(back, gone).deleted, false);
});

test('the newer change to a score in a folder wins; on a tie the removal does', () => {
  const a = { id: 'f', name: 'F', nameAt: 1, members: [{ score: 's', in: true, at: 5 }, { score: 't', in: true, at: 5 }] };
  const b = { id: 'f', name: 'F', nameAt: 1, members: [{ score: 's', in: false, at: 6 }, { score: 't', in: false, at: 5 }] };
  const m = mergeFolder(a, b);
  assert.deepEqual(m.members.map((x) => [x.score, x.in]), [['s', false], ['t', false]]);
  assert.ok(sameContent(mergeFolder(a, b), mergeFolder(b, a)));
});

test('folder lists merge by id, whatever the order', () => {
  const a = [{ id: '2', name: 'B', nameAt: 1 }, { id: '1', name: 'A', nameAt: 1 }];
  const b = [{ id: '3', name: 'C', nameAt: 1 }, { id: '1', name: 'A2', nameAt: 2 }];
  const m = mergeFolders(a, b);
  assert.deepEqual(m.map((f) => [f.id, f.name]), [['1', 'A2'], ['2', 'B'], ['3', 'C']]);
  assert.ok(sameContent(m, mergeFolders(b, a)));
  assert.ok(sameContent(mergeFolders(m, a), m));
});

test('a folder never keeps two entries for one score', () => {
  const f = { id: 'f', name: 'F', members: [{ score: 'a', in: true, at: 5 }, { score: 'a', in: false, at: 9 }, { score: 'b', in: true, at: 1 }] };
  const n = mergeFolders([f]);
  assert.deepEqual(n[0].members.map((m) => [m.score, m.in]), [['a', false], ['b', true]]);
  assert.ok(sameContent(mergeFolders([f], [f]), mergeFolders([f], [])));
});

test('a restamped folder keeps its order', () => {
  const f = { id: 'f', name: 'F', members: [{ score: 'z', in: true, at: 3 }, { score: 'a', in: true, at: 7 }, { score: 'm', in: true, at: 5 }] };
  const r = restampFolder(f, 100);
  const order = [...r.members].sort((x, y) => x.at - y.at).map((m) => m.score);
  assert.deepEqual(order, ['z', 'm', 'a']);
  assert.ok(r.members.every((m) => m.at >= 100));
});
