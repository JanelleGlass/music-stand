// Rules for combining two copies of a score's notes, or of a folder, made on
// different devices (Google Drive sync, backup Merge). No DOM, IndexedDB or
// network here, so they can be unit tested (tests/notes-merge.test.mjs).
import { mergeView } from './page-view.js';
//
// Every rule is commutative, associative and idempotent: combining copies in
// any order, any number of times, gives the same result, so devices agree
// however their syncs interleave.

// ---- Notes ----
//
// A page's notes: { strokes: [stroke], erased: [strokeId], view? }. A stroke
// never changes once drawn: { id, at, tool, color, w, pts }. Erasing one keeps
// its id in erased, so the erase reaches copies that still have the stroke.
// view is how the page is cropped and turned (js/page-view.js): the newer
// setting wins.

const byTime = (a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Both copies' strokes, minus every stroke either copy erased.
export function mergePage(a, b) {
  const erased = new Set([...((a && a.erased) || []), ...((b && b.erased) || [])]);
  const strokes = new Map();
  for (const s of [...((a && a.strokes) || []), ...((b && b.strokes) || [])]) {
    if (s && s.id && !erased.has(s.id) && !strokes.has(s.id)) strokes.set(s.id, s);
  }
  const out = { strokes: [...strokes.values()].sort(byTime), erased: [...erased].sort() };
  const view = mergeView(a && a.view, b && b.view);
  if (view) out.view = view;
  const marks = mergeMarks(a && a.marks, b && b.marks);
  if (marks.length) out.marks = marks;
  return out;
}

export function pageIsEmpty(p) {
  return !p || (!(p.strokes && p.strokes.length) && !(p.erased && p.erased.length) && !p.view && !(p.marks && p.marks.length));
}

// ---- Index marks ----
//
// A page's index marks (js/index-logic.js): where a hymn or a section
// starts, and the tap areas drawn on a printed index. Each mark has an id
// and when it was last changed (at); a change replaces the whole mark, and
// the newer one wins. A deleted mark stays as { id, at, gone: true }, so the
// delete reaches copies that still have it. On a tie, a delete wins, then
// the same copy on every device.
//   hymn     { kind: 'hymn', n: '245', title, y }
//   section  { kind: 'section', title, y }
//   link     { kind: 'link', box: [x, y, w, h], hymn: '245' } or { ..., page: 12 }
// y is how far down the page it starts (0 to 1, of the page as it shows);
// box is in the page's own units, as markings are (js/ink-draw.js).

const MAX_TEXT = 200;
const text = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const r4 = (n) => Math.round(n * 10000) / 10000;

export function normMark(m) {
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return null;
  const at = Number(m.at) || 0;
  if (m.gone) return { id: m.id, at, gone: true };
  const y = r4(Math.max(0, Math.min(1, Number(m.y) || 0)));
  if (m.kind === 'hymn') {
    const n = text(m.n);
    return n ? { id: m.id, at, kind: 'hymn', n, title: text(m.title), y } : null;
  }
  if (m.kind === 'section') {
    const title = text(m.title);
    return title ? { id: m.id, at, kind: 'section', title, y } : null;
  }
  if (m.kind === 'link') {
    const b = Array.isArray(m.box) && m.box.length === 4 && m.box.every((v) => typeof v === 'number' && Number.isFinite(v)) ? m.box : null;
    if (!b || b[2] <= 0 || b[3] <= 0) return null;
    const box = b.map((v) => Math.round(v * 10) / 10);
    const hymn = text(m.hymn);
    if (hymn) return { id: m.id, at, kind: 'link', box, hymn };
    const page = Math.round(Number(m.page));
    return page >= 1 ? { id: m.id, at, kind: 'link', box, page } : null;
  }
  return null;
}

function newerMark(a, b) {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  if (!!a.gone !== !!b.gone) return a.gone ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

// Both copies' marks, by id: the newer change of each.
export function mergeMarks(a, b) {
  const out = new Map();
  for (const raw of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const m = normMark(raw);
    if (!m) continue;
    const prev = out.get(m.id);
    out.set(m.id, prev ? newerMark(prev, m) : m);
  }
  return [...out.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

// Stamps marks as changed just now (a backup restored with Replace), so
// they win over older changes on other devices.
export function restampMarks(marks, at) {
  return mergeMarks(marks, null).map((m) => ({ ...m, at: Math.max(at, m.at + 1) }));
}

// A score's notes: { pages: { "<page>": page } }.
export function mergeNotes(a, b) {
  const pages = {};
  const keys = new Set([...Object.keys((a && a.pages) || {}), ...Object.keys((b && b.pages) || {})]);
  for (const k of [...keys].sort((x, y) => x - y)) {
    const p = mergePage(a && a.pages && a.pages[k], b && b.pages && b.pages[k]);
    if (!pageIsEmpty(p)) pages[k] = p;
  }
  return { pages };
}

// ---- Zoom ----
//
// A score's zoom (scrolling: the share of the screen's width a page takes):
// { zoom, at }. The newer setting wins; on a tie, the larger zoom.

export function normZoom(z) {
  if (!z || typeof z !== 'object') return null;
  const zoom = Number(z.zoom);
  const at = Number(z.at) || 0;
  if (!Number.isFinite(zoom) || !at) return null;
  return { zoom: Math.round(Math.max(0.3, Math.min(1, zoom)) * 1000) / 1000, at };
}

export function mergeZoom(a, b) {
  a = normZoom(a);
  b = normZoom(b);
  if (!a || !b) return a || b;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return a.zoom >= b.zoom ? a : b;
}

// Zooms by score: { <score>: { zoom, at } }.
export function mergeZooms(a = {}, b = {}) {
  const out = {};
  for (const k of [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort()) {
    const z = mergeZoom((a || {})[k], (b || {})[k]);
    if (z) out[k] = z;
  }
  return out;
}

// ---- Folders ----
//
// A folder: { id, name, nameAt, createdAt, deleted, deletedAt,
// members: [{ score, in, at }] }. Each part is "the newer change wins": the
// name (nameAt), whether the folder is deleted (deletedAt is when that last
// changed, so restoring a backup can bring a folder back), and each score's
// place in it (at). On a tie, a removal or a delete wins, and names are
// compared as text, so every device picks the same.

function newer(a, b, aAt, bAt, tie) {
  if (aAt !== bAt) return aAt > bAt ? a : b;
  return tie(a, b) ? a : b;
}

export function mergeFolder(a, b) {
  if (!a) return normaliseFolder(b);
  if (!b) return normaliseFolder(a);
  a = normaliseFolder(a);
  b = normaliseFolder(b);
  const named = newer(a, b, a.nameAt, b.nameAt, (x, y) => x.name <= y.name);
  const state = newer(a, b, a.deletedAt, b.deletedAt, (x) => x.deleted);
  const members = new Map();
  for (const m of [...a.members, ...b.members]) {
    const prev = members.get(m.score);
    members.set(m.score, prev ? newer(prev, m, prev.at, m.at, (x) => !x.in) : m);
  }
  return normaliseFolder({
    id: a.id,
    name: named.name,
    nameAt: named.nameAt,
    createdAt: Math.min(a.createdAt, b.createdAt),
    deleted: state.deleted,
    deletedAt: state.deletedAt,
    members: [...members.values()],
  });
}

const textOrder = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

export function normaliseFolder(f) {
  if (!f) return f;
  // The first version kept a list of entries ({ fileId }) instead.
  const list = Array.isArray(f.members) ? f.members
    : Array.isArray(f.entries) ? f.entries.map((e, i) => ({ score: e && e.fileId, in: true, at: i + 1 })) : [];
  // One entry per score (two copies of a PDF can fold into one score).
  const one = new Map();
  for (const m of list) {
    if (!m || m.score == null) continue;
    const e = { score: String(m.score), in: !!m.in, at: Number(m.at) || 0 };
    const prev = one.get(e.score);
    one.set(e.score, prev ? newer(prev, e, prev.at, e.at, (x) => !x.in) : e);
  }
  const members = [...one.values()].sort((x, y) => textOrder(x.score, y.score));
  return {
    id: String(f.id),
    name: String(f.name || ''),
    nameAt: Number(f.nameAt) || 0,
    createdAt: Number(f.createdAt) || 0,
    deleted: !!f.deleted,
    deletedAt: Number(f.deletedAt) || 0,
    members,
  };
}

// Lists of folders, combined by id.
export function mergeFolders(a = [], b = []) {
  const out = new Map();
  for (const f of [...(a || []), ...(b || [])]) {
    if (!f || f.id == null) continue;
    const id = String(f.id);
    out.set(id, out.has(id) ? mergeFolder(out.get(id), f) : normaliseFolder(f));
  }
  return [...out.values()].sort((x, y) => textOrder(x.id, y.id));
}

// Stamps a folder as just changed in every part (a backup being restored
// with Replace), so it wins over older changes on other devices.
export function restampFolder(f, at) {
  const n = normaliseFolder(f);
  return {
    ...n,
    nameAt: Math.max(at, n.nameAt + 1),
    deletedAt: Math.max(at, n.deletedAt + 1),
    // Same order as before (a folder's order is its members' times).
    members: [...n.members].sort((x, y) => x.at - y.at).map((m, i) => ({ ...m, at: Math.max(at, m.at + 1) + i }))
      .sort((x, y) => textOrder(x.score, y.score)),
  };
}

// The same content, whatever order it was built in. Merged values are already
// sorted, so their JSON is a fair comparison.
export function sameContent(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A short fingerprint of some content, to tell later whether it changed.
export async function fingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(h).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
