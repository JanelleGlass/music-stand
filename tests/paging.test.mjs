// Run with: node --test tests/paging.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPage, pageAt, settlePage, sideSwipe, FLICK, DRAG_SHARE, SIDE_MIN } from '../js/paging.js';

test('a portrait page on a portrait screen fills the width', () => {
  // US Letter on an iPad Air in portrait (820 × 1156 below the status bar, 8 px margins).
  assert.deepEqual(fitPage(612, 792, 820, 1140), { cssW: 820, cssH: 1061 });
});

test('a portrait page on a landscape screen fills the height', () => {
  assert.deepEqual(fitPage(612, 792, 1180, 780), { cssW: 603, cssH: 780 });
});

test('a landscape page on a portrait screen fills the width', () => {
  assert.deepEqual(fitPage(792, 612, 820, 1140), { cssW: 820, cssH: 634 });
});

test('fitPage never returns an empty page', () => {
  const { cssW, cssH } = fitPage(612, 792, 0, 0);
  assert.ok(cssW >= 1 && cssH >= 1);
});

test('pageAt rounds to the nearest slot and stays in range', () => {
  assert.equal(pageAt(0, 1000, 5), 0);
  assert.equal(pageAt(1000, 1000, 5), 1);
  assert.equal(pageAt(1499, 1000, 5), 1);
  assert.equal(pageAt(1500, 1000, 5), 2);
  assert.equal(pageAt(-50, 1000, 5), 0);
  assert.equal(pageAt(99_000, 1000, 5), 4);
  assert.equal(pageAt(500, 0, 5), 0); // no layout yet
});

const slot = 1000;
const at = (moved, velocity, base = 2, count = 5) => settlePage({ base, count, moved, slot, velocity });

test('a small slow drag springs back to the same page', () => {
  assert.equal(at(slot * DRAG_SHARE - 1, 0), 2);
  assert.equal(at(-(slot * DRAG_SHARE - 1), 0), 2);
});

test('a slow drag past the share turns one page', () => {
  assert.equal(at(slot * DRAG_SHARE + 1, 0), 3);
  assert.equal(at(-(slot * DRAG_SHARE + 1), 0), 1);
});

test('a quick flick turns one page even when it moved only a little', () => {
  assert.equal(at(30, FLICK + 0.1), 3);
  assert.equal(at(-30, -(FLICK + 0.1)), 1);
});

test('a long drag still turns only one page', () => {
  assert.equal(at(slot * 0.95, 2), 3);
});

test('dragging forward and flicking back stays on the page', () => {
  assert.equal(at(slot * 0.5, -1), 2);
});

test('there is no page before the first or after the last', () => {
  assert.equal(at(-slot * 0.5, -1, 0), 0);
  assert.equal(at(slot * 0.5, 1, 4), 4);
});

test('sideways swipes turn like a book', () => {
  assert.equal(sideSwipe(-(SIDE_MIN + 1)), 1);
  assert.equal(sideSwipe(SIDE_MIN + 1), -1);
  assert.equal(sideSwipe(SIDE_MIN - 1), 0);
  assert.equal(sideSwipe(-(SIDE_MIN - 1)), 0);
});
