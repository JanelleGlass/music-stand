// A score's index: where its hymns and sections start, searching them, and
// which of them label the scroll bar. No DOM, unit tested
// (tests/index-logic.test.mjs). The marks themselves, and how two devices'
// copies combine, are in js/notes-merge.js.
//
// An entry here is a hymn or section mark with the place it starts in the
// viewer: { ...mark, index, num }, index being the page's place in the
// viewer and num its page number in the PDF.

// Text as it's compared: lower case, without accents or punctuation.
export function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Hymn numbers in order: 9 before 10, and 245 before 245a.
export function compareNumbers(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// Entries in the order they come in the music; a section before a hymn
// starting at the same place.
export function sortEntries(entries) {
  const rank = (e) => (e.kind === 'section' ? 0 : 1);
  return [...entries].sort((a, b) => a.index - b.index || a.y - b.y || rank(a) - rank(b) || compareNumbers(a.n || a.title, b.n || b.title));
}

// The hymn with number n (as typed: " 245A " finds 245a).
export function findHymn(entries, n) {
  const want = fold(n).replace(/\s+/g, '');
  if (!want) return null;
  return entries.find((e) => e.kind === 'hymn' && fold(e.n).replace(/\s+/g, '') === want) || null;
}

// Entries matching what was typed, best first. A number finds that hymn
// first, then hymns whose numbers start with it; words find titles (and
// sections) holding every word, words that start a title first.
export function searchEntries(entries, query) {
  const q = fold(query);
  if (!q) return sortEntries(entries);
  const words = q.split(' ');
  const scored = [];
  for (const e of entries) {
    const num = e.kind === 'hymn' ? fold(e.n).replace(/\s+/g, '') : '';
    const title = fold(e.title);
    const hay = `${num} ${title}`;
    let score = -1;
    if (num && num === q.replace(/\s+/g, '')) score = 0;
    else if (num && words.length === 1 && num.startsWith(words[0])) score = 1;
    else if (words.every((w) => hay.split(' ').some((t) => t.startsWith(w)))) score = title.startsWith(words[0]) ? 2 : 3;
    else if (words.every((w) => hay.includes(w))) score = 4;
    if (score >= 0) scored.push({ e, score });
  }
  const order = new Map(sortEntries(entries).map((e, i) => [e, i]));
  scored.sort((a, b) => a.score - b.score || order.get(a.e) - order.get(b.e));
  return scored.map((s) => s.e);
}

// The last entry of this kind (or any) at or before a place in the music.
export function entryAt(entries, index, y = 1, kind = null) {
  let best = null;
  for (const e of sortEntries(entries)) {
    if (kind && e.kind !== kind) continue;
    if (e.index < index || (e.index === index && e.y <= y + 1e-6)) best = e;
    else break;
  }
  return best;
}

// The number a hymn added at this place most likely has: one more than the
// hymn before it (245 → 246, 245a → 246).
export function nextNumber(entries, index, y) {
  const before = entryAt(entries, index, y, 'hymn');
  const m = before && /^(\d+)/.exec(before.n);
  return m ? String(Number(m[1]) + 1) : '';
}

// What the scroll bar's label says for a place: the hymn there, or the
// section, if any.
export function placeLabel(entries, index, y) {
  const h = entryAt(entries, index, y, 'hymn');
  const s = entryAt(entries, index, y, 'section');
  // A section that starts after the hymn before it (the hymns of a new
  // section haven't begun yet) is the better name for the place.
  const sectionFirst = s && (!h || s.index > h.index || (s.index === h.index && s.y > h.y));
  if (sectionFirst) return s.title;
  if (h) return h.title ? `${h.n} ${h.title}` : `Hymn ${h.n}`;
  return '';
}

// Which labels fit down a track: items { pos, priority } (pos in px, lower
// priority goes first) at least gap px apart. Sections go before hymns, and
// among equals, the ones that come first. Returns the items kept, by pos.
export function pickLabels(items, gap) {
  const kept = [];
  const order = [...items].sort((a, b) => a.priority - b.priority || a.pos - b.pos);
  for (const it of order) {
    if (kept.every((k) => Math.abs(k.pos - it.pos) >= gap)) kept.push(it);
  }
  return kept.sort((a, b) => a.pos - b.pos);
}

// A list of hymns typed or pasted, one per line, as a printed index has
// them: "245 Amazing Grace", "245. Amazing grace", or "Amazing Grace ....
// 245". Returns [{ n, title }] (lines without a number are left out).
export function parseTitleList(textIn) {
  const out = [];
  for (const raw of String(textIn || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    let m = /^(\d{1,4}[a-z]?)\b[\s.:)\]–—-]*(.+)$/i.exec(line);
    if (m && /\p{L}/u.test(m[2])) {
      out.push({ n: m[1].toLowerCase(), title: cleanTitle(m[2]) });
      continue;
    }
    m = /^(.*?\p{L}.*?)[\s.·…–—-]+(\d{1,4}[a-z]?)$/iu.exec(line);
    if (m) out.push({ n: m[2].toLowerCase(), title: cleanTitle(m[1]) });
  }
  return out.filter((e) => e.title);
}

function cleanTitle(s) {
  return s.replace(/[\s.·…]+$/, '').replace(/^[\s.:)\]–—-]+/, '').trim();
}

// Hymns from..to, the first on page firstPage and each perPage pages after
// the one before, kept within the score's pages. Returns [{ n, num }].
export function hymnRun(from, to, firstPage, perPage, pageCount) {
  const a = Math.round(Number(from));
  const b = Math.round(Number(to));
  const p0 = Math.round(Number(firstPage));
  const step = Math.max(1, Math.round(Number(perPage) || 1));
  if (!(a >= 0) || !(b >= a) || !(p0 >= 1) || b - a > 5000) return [];
  const out = [];
  for (let n = a; n <= b; n++) {
    const num = p0 + (n - a) * step;
    if (num > pageCount) break;
    out.push({ n: String(n), num });
  }
  return out;
}

// Where a tap at (u, v) in page units falls among a page's tap areas: the
// smallest one holding it (with pad units to spare round each).
export function linkAt(links, u, v, pad = 0) {
  let best = null;
  for (const l of links) {
    const [x, y, w, h] = l.box;
    if (u >= x - pad && u <= x + w + pad && v >= y - pad && v <= y + h + pad && (!best || w * h < best.box[2] * best.box[3])) best = l;
  }
  return best;
}

// The rectangle between two corners, as [x, y, w, h].
export function boxBetween(x0, y0, x1, y1) {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
}
