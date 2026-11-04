// Run with: node --test tests/page-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normRot, normCrop, normView, isPlain, mergeView, turnPoint, turnRect, shownBox, pageToShown, shownToPage,
  musicBounds, luminance, pagesFor, MIN_CROP,
} from '../js/page-view.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const nearAll = (a, b, eps) => { assert.equal(a.length, b.length); a.forEach((x, i) => near(x, b[i], eps)); };

test('rotations are whole quarter turns', () => {
  assert.equal(normRot(0), 0);
  assert.equal(normRot(90), 90);
  assert.equal(normRot(-90), 270);
  assert.equal(normRot(450), 90);
  assert.equal(normRot(88), 90);
  assert.equal(normRot('x'), 0);
});

test('a crop stays on the page and keeps some of it', () => {
  assert.deepEqual(normCrop([0.1, 0.1, 0.8, 0.8]), [0.1, 0.1, 0.8, 0.8]);
  assert.deepEqual(normCrop([0.95, 0, 0.5, 1]), [0.5, 0, 0.5, 1]);
  assert.deepEqual(normCrop([0.2, 0.2, 0.01, 0.01]), [0.2, 0.2, MIN_CROP, MIN_CROP]);
  assert.equal(normCrop([0, 0, 1, 1]), null);
  assert.equal(normCrop(null), null);
  assert.equal(normCrop([0, 0, 'a', 1]), null);
  assert.equal(normCrop([0, 0, 1]), null);
});

test('views are cleaned up, and plain ones recognised', () => {
  assert.deepEqual(normView({ rot: 90, crop: [0, 0, 1, 1], at: 5 }), { rot: 90, crop: null, at: 5 });
  assert.equal(normView(null), null);
  assert.ok(isPlain(null));
  assert.ok(isPlain({ rot: 0, crop: null, at: 3 }));
  assert.ok(!isPlain({ rot: 180, crop: null }));
  assert.ok(!isPlain({ rot: 0, crop: [0, 0, 0.5, 0.5] }));
});

test('the newer view wins, whichever order they meet in', () => {
  const a = { rot: 90, crop: null, at: 10 };
  const b = { rot: 0, crop: [0.1, 0.1, 0.8, 0.8], at: 20 };
  assert.deepEqual(mergeView(a, b), b);
  assert.deepEqual(mergeView(b, a), b);
  assert.deepEqual(mergeView(a, null), a);
  assert.deepEqual(mergeView(null, b), b);
  assert.equal(mergeView(null, null), null);
  // A tie goes the same way on every device.
  const c = { rot: 270, crop: null, at: 10 };
  assert.deepEqual(mergeView(a, c), mergeView(c, a));
  assert.deepEqual(mergeView(a, a), a);
});

test('turning a point', () => {
  // A 600 × 800 page; its top-left corner.
  assert.deepEqual(turnPoint(0, 600, 800, 0, 0), [0, 0]);
  assert.deepEqual(turnPoint(90, 600, 800, 0, 0), [800, 0]); // goes to the top right
  assert.deepEqual(turnPoint(180, 600, 800, 0, 0), [600, 800]);
  assert.deepEqual(turnPoint(270, 600, 800, 0, 0), [0, 600]); // goes to the bottom left
});

test('turning a rectangle and back gives it again', () => {
  const r = [0.1, 0.2, 0.3, 0.5];
  for (const rot of [0, 90, 180, 270]) nearAll(turnRect(turnRect(r, rot), 360 - rot), r);
  // The top strip turned a quarter clockwise is the right-hand strip.
  nearAll(turnRect([0, 0, 1, 0.25], 90), [0.75, 0, 0.25, 1]);
});

