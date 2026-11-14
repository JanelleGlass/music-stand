// The scroll bar's arithmetic: where its handle sits, and where the music goes
// when the handle is dragged. No DOM, unit tested (tests/scrub.test.mjs).
//
// A position in the music is a fraction from 0 (the top of the first page) to
// 1 (the bottom of the last page on screen). The handle's top moves from the
// top of the track (0) to the track's height less the handle's (1).

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// How far through the music the screen is, 0 to 1.
export function fractionOf(scrollTop, maxScroll) {
  return maxScroll > 0 ? clamp01(scrollTop / maxScroll) : 0;
}

// Where the handle's top goes on a track trackH px tall, for fraction f.
export function handleTop(f, trackH, handleH) {
  return Math.round(clamp01(f) * Math.max(0, trackH - handleH));
}

// The fraction for a finger at y px down the track, holding the handle grab
// px below the handle's top.
export function fractionAt(y, trackH, handleH, grab) {
  const room = trackH - handleH;
  return room > 0 ? clamp01((y - grab) / room) : 0;
}

// The magnifier beside the bar: a column of the index's entries, rows rowH
// px apart, entry k0's row centred y0 px down. The entry (0 to count - 1)
// whose row is at y; -1 with no entries.
export function rowAt(k0, y0, y, rowH, count) {
  if (count < 1) return -1;
  return Math.max(0, Math.min(count - 1, k0 + Math.round((y - y0) / rowH)));
}

// Where a box boxH px tall goes (its top) to be centred on y, staying
// between lo and hi (at lo when it can't fit).
export function boxTop(y, boxH, lo, hi) {
  return Math.round(Math.max(lo, Math.min(hi - boxH, y - boxH / 2)));
}

// Where to scroll for fraction f. With slot > 0 (one page at a time) it
// lands on the start of a page.
export function scrollFor(f, maxScroll, slot = 0) {
  const y = clamp01(f) * Math.max(0, maxScroll);
  return slot > 0 ? Math.round(y / slot) * slot : Math.round(y);
}
