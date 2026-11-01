// Run with: node --test tests/paging.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPage, pageAt, swipeTurn, flipProgress, flipCompletes, leafAngle, SWIPE_MIN, FLICK, FLIP_SHARE } from '../js/paging.js';

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

test('swipes up or left go forward, down or right go back, short ones do nothing', () => {
  assert.equal(swipeTurn(-(SWIPE_MIN + 1)), 1);
  assert.equal(swipeTurn(SWIPE_MIN + 1), -1);
  assert.equal(swipeTurn(SWIPE_MIN - 1), 0);
  assert.equal(swipeTurn(-(SWIPE_MIN - 1)), 0);
});

test('a page follows the finger across its width', () => {
  assert.equal(flipProgress(1, -400, 800), 0.5); // forward: finger moves left
  assert.equal(flipProgress(-1, 400, 800), 0.5); // back: finger moves right
  assert.equal(flipProgress(1, 100, 800), 0); // the wrong way doesn't turn it
  assert.equal(flipProgress(1, -2000, 800), 1); // no further than over
  assert.equal(flipProgress(1, -100, 0), 0);
});

test('a page let go slowly finishes once it is far enough over', () => {
  assert.equal(flipCompletes(FLIP_SHARE + 0.01, 0), true);
  assert.equal(flipCompletes(FLIP_SHARE - 0.01, 0), false);
});

test('a flick decides however far the page is over', () => {
  assert.equal(flipCompletes(0.05, FLICK + 0.1), true);
  assert.equal(flipCompletes(0.9, -(FLICK + 0.1)), false);
});

test('the page turns about its left edge, over to the left', () => {
  assert.equal(leafAngle(1, 0), -0);
  assert.equal(leafAngle(1, 0.5), -90);
  assert.equal(leafAngle(1, 1), -180);
  // Back: the previous page comes over from the left.
  assert.equal(leafAngle(-1, 0), -180);
  assert.equal(leafAngle(-1, 1), -0);
});
