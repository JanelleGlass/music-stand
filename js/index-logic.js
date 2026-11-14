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

// Where a place in the music is among entries in the order of the music
// (sortEntries): the position of the last one at or before it, or -1 before
// the first.
export function placeIndex(sorted, index, y) {
  let at = -1;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.index < index || (e.index === index && e.y <= y + 1e-6)) at = i;
    else break;
  }
  return at;
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

// The steps hymn numbers go down the scroll bar by: every one, every 2nd,
// every 5th, 10th, 20th...
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
const FIT = 0.75; // a step fits when at least this share of its numbers do

// A hymn number as a whole number: "245" is 245; "245a" isn't one (0).
function wholeNumber(n) {
  const s = String(n ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : 0;
}

// The biggest step a hymn number is a multiple of (0 for none).
function roundness(n) {
  const v = wholeNumber(n);
  let best = 0;
  if (v) for (const s of STEPS) if (v % s === 0) best = s;
  return best;
}

// Which index labels go down the scroll bar, at least gap px apart: items
// { pos, kind, n } (pos in px). Sections first. Then hymn numbers at a round
// step, the smallest that fits: every one when there's room, or else every
// 2nd, 5th, 10th, 20th..., so the numbers on the bar are landmarks to steer
// by (20, 40, 60...) rather than whichever happened to fit. Where labels
// crowd, the rounder number stays (100 before 80). Returns the items kept,
// by pos.
export function pickLandmarks(items, gap) {
  const rank = (it) => (it.kind === 'section' ? 0 : 1 + STEPS.length - STEPS.indexOf(roundness(it.n)));
  const all = items.map((it) => ({ ...it, priority: rank(it) }));
  const sections = all.filter((it) => it.kind === 'section');
  const hymns = all.filter((it) => it.kind !== 'section');
  for (const step of STEPS) {
    const want = step === 1 ? hymns : hymns.filter((it) => wholeNumber(it.n) % step === 0 && wholeNumber(it.n) > 0);
    if (!want.length) continue;
    const kept = pickLabels([...sections, ...want], gap);
    if (kept.filter((it) => it.kind !== 'section').length >= want.length * FIT) return kept;
  }
  // Too crowded for any step: as many as fit, the roundest first.
  return pickLabels(all, gap);
}

// A list of hymns typed or pasted, one per line, as a printed index has
// them: "245 Amazing Grace", "245. Amazing grace", or "Amazing Grace ....
// 245". A line can hold more than one (an index in two columns, read by
// text recognition, comes a row at a time). Returns [{ n, title }]; lines
// without a number are left out.
const NUM = String.raw`\d{1,4}[a-z]?`;
const LEADERS = new RegExp(String.raw`(\p{L}[^\d]*?)(?:\s*[.·…•,_]){3,}\s*(${NUM})(?![\p{L}\d])`, 'giu');
const NUMBER_FIRST = new RegExp(String.raw`(?:^|\s)(${NUM})[.:)\]]?\s*[–—-]?\s+(\p{L}.*?)(?=\s${NUM}[.:)\]]?\s*[–—-]?\s+\p{L}|$)`, 'giu');
const TITLE_FIRST = new RegExp(String.raw`^(.*?\p{L}.*?)[\s.·…•,_–—-]+(${NUM})$`, 'iu');

export function parseTitleList(textIn) {
  const out = [];
  const push = (n, title) => {
    const t = cleanTitle(title);
    if (t && /\p{L}/u.test(t)) out.push({ n: n.toLowerCase(), title: t });
  };
  for (const raw of String(textIn || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const led = [...line.matchAll(LEADERS)];
    if (led.length) {
      for (const m of led) push(m[2], m[1]);
      continue;
    }
    if (/^\d/.test(line)) {
      const first = [...line.matchAll(NUMBER_FIRST)];
      if (first.length) {
        for (const m of first) push(m[1], m[2]);
        continue;
      }
    }
    const m = TITLE_FIRST.exec(line);
    if (m) push(m[2], m[1]);
  }
  return out;
}

function cleanTitle(s) {
  return s.replace(/[\s.·…•,_–—-]+$/, '').replace(/^[\s.:)\]–—-]+/, '').trim();
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

// ---- The words on the pages (read by text recognition, js/ocr.js) ----

// Words as a hymn prints them under the notes are split into syllables
// ("A - maz - ing grace"); joined back up, they can be searched.
export function joinSyllables(text) {
  return String(text || '')
    .replace(/(\p{L})[ \t]*[-–][ \t]+(?=\p{L})/gu, '$1')
    .replace(/(\p{L})[ \t]+[-–](?=\p{L})/gu, '$1')
    .replace(/(\p{L})-\r?\n\s*(?=\p{Ll})/gu, '$1');
}

// Bits of staff lines and notes that text recognition reads as letters
// ("—_——", "Ee", "TT"): left out of what a match shows.
const SHORT_WORDS = new Set(['TO', 'OF', 'IN', 'MY', 'BE', 'ON', 'IS', 'IT', 'AT', 'BY', 'HE', 'WE', 'US', 'SO', 'NO', 'GO', 'DO', 'ME', 'AN', 'AS', 'OR', 'UP', 'A', 'I', 'O']);
function isJunk(t) {
  const core = t.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '');
  if (!core) return true;
  if (/^[A-Z]{1,2}$/.test(core)) return !SHORT_WORDS.has(core);
  return /^[Ee]e+$/.test(core) || /^[EeIi]{2,}$/.test(core);
}

// Pages whose words hold every word searched for (each word may be the
// start of one on the page). pages: [{ index, num, text }]. Returns
// [{ index, num, snippet }] in page order, snippet being the words round
// the first match.
export function searchPages(pages, query, { around = 5 } = {}) {
  const words = fold(query).split(' ').filter((w) => w.length >= 2);
  if (!words.length) return [];
  const out = [];
  for (const p of pages) {
    const tokens = joinSyllables(p.text).split(/\s+/).filter(Boolean);
    const folded = tokens.map((t) => fold(t).replace(/\s+/g, ''));
    const has = (w) => folded.findIndex((t) => t.startsWith(w));
    const at = words.map(has);
    if (at.some((i) => i < 0)) continue;
    const first = Math.min(...at);
    const from = Math.max(0, first - around);
    const to = Math.min(tokens.length, first + around * 2);
    const words2 = tokens.slice(from, to).filter((t, i) => from + i === first || !isJunk(t));
    const snippet = `${from > 0 ? '… ' : ''}${words2.join(' ')}${to < tokens.length ? ' …' : ''}`;
    out.push({ index: p.index, num: p.num, snippet });
  }
  return out.sort((a, b) => a.index - b.index);
}
