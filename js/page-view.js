// Page adjustments: how a page is shown, cropped and turned. No DOM, unit
// tested (tests/page-view.test.mjs).
//
// A page's view is { rot, tilt, crop, at }:
//   rot   0, 90, 180 or 270: degrees the page is turned clockwise.
//   tilt  degrees (-MAX_TILT to MAX_TILT) the music is turned clockwise
//         about the middle of the page, to straighten a crooked scan. The
//         page keeps its size: the corners that turn off it are cut off.
//   crop  null (the whole page) or [x, y, w, h], the part shown, as fractions
//         of the page straightened but not turned (before rot), so turning a
//         cropped page keeps the same music.
//   at    when it was set (ms); between devices the newer setting wins.
//
// Markings stay in the page's own units (js/ink-draw.js), so they keep their
// place on the music whatever the view; a crop just hides them with the
// margin they're in.

export const ROTATIONS = [0, 90, 180, 270];
export const MIN_CROP = 0.1; // a crop keeps at least this much of each side
export const MAX_TILT = 10; // degrees a page can be straightened either way

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r4 = (n) => Math.round(n * 10000) / 10000;

export function normRot(r) {
  const n = ((Math.round(Number(r) / 90) * 90) % 360 + 360) % 360;
  return Number.isFinite(n) ? n : 0;
}

// A crop kept inside the page and at least MIN_CROP each way; null for none
// (or for one that is the whole page).
export function normCrop(c) {
  if (!Array.isArray(c) || c.length !== 4 || !c.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  let [x, y, w, h] = c;
  w = clamp(w, MIN_CROP, 1);
  h = clamp(h, MIN_CROP, 1);
  x = clamp(x, 0, 1 - w);
  y = clamp(y, 0, 1 - h);
  const out = [r4(x), r4(y), r4(w), r4(h)];
  if (out[0] <= 0.0005 && out[1] <= 0.0005 && out[2] >= 0.9995 && out[3] >= 0.9995) return null;
  return out;
}

// Tilt in steps of 0.05°, within MAX_TILT.
export function normTilt(t) {
  const n = Math.round(clamp(Number(t) || 0, -MAX_TILT, MAX_TILT) * 20) / 20;
  return n === 0 ? 0 : n; // not -0
}

// A stored view, cleaned up; null if there is none.
export function normView(v) {
  if (!v || typeof v !== 'object') return null;
  const out = { rot: normRot(v.rot || 0), crop: normCrop(v.crop), at: Number(v.at) || 0 };
  const tilt = normTilt(v.tilt);
  if (tilt) out.tilt = tilt; // left out when level, as before there was tilt
  return out;
}

// Whether a view shows the page just as it is.
export function isPlain(v) {
  return !v || (!v.rot && !v.crop && !normTilt(v.tilt));
}

// Two copies of a page's view (two devices): the newer wins; on a tie, the
// same one on every device.
export function mergeView(a, b) {
  a = normView(a);
  b = normView(b);
  if (!a || !b) return a || b;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

// ---- Geometry ----
//
// W × H: the page's size in the PDF (PDF units). "Display" coordinates are
// those of the part shown, turned: (0, 0) is its top-left corner as seen.

// Where point (u, v) of a W × H page goes when the page is turned rot.
export function turnPoint(rot, W, H, u, v) {
  switch (rot) {
    case 90: return [H - v, u];
    case 180: return [W - u, H - v];
    case 270: return [v, W - u];
    default: return [u, v];
  }
}

// A rectangle [x, y, w, h] of fractions of the page, as fractions of the
// page turned rot (and back again with 360 - rot).
export function turnRect(rect, rot) {
  const [x, y, w, h] = rect;
  switch (normRot(rot)) {
    case 90: return [1 - y - h, x, h, w];
    case 180: return [1 - x - w, 1 - y - h, w, h];
    case 270: return [y, 1 - x - w, h, w];
    default: return [x, y, w, h];
  }
}

// The part shown, in the turned page's PDF units: { x, y, w, h }. Its w and h
// are the size the page is laid out at.
export function shownBox(view, W, H) {
  const rot = view ? normRot(view.rot) : 0;
  const crop = (view && normCrop(view.crop)) || [0, 0, 1, 1];
  const [x, y, w, h] = turnRect(crop, rot);
  const TW = rot % 180 ? H : W;
  const TH = rot % 180 ? W : H;
  return { x: x * TW, y: y * TH, w: w * TW, h: h * TH };
}

// Matrices [a, b, c, d, e, f] take point (u, v) to (a·u + c·v + e,
// b·u + d·v + f), as CSS's matrix() and canvas's transform() do.

// m then n: the matrix doing m first, then n.
export function compose(n, m) {
  return [
    n[0] * m[0] + n[2] * m[1], n[1] * m[0] + n[3] * m[1],
    n[0] * m[2] + n[2] * m[3], n[1] * m[2] + n[3] * m[3],
    n[0] * m[4] + n[2] * m[5] + n[4], n[1] * m[4] + n[3] * m[5] + n[5],
  ];
}

// Turning by deg clockwise (y pointing down) about (cx, cy).
export function turnAbout(deg, cx, cy) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

// Page point (u, v) to display point: straightened, turned and cropped, all
// in PDF units.
export function pageToShown(view, W, H) {
  const rot = view ? normRot(view.rot) : 0;
  const box = shownBox(view, W, H);
  const [e, f] = turnPoint(rot, W, H, 0, 0);
  const lin = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] }[rot];
  const shown = [...lin, e - box.x, f - box.y];
  const tilt = view ? normTilt(view.tilt) : 0;
  return tilt ? compose(shown, turnAbout(tilt, W / 2, H / 2)) : shown;
}

