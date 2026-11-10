// Drawing markings as SVG, and finding the marking under the eraser. No
// IndexedDB here. Coordinates are page units: the page is 1000 wide, so
// markings keep their place and size at every zoom.
//
// Each page with markings has two <svg> layers over its canvas: highlighter
// strokes underneath (blended into the paper), pen strokes on top. The
// stroke being drawn has a third, small layer of its own, so the finished
// strokes aren't redrawn while it grows.

import { PEN_COLORS, HL_COLORS } from './colors.js';

export const PAGE_W = 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Stored colours are the day colours; night mode draws the pen in lighter
// ones so it shows on the dark page (the person's own colours, js/colors.js,
// mixed towards white).
export const PENS = {
  colors: PEN_COLORS,
  night: ['#f2f2f2', '#ff7a70', '#86b4ff', '#6fdc84', '#ffb35c'],
  widths: [1.4, 2.6, 4.4],
};
export const HIGHLIGHTERS = {
  colors: HL_COLORS,
  width: 16,
};

const round = (n) => Math.round(n * 10) / 10;

// The colour to draw a stroke in.
export function inkColor(s, night) {
  if (!night || s.tool === 'hl') return s.color;
  const i = PENS.colors.indexOf(String(s.color).toLowerCase());
  if (i >= 0) return PENS.night[i];
  return lighten(s.color);
}

// A colour not in the palette: mixed most of the way to white.
function lighten(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return '#f2f2f2';
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.65).toString(16).padStart(2, '0');
  return `#${mix(n >> 16)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

// A smooth path through the points: straight to the first midpoint, then
// curves through each point to the next midpoint. One point is a dot.
export function pathData(pts) {
  const n = pts.length / 2;
  if (!n) return '';
  if (n === 1) return `M${pts[0]} ${pts[1]}l0.01 0`;
  let d = `M${pts[0]} ${pts[1]}`;
  if (n === 2) return `${d}L${pts[2]} ${pts[3]}`;
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    d += `Q${x} ${y} ${round((x + pts[i * 2 + 2]) / 2)} ${round((y + pts[i * 2 + 3]) / 2)}`;
  }
  return `${d}L${pts[pts.length - 2]} ${pts[pts.length - 1]}`;
}

// The page's size in the PDF (pw × ph); h and w in older callers.
const paperW = (page) => page.pw || page.w;
const paperH = (page) => page.ph || page.h;

function svgLayer(page, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `ink ${cls}`);
  svg.setAttribute('viewBox', `0 0 ${PAGE_W} ${round((PAGE_W * paperH(page)) / paperW(page))}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  placeLayer(svg, page);
  return svg;
}

// Sizes a layer to the whole page and crops and turns it as the page shows
// (page.inkBox, from the viewer). Without one it fills the page element.
export function placeLayer(svg, page) {
  const b = page.inkBox;
  const s = svg.style;
  s.width = b ? b.width + 'px' : '';
  s.height = b ? b.height + 'px' : '';
  s.transform = b ? b.transform : '';
}

// The two layers of a page, added to its element.
export function makeLayers(page) {
  const layers = { hl: svgLayer(page, 'ink-hl'), pen: svgLayer(page, 'ink-pen') };
  page.el.append(layers.hl, layers.pen);
  return layers;
}

export function removeLayers(layers) {
  layers.hl.remove();
  layers.pen.remove();
}

export function liveLayer(page) {
  const svg = svgLayer(page, 'ink-live');
  page.el.appendChild(svg);
  return svg;
}

export function strokeEl(s, night) {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', pathData(s.pts));
  p.setAttribute('stroke', inkColor(s, night));
  p.setAttribute('stroke-width', String(s.w));
  if (s.id) p.dataset.id = s.id;
  return p;
}

// Puts a page's strokes into its layers, in drawing order.
export function drawAll(layers, strokes, night) {
  const hl = [];
  const pen = [];
  for (const s of strokes) (s.tool === 'hl' ? hl : pen).push(strokeEl(s, night));
  layers.hl.replaceChildren(...hl);
  layers.pen.replaceChildren(...pen);
}

export function removeStrokeEl(layers, id) {
  for (const svg of [layers.hl, layers.pen]) {
    const el = svg.querySelector(`path[data-id="${CSS.escape(id)}"]`);
    if (el) el.remove();
  }
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function crosses(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by);
}

function segmentsClose(ax, ay, bx, by, cx, cy, dx, dy, r) {
  return distToSegment(cx, cy, ax, ay, bx, by) <= r || distToSegment(dx, dy, ax, ay, bx, by) <= r ||
    distToSegment(ax, ay, cx, cy, dx, dy) <= r || distToSegment(bx, by, cx, cy, dx, dy) <= r || crosses(ax, ay, bx, by, cx, cy, dx, dy);
}

// Whether a stroke passes within reach (page units) of the eraser's path
// from (x0, y0) to (x1, y1). The eraser sweeps, so fast moves skip nothing.
export function touches(s, x0, y0, x1, y1, reach) {
  const pts = s.pts;
  const r = reach + s.w / 2;
  if (pts.length === 2) return distToSegment(pts[0], pts[1], x0, y0, x1, y1) <= r;
  for (let j = 0; j + 3 < pts.length; j += 2) {
    if (segmentsClose(pts[j], pts[j + 1], pts[j + 2], pts[j + 3], x0, y0, x1, y1, r)) return true;
  }
  return false;
}

// What the eraser takes: pen strokes it touches, or, where it touches no pen
// stroke, highlighter strokes (a fingering written over a highlight goes
// without the highlight).
export function strokesToErase(strokes, x0, y0, x1, y1, reach) {
  const hit = strokes.filter((s) => touches(s, x0, y0, x1, y1, reach));
  const pens = hit.filter((s) => s.tool !== 'hl');
  return pens.length ? pens : hit;
}

// Keeps a point only once it is minGap from the last kept one.
export function decimate(pts, x, y, minGap) {
  const n = pts.length;
  if (n >= 2 && Math.hypot(x - pts[n - 2], y - pts[n - 1]) < minGap) return false;
  pts.push(x, y);
  return true;
}

// Ramer–Douglas–Peucker: drops points that lie within tolerance of the line
// through their neighbours, then rounds to 0.1.
export function simplify(pts, tolerance) {
  const n = pts.length / 2;
  if (n <= 2) return pts.map(round);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let far = 0;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i * 2], pts[i * 2 + 1], pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1]);
      if (d > far) { far = d; worst = i; }
    }
    if (worst >= 0 && far > tolerance) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(round(pts[i * 2]), round(pts[i * 2 + 1]));
  return out;
}
