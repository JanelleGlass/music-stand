// Run with: node --test tests/scrub.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fractionOf, handleTop, fractionAt, scrollFor } from '../js/scrub.js';

test('fractionOf goes from 0 at the top to 1 at the end', () => {
  assert.equal(fractionOf(0, 1000), 0);
  assert.equal(fractionOf(500, 1000), 0.5);
  assert.equal(fractionOf(1000, 1000), 1);
  assert.equal(fractionOf(1200, 1000), 1); // iOS bounce past the end
  assert.equal(fractionOf(-30, 1000), 0); // and past the top
});

test('fractionOf is 0 when the music fits on the screen', () => {
  assert.equal(fractionOf(0, 0), 0);
  assert.equal(fractionOf(10, -5), 0);
});

test('the handle travels the track less its own height', () => {
  assert.equal(handleTop(0, 600, 50), 0);
  assert.equal(handleTop(1, 600, 50), 550);
  assert.equal(handleTop(0.5, 600, 50), 275);
  assert.equal(handleTop(2, 600, 50), 550);
  assert.equal(handleTop(0.5, 40, 50), 0); // a track shorter than the handle
});

test('fractionAt is the inverse of handleTop', () => {
  for (const f of [0, 0.25, 0.5, 0.8, 1]) {
    const top = handleTop(f, 600, 50);
    assert.ok(Math.abs(fractionAt(top + 20, 600, 50, 20) - f) < 0.005);
  }
});

test('fractionAt stops at the ends of the track', () => {
  assert.equal(fractionAt(-100, 600, 50, 25), 0);
  assert.equal(fractionAt(900, 600, 50, 25), 1);
  assert.equal(fractionAt(10, 50, 50, 0), 0);
});

test('scrollFor scrolls in proportion when scrolling', () => {
  assert.equal(scrollFor(0, 9000), 0);
  assert.equal(scrollFor(0.5, 9000), 4500);
  assert.equal(scrollFor(1, 9000), 9000);
  assert.equal(scrollFor(1.5, 9000), 9000);
});

test('scrollFor lands on a page one page at a time', () => {
  // 10 pages, 1000 px per page: the last page starts at 9000.
  assert.equal(scrollFor(0, 9000, 1000), 0);
  assert.equal(scrollFor(0.04, 9000, 1000), 0);
  assert.equal(scrollFor(0.06, 9000, 1000), 1000);
  assert.equal(scrollFor(0.5, 9000, 1000), 5000);
  assert.equal(scrollFor(1, 9000, 1000), 9000);
});