// The page point under display point (x, y) (PDF units).
export function shownToPage(view, W, H, x, y) {
  const [a, b, c, d, e, f] = pageToShown(view, W, H);
  const det = a * d - b * c;
  const dx = x - e;
  const dy = y - f;
  return [(d * dx - c * dy) / det, (a * dy - b * dx) / det];
}

// ---- Keeping the frame's shape ----

// A crop rectangle [x, y, w, h] (fractions of the page as shown) changed to
// shape rf: its width ÷ height in fractions (the shape wanted ÷ the shape of
// the page as shown). kind says what was dragged (js/adjust-ui.js), which
// sets what stays put: dragging the top edge keeps the bottom, a corner
// keeps the opposite corner; 'center' (after Trim margins, or a new shape)
// keeps the middle. Dragging an edge sets the size from that edge; otherwise
// the frame grows to take in all of rect, unless the page isn't big enough,
// when it's as big as fits.
export function withShape(rect, rf, kind = 'center') {
  let [x, y, w, h] = rect;
  if (!(rf > 0)) return rect;
  const right = x + w;
  const bottom = y + h;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (kind === 'n' || kind === 's') w = h * rf;
  else if (kind === 'e' || kind === 'w') h = w / rf;
  else if (w / h > rf) h = w / rf;
  else w = h * rf;
  // As big as fits on the page, and not smaller than a frame can be.
  if (w > 1) { w = 1; h = w / rf; }
  if (h > 1) { h = 1; w = h * rf; }
  const least = Math.max(MIN_CROP / w, MIN_CROP / h, 1);
  if (least > 1 && w * least <= 1 && h * least <= 1) { w *= least; h *= least; }
  const side = /^[nsew]{1,2}$/.test(kind) ? kind : ''; // 'center' keeps the middle
  x = side.includes('w') ? right - w : side.includes('e') ? x : cx - w / 2;
  y = side.includes('n') ? bottom - h : side.includes('s') ? y : cy - h / 2;
  return [clamp(x, 0, 1 - w), clamp(y, 0, 1 - h), w, h];
}

// ---- Trimming the margins ----

