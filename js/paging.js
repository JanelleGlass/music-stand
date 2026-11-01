// One page at a time: how big each page is and where a swipe lands. No DOM,
// unit tested (tests/paging.test.mjs).
//
// In this mode the viewer gives every page a slot one screen tall, with the
// page as large as fits in it, centred. Page i's slot starts at i × slot, so
// the scroll position says which page is showing.

export const FLICK = 0.3; // px/ms: a let-go this fast turns the page however far it moved
export const DRAG_SHARE = 0.2; // a slow drag turns the page once it has moved this share of a screen
export const SIDE_MIN = 40; // px a sideways swipe needs, to tell it from a wobbly tap

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

// Where the music settles when a finger lets go of it. base: the page the drag
// started on; moved: px the music moved (forward > 0); velocity: px/ms the
// music was moving at the end (forward > 0). One page at most per swipe.
export function settlePage({ base, count, moved, slot, velocity }) {
  const flick = Math.abs(velocity) > FLICK ? Math.sign(velocity) : 0;
  const far = Math.abs(moved) > slot * DRAG_SHARE ? Math.sign(moved) : 0;
  // Dragged one way, then flicked back: stay.
  const dir = flick && far && flick !== far ? 0 : flick || far;
  return Math.max(0, Math.min(count - 1, base + dir));
}

// A sideways swipe turns like a book: to the left goes forward (+1), to the
// right goes back (-1). dx: px the finger moved (right > 0).
export function sideSwipe(dx) {
  if (Math.abs(dx) < SIDE_MIN) return 0;
  return dx < 0 ? 1 : -1;
}
