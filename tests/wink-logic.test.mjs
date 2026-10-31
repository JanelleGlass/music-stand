// Run with: node --test tests/wink-logic.test.mjs
// Feeds synthetic eye-closure curves through the wink detector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WinkLogic } from '../js/wink-logic.js';

const FPS = 20;
const DT = 1000 / FPS;

// segments: [durationMs, leftScore, rightScore] (values hold for the duration)
function run(segments, opts = {}, jitter = 0) {
  const w = new WinkLogic({ sensitivity: 5, holdMs: 200, ...opts });
  const events = [];
  let t = 0;
  let seed = 1;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return ((seed / 2147483647) - 0.5) * 2 * jitter;
  };
  for (const [dur, l, r] of segments) {
    for (let e = 0; e < dur; e += DT) {
      const out = w.update(Math.max(0, l + noise()), Math.max(0, r + noise()), t);
      if (out.event) events.push(out.event);
      t += DT;
    }
  }
  return events;
}

const OPEN = [2000, 0.08, 0.1]; // settle baselines

test('a normal blink does not register', () => {
  assert.deepEqual(run([OPEN, [60, 0.5, 0.45], [150, 0.95, 0.92], [60, 0.4, 0.5], [500, 0.08, 0.1]]), []);
});

test('a blink where one eye closes a little earlier does not register', () => {
  assert.deepEqual(run([OPEN, [50, 0.9, 0.3], [150, 0.95, 0.9], [50, 0.3, 0.8], [500, 0.08, 0.1]]), []);
});

test('a held left wink registers once', () => {
  assert.deepEqual(run([OPEN, [350, 0.9, 0.15], [500, 0.08, 0.1]]), ['left']);
});

test('a held right wink registers once', () => {
  assert.deepEqual(run([OPEN, [350, 0.12, 0.88], [500, 0.08, 0.1]]), ['right']);
});

test('holding a wink for a long time does not repeat', () => {
  assert.deepEqual(run([OPEN, [2000, 0.9, 0.15], [500, 0.08, 0.1]]), ['left']);
});

test('a wink shorter than the hold time is ignored', () => {
  assert.deepEqual(run([OPEN, [120, 0.9, 0.15], [500, 0.08, 0.1]]), []);
});

test('a wink with the other eye squinting still registers', () => {
  assert.deepEqual(run([OPEN, [400, 0.97, 0.5], [500, 0.08, 0.1]]), ['left']);
});

test('looking down (both lids lowered) does not register', () => {
  assert.deepEqual(run([OPEN, [5000, 0.42, 0.45], [500, 0.08, 0.1]]), []);
});

test('two winks in a row register twice', () => {
  assert.deepEqual(
    run([OPEN, [300, 0.9, 0.1], [300, 0.08, 0.1], [300, 0.9, 0.1], [300, 0.08, 0.1], [300, 0.1, 0.9], [400, 0.08, 0.1]]),
    ['left', 'left', 'right']
  );
});

test('noisy scores still give one clean wink', () => {
  assert.deepEqual(run([OPEN, [400, 0.88, 0.15], [800, 0.08, 0.1]], {}, 0.08), ['left']);
});

test('asymmetric resting eyes are absorbed by the baseline', () => {
  // Right eye naturally reads 0.35 when open; a left wink must still work and
  // the right eye's natural droop must not count as a wink.
  assert.deepEqual(run([[3000, 0.05, 0.35], [400, 0.92, 0.38], [600, 0.05, 0.35]]), ['left']);
});

test('lower sensitivity ignores a light wink that higher sensitivity catches', () => {
  const light = [OPEN, [400, 0.55, 0.1], [500, 0.08, 0.1]];
  assert.deepEqual(run(light, { sensitivity: 2 }), []);
  assert.deepEqual(run(light, { sensitivity: 8 }), ['left']);
});

test('longer hold time requires a longer wink', () => {
  const wink = [OPEN, [300, 0.9, 0.1], [500, 0.08, 0.1]];
  assert.deepEqual(run(wink, { holdMs: 200 }), ['left']);
  assert.deepEqual(run(wink, { holdMs: 450 }), []);
});