// The part of a page with music on it, from its pixels: lum is one byte per
// pixel (0 black, 255 white), w × h. Returns a crop [x, y, w, h] (fractions)
// with a little paper kept round the music, or null if the page is blank.
//
// Rows and columns count as music when they have a few dark pixels. The
// outermost sliver, and nearly solid lines near the edge, are the edge of the
// paper or a scanner's shadow, not music, and are left out of both counts.
// (Staff lines can run almost the width of the page, so lines further in
// always count.)
export function musicBounds(lum, w, h, { dark = 190, pad = 0.02, edge = 0.01, shadowZone = 0.08, solid = 0.92 } = {}) {
  if (!w || !h) return null;
  const count = (skipRow, skipCol) => {
    const rows = new Uint32Array(h);
    const cols = new Uint32Array(w);
    for (let y = 0; y < h; y++) {
      if (skipRow[y]) continue;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!skipCol[x] && lum[row + x] < dark) {
          rows[y]++;
          cols[x]++;
        }
      }
    }
    return { rows, cols };
  };
  const outer = (len, counts, across) => {
    const skip = new Uint8Array(len);
    const sliver = Math.floor(len * edge);
    const zone = Math.floor(len * shadowZone);
    for (let i = 0; i < len; i++) {
      const nearEdge = i < zone || i >= len - zone;
      if (i < sliver || i >= len - sliver || (counts && nearEdge && counts[i] >= across * solid)) skip[i] = 1;
    }
    return skip;
  };
  const first = count(new Uint8Array(h), new Uint8Array(w));
  const skipRow = outer(h, first.rows, w);
  const skipCol = outer(w, first.cols, h);
  const { rows, cols } = count(skipRow, skipCol);
  const span = (counts, len, across, skip) => {
    const need = Math.max(2, Math.round(across * 0.003));
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < len; i++) {
      if (!skip[i] && counts[i] >= need) {
        if (lo < 0) lo = i;
        hi = i;
      }
    }
    return lo < 0 ? null : [lo, hi + 1];
  };
  const ys = span(rows, h, w, skipRow);
  const xs = span(cols, w, h, skipCol);
  if (!ys || !xs) return null;
  const x0 = Math.max(0, xs[0] / w - pad);
  const x1 = Math.min(1, xs[1] / w + pad);
  const y0 = Math.max(0, ys[0] / h - pad);
  const y1 = Math.min(1, ys[1] / h + pad);
  return normCrop([x0, y0, x1 - x0, y1 - y0]);
}

// ---- Straightening ----

// The tilt (degrees, as in a view) that makes the staff lines of a page level,
// from its pixels (as musicBounds). Tries angles, turning the dark pixels
// and counting them row by row: level staff lines pile up in a few rows.
// 0 if nothing is found.
export function findTilt(lum, w, h, { dark = 160, range = 6 } = {}) {
  const xs = [];
  const ys = [];
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 250000))); // about 250,000 pixels looked at
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    if (lum[y * w + x] < dark) {
      xs.push(x - w / 2);
      ys.push(y - h / 2);
    }
  }
  if (xs.length < 50) return 0;
  const rows = new Float64Array(Math.ceil(Math.hypot(w, h)) + 2);
  const off = rows.length / 2;
  const score = (deg) => {
    const r = (deg * Math.PI) / 180;
    const s = Math.sin(r);
    const c = Math.cos(r);
    rows.fill(0);
    for (let i = 0; i < xs.length; i++) rows[Math.floor(s * xs[i] + c * ys[i] + off)]++;
    let sum = 0;
    for (let i = 0; i < rows.length; i++) sum += rows[i] * rows[i];
    return sum;
  };
  const best = (from, to, by) => {
    let at = 0;
    let top = -1;
    for (let d = from; d <= to + 1e-9; d += by) {
      const v = score(d);
      if (v > top + 1e-9 || (Math.abs(v - top) <= 1e-9 && Math.abs(d) < Math.abs(at))) {
        top = v;
        at = d;
      }
    }
    return at;
  };
  const coarse = best(-range, range, 0.5);
  return normTilt(best(coarse - 0.5, coarse + 0.5, 0.05));
}

// Luminance from RGBA pixels (a canvas's ImageData).
export function luminance(rgba) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  return out;
}

// Which pages "This page", "All", "Odd" and "Even" mean, as indexes into
// pages ([{ num }]); index is the page being adjusted. Odd and even go by the
// page's number in its PDF.
export function pagesFor(scope, pages, index) {
  const all = pages.map((_, i) => i);
  if (scope === 'all') return all;
  if (scope === 'odd') return all.filter((i) => pages[i].num % 2 === 1);
  if (scope === 'even') return all.filter((i) => pages[i].num % 2 === 0);
  return [index];
}
