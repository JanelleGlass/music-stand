// One page at a time: how big each page is, and how a page turns like a
// book's. No DOM, unit tested (tests/paging.test.mjs).
//
// In this mode the viewer gives every page a slot one screen tall, with the
// page as large as fits in it, centred. Page i's slot starts at i × slot, so
// the scroll position says which page is showing.

export const SWIPE_MIN = 40; // px a swipe needs, to tell it from a wobbly tap
export const FLICK = 0.3; // px/ms: a page let go this fast keeps going that way
export const FLIP_SHARE = 0.3; // a page let go slowly finishes turning once it's this far over

// The size of a page (w × h in PDF units) shown whole in a box.
export function fitPage(w, h, boxW, boxH) {
  const k = Math.min(boxW / w, boxH / h);
  return { cssW: Math.max(1, Math.round(w * k)), cssH: Math.max(1, Math.round(h * k)) };
}

// The page whose slot is nearest scroll position top.
export function pageAt(top, slot, count) {
  if (!(slot > 0) || count < 1) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(top / slot)));
}

// The turn a swipe of d px asks for: up or to the left (d < 0) goes forward
// (+1), down or to the right goes back (-1), a short one does nothing (0).
export function swipeTurn(d) {
  if (Math.abs(d) < SWIPE_MIN) return 0;
  return d < 0 ? 1 : -1;
}

// How far over a page is (0 to 1) when the finger holding it has moved dx px
// (right > 0) across a page width px wide. Forward, the page goes over to the
// left; back, the previous page comes over to the right.
export function flipProgress(dir, dx, width) {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(1, (dir > 0 ? -dx : dx) / width));
}

// Whether a page let go at progress p, moving at v px/ms (> 0 in the way it
// turns), finishes turning. Otherwise it falls back where it was.
export function flipCompletes(p, v) {
  if (v > FLICK) return true;
  if (v < -FLICK) return false;
  return p > FLIP_SHARE;
}

// The turning page's angle in degrees about its left edge (the spine): 0 lies
// flat on the right, -180 has turned over to the left. Forward, the page that
// was showing goes from 0 to -180; back, the previous page comes from -180 to 0.
export function leafAngle(dir, p) {
  return dir > 0 ? -180 * p : -180 * (1 - p);
}
