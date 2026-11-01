// Run with: node --test tests/*.test.mjs
// Undo and redo of markings, and saving that survives a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotesStore } from '../js/notes-store.js';

function store() {
  const saved = new Map();
  const s = new NotesStore({ write: async (writes) => { for (const w of writes) saved.set(w.key, w.page); } });
  return { s, saved };
}
const stroke = (id) => ({ id, at: 1, tool: 'pen', color: '#000000', w: 2, pts: [0, 0, 5, 5] });
const count = (s) => s.strokes('f', 1).length;

test('undo and redo work after undoing an erase', () => {
  const { s } = store();
  s.add('f', 1, stroke('a'));
  s.erase('f', 1, ['a']);
  assert.equal(count(s), 0);
  s.undo(); // the erase: a copy comes back
  assert.equal(count(s), 1);
  s.undo(); // the draw: the copy goes
  assert.equal(count(s), 0);
  assert.equal(s.canUndo, false);
  s.redo(); // the draw again
  assert.equal(count(s), 1);
  s.redo(); // the erase again
  assert.equal(count(s), 0);
  s.undo();
  s.undo();
  assert.equal(count(s), 0);
  s.redo();
  assert.equal(count(s), 1);
});

test('Clear page can be undone, and so can the strokes before it', () => {
  const { s } = store();
  s.add('f', 1, stroke('b'));
  s.add('f', 1, stroke('c'));
  s.clear('f', 1);
  assert.equal(count(s), 0);
  s.undo();
  assert.equal(count(s), 2);
  s.undo();
  assert.equal(count(s), 1);
  s.undo();
  assert.equal(count(s), 0);
});

test('a failed save is kept and tried again, even after another score opens', async () => {
  let fail = true;
  const saved = new Map();
  const errors = [];
  const s = new NotesStore({ write: async (writes) => { if (fail) throw new Error('disk'); for (const w of writes) saved.set(w.key, w.page); } });
  s.onError = (e) => errors.push(e);
  s.add('f', 1, stroke('a'));
  await s.flush();
  assert.equal(errors.length, 1);
  s.pages.clear(); // another score was opened
  fail = false;
  await s.flush();
  assert.deepEqual(saved.get('f:1').strokes.map((x) => x.id), ['a']);
  clearTimeout(s.timer);
});

test('a save that keeps failing tells the person once, and backs off', async () => {
  const errors = [];
  const s = new NotesStore({ write: async () => { throw new Error('disk'); } });
  s.onError = () => errors.push(1);
  s.add('f', 1, stroke('a'));
  await s.flush();
  await s.flush();
  await s.flush();
  assert.equal(errors.length, 1);
  assert.ok(s.retryMs > 5000);
  clearTimeout(s.timer);
});

test('pages dropped for a restore aren’t written by a save that was under way', async () => {
  let release;
  const saved = [];
  const s = new NotesStore({ write: (w) => new Promise((ok, fail) => { release = () => fail(new Error('disk')); saved.push(w); }) });
  s.add('f', 1, stroke('a'));
  const p = s.flush();
  await new Promise((r) => setTimeout(r, 0)); // the write has started
  s.discardPending();
  release();
  await p;
  assert.equal(s.failed.size, 0);
  assert.equal(s.unsaved.size, 0);
});
