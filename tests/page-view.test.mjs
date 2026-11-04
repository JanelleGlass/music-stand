// Run with: node --test tests/page-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normRot, normCrop, normView, isPlain, mergeView, turnPoint, turnRect, shownBox, pageToShown, shownToPage,
  musicBounds, luminance, pagesFor, withShape, MIN_CROP, normTilt, findTilt, compose, turnAbout,
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

const ratio = (r) => r[2] / r[3];
const inside = (r) => r[0] >= -1e-9 && r[1] >= -1e-9 && r[0] + r[2] <= 1 + 1e-9 && r[1] + r[3] <= 1 + 1e-9;

test('a trimmed frame grows round the music to the shape asked for', () => {
  // Music in a wide band; shape 1:1 (in fractions).
  const r = withShape([0.2, 0.4, 0.6, 0.2], 1);
  near(ratio(r), 1);
  nearAll(r, [0.2, 0.2, 0.6, 0.6]); // same middle, taller
  // A tall band, made wide.
  const t = withShape([0.45, 0.2, 0.1, 0.6], 1.5);
  near(ratio(t), 1.5);
  assert.ok(t[2] >= 0.1 && t[3] >= 0.6 - 1e-9); // still takes in the music
});

test('a frame that would run off the page is as big as fits, and stays on it', () => {
  const r = withShape([0.1, 0.1, 0.8, 0.8], 2); // twice as wide as tall
  near(ratio(r), 2);
  near(r[2], 1);
  assert.ok(inside(r));
  const s = withShape([0, 0.85, 0.3, 0.15], 0.5); // near the bottom edge
  near(ratio(s), 0.5);
  assert.ok(inside(s));
});

test('dragging an edge sets the size from that edge and keeps the opposite one', () => {
  // The top edge dragged: the bottom stays at 0.9.
  const n = withShape([0.2, 0.3, 0.6, 0.6], 1, 'n');
  near(n[1] + n[3], 0.9);
  near(ratio(n), 1);
  near(n[3], 0.6);
  // The right edge dragged: the left stays at 0.2.
  const e = withShape([0.2, 0.2, 0.4, 0.6], 1, 'e');
  near(e[0], 0.2);
  near(e[2], 0.4);
  near(e[3], 0.4);
});

test('dragging a corner keeps the opposite corner', () => {
  const r = withShape([0.3, 0.3, 0.5, 0.4], 1, 'nw'); // bottom right stays at (0.8, 0.7)
  near(ratio(r), 1);
  near(r[0] + r[2], 0.8);
  near(r[1] + r[3], 0.7);
  const s = withShape([0.1, 0.1, 0.3, 0.5], 1, 'se'); // top left stays
  nearAll([s[0], s[1]], [0.1, 0.1]);
  near(ratio(s), 1);
});

test('a frame never gets smaller than a frame can be', () => {
  const r = withShape([0.5, 0.5, MIN_CROP, MIN_CROP], 4);
  assert.ok(r[2] >= MIN_CROP - 1e-9 && r[3] >= MIN_CROP - 1e-9);
  near(ratio(r), 4);
});

test('tilt is kept within range, in small steps', () => {
  assert.equal(normTilt(1.234), 1.25);
  assert.equal(normTilt(-30), -10);
  assert.equal(normTilt('x'), 0);
  assert.equal(Object.is(normTilt(-0.01), 0), true);
  assert.deepEqual(normView({ rot: 0, tilt: 2, crop: null, at: 1 }), { rot: 0, crop: null, at: 1, tilt: 2 });
  assert.equal('tilt' in normView({ rot: 0, tilt: 0, crop: null, at: 1 }), false);
  assert.ok(!isPlain({ rot: 0, tilt: 0.5, crop: null }));
  assert.ok(isPlain({ rot: 0, tilt: 0, crop: null }));
});

test('turnAbout keeps its middle, and turns clockwise with y down', () => {
  const m = turnAbout(90, 10, 20);
  const at = (u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
  nearAll(at(10, 20), [10, 20]);
  nearAll(at(20, 20), [10, 30]); // right of the middle goes below it
  const back = compose(turnAbout(-90, 10, 20), m);
  nearAll(back, [1, 0, 0, 1, 0, 0]);
});

test('straightened pages: points land where they show, and come back', () => {
  const W = 600;
  const H = 800;
  for (const rot of [0, 90, 180, 270]) {
    for (const crop of [null, [0.1, 0.2, 0.6, 0.5]]) {
      const view = { rot, tilt: 3.5, crop };
      const m = pageToShown(view, W, H);
      for (const [u, v] of [[100, 300], [450, 700], [300, 400]]) {
        const x = m[0] * u + m[2] * v + m[4];
        const y = m[1] * u + m[3] * v + m[5];
        nearAll(shownToPage(view, W, H, x, y), [u, v], 1e-6);
      }
      // The middle of the page stays where it was.
      const flat = pageToShown({ rot, crop }, W, H);
      nearAll([m[0] * 300 + m[2] * 400 + m[4], m[1] * 300 + m[3] * 400 + m[5]], [flat[0] * 300 + flat[2] * 400 + flat[4], flat[1] * 300 + flat[3] * 400 + flat[5]], 1e-6);
    }
  }
});

// Five staff lines, each going down by slope px per px across.
function crooked(w, h, deg) {
  const lum = new Uint8Array(w * h).fill(255);
  const slope = Math.tan((deg * Math.PI) / 180);
  for (const y0 of [100, 112, 124, 136, 148, 300, 312, 324, 336, 348]) {
    for (let x = 40; x < w - 40; x++) {
      const y = Math.round(y0 + (x - w / 2) * slope);
      if (y >= 0 && y < h) lum[y * w + x] = 0;
    }
  }
  return lum;
}

test('findTilt levels crooked staff lines', () => {
  // Lines going down to the right (turned clockwise) need turning back.
  near(findTilt(crooked(500, 450, 2), 500, 450), -2, 0.11);
  near(findTilt(crooked(500, 450, -3.5), 500, 450), 3.5, 0.11);
  near(findTilt(crooked(500, 450, 0), 500, 450), 0, 0.06);
});

test('findTilt on a blank page is 0', () => {
  assert.equal(findTilt(new Uint8Array(100 * 100).fill(255), 100, 100), 0);
});