test('the part shown: its size is what the page is laid out at', () => {
  assert.deepEqual(shownBox(null, 600, 800), { x: 0, y: 0, w: 600, h: 800 });
  assert.deepEqual(shownBox({ rot: 90 }, 600, 800), { x: 0, y: 0, w: 800, h: 600 });
  const b = shownBox({ rot: 0, crop: [0.1, 0.25, 0.8, 0.5] }, 600, 800);
  nearAll([b.x, b.y, b.w, b.h], [60, 200, 480, 400]);
  const t = shownBox({ rot: 90, crop: [0.1, 0.25, 0.8, 0.5] }, 600, 800);
  nearAll([t.w, t.h], [400, 480]);
});

test('page points land where they show, and come back', () => {
  const W = 600;
  const H = 800;
  for (const rot of [0, 90, 180, 270]) {
    for (const crop of [null, [0.1, 0.2, 0.6, 0.5]]) {
      const view = { rot, crop };
      const m = pageToShown(view, W, H);
      const box = shownBox(view, W, H);
      // The crop's corners land on the corners of the part shown.
      const c = crop || [0, 0, 1, 1];
      const corners = [[c[0] * W, c[1] * H], [(c[0] + c[2]) * W, (c[1] + c[3]) * H]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
      const xs = corners.map((p) => p[0]).sort((a, b) => a - b);
      const ys = corners.map((p) => p[1]).sort((a, b) => a - b);
      nearAll([xs[0], ys[0], xs[1], ys[1]], [0, 0, box.w, box.h], 1e-6);
      // And back again.
      for (const [u, v] of [[100, 300], [450, 700], [c[0] * W + 1, c[1] * H + 2]]) {
        const x = m[0] * u + m[2] * v + m[4];
        const y = m[1] * u + m[3] * v + m[5];
        nearAll(shownToPage(view, W, H, x, y), [u, v]);
      }
    }
  }
});

// A blank page w × h with dark boxes [x0, y0, x1, y1] drawn on it.
function page(w, h, boxes, paper = 255) {
  const lum = new Uint8Array(w * h).fill(paper);
  for (const [x0, y0, x1, y1] of boxes) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) lum[y * w + x] = 0;
  return lum;
}

test('trimming finds the music and keeps a little paper round it', () => {
  // 200 × 300 with "music" from (40, 60) to (160, 240).
  const c = musicBounds(page(200, 300, [[40, 60, 160, 240]]), 200, 300, { pad: 0.02 });
  nearAll(c, [0.18, 0.18, 0.64, 0.64], 1e-3);
});

test('trimming ignores a scanner shadow down the edge and stray specks', () => {
  const lum = page(200, 300, [[40, 60, 160, 240], [0, 0, 6, 300], [190, 10, 191, 11]]);
  const c = musicBounds(lum, 200, 300, { pad: 0 });
  nearAll(c, [0.2, 0.2, 0.6, 0.6], 1e-3);
});

test('trimming a blank page leaves it whole', () => {
  assert.equal(musicBounds(page(100, 100, []), 100, 100), null);
  assert.equal(musicBounds(new Uint8Array(0), 0, 0), null);
});

test('trimming a page that is music to the edges leaves it whole', () => {
  // Short dashes all round, two pixels in from each edge.
  const dashes = [[2, 2, 12, 4], [88, 96, 98, 98], [2, 50, 4, 60], [96, 40, 98, 50]];
  assert.equal(musicBounds(page(100, 100, dashes), 100, 100, { pad: 0.02 }), null);
});

test('luminance from RGBA', () => {
  assert.deepEqual([...luminance(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]))], [255, 0, 76]);
});

test('which pages This page, All, Odd and Even mean', () => {
  const pages = [1, 2, 3, 4, 5].map((num) => ({ num }));
  assert.deepEqual(pagesFor('page', pages, 2), [2]);
  assert.deepEqual(pagesFor('all', pages, 2), [0, 1, 2, 3, 4]);
  assert.deepEqual(pagesFor('odd', pages, 2), [0, 2, 4]);
  assert.deepEqual(pagesFor('even', pages, 2), [1, 3]);
});
