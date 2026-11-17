// Finding where each hymn of a hymnal starts, from the numbers printed on
// its pages (read by text recognition, js/ocr.js). No DOM, unit tested
// (tests/hymn-find.test.mjs). The Index panel (js/index-ui.js) reads the
// pages and moves the hymns.
//
// What a page holds for this (pageNumbers): the size it was read at (w, h,
// px), the usual height of its words (mh, px: the lyrics and titles), and
// its words that are numbers, nums: [[n, x0, y0, x1, y1]] (px).
//
// A hymnal prints a hymn's number bigger than the words around it, at the
// top of the hymn, and the numbers go up through the book. So: of the
// numbers clearly bigger than the words, the longest run going up through
// the book marks where hymns start. Those show how big this book prints its
// hymn numbers and where across the page; the numbers of that size and in
// that place make the run again, catching the ones the first look missed
// and leaving out verse numbers, time signatures, "(continued)" headings
// and the like. Hymns still missing between two found ones are spaced
// evenly between them when the pages work out (one a page, two...).
import { compareNumbers } from './index-logic.js';

const BIG = [1.5, 1.25]; // first look: this many times the words' height (the second if the first finds few)
const MIN_REL = 1.1; // never a hymn number when not this much bigger than the words
const AT_TOP = 0.12; // a hymn whose number is this near the top of the paper starts with the page
const ABOVE = 0.015; // of the page above its number a hymn starting lower down starts
const ZONE = 0.1; // width of the strips across the page the numbers' places are counted in
const SAME_Y = 0.03; // places on a page this close are the same

// The words of a page as Tesseract's TSV has them: [{ text, x0, y0, x1, y1 }]
// (px).
export function parseTsv(tsv) {
  const out = [];
  for (const line of String(tsv || '').split('\n')) {
    const c = line.split('\t');
    if (c[0] !== '5' || c.length < 12) continue;
    const text = c.slice(11).join('\t').trim();
    const [x, y, w, h] = c.slice(6, 10).map(Number);
    if (text && [x, y, w, h].every(Number.isFinite)) out.push({ text, x0: x, y0: y, x1: x + w, y1: y + h });
  }
  return out;
}

// The number a word is, as a hymn number ("245", "245a"), or ''. Stray marks
// around it go ("245.", "(245)", "“3"), and in a number of two or more
// characters, letters text recognition mistakes for digits count as them
// ("1O5" is 105, "l2" is 12).
const LOOKALIKE = { O: '0', o: '0', D: '0', I: '1', l: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };
export function numberOf(text) {
  const s = String(text || '').replace(/^[^\p{L}\p{N}|]+|[^\p{L}\p{N}]+$/gu, '');
  let m = /^(\d{1,4})([a-z])?$/.exec(s);
  if (!m && s.length >= 2 && s.length <= 4 && /\d/.test(s) && [...s].every((ch) => /\d/.test(ch) || LOOKALIKE[ch])) {
    const digits = [...s].filter((ch) => /\d/.test(ch)).length;
    if (digits * 2 >= s.length) m = [s, [...s].map((ch) => LOOKALIKE[ch] || ch).join(''), ''];
  }
  if (!m) return '';
  const n = Number(m[1]);
  return n > 0 ? `${n}${m[2] || ''}` : '';
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// What a page read with its words keeps for finding hymns (see the top).
export function pageNumbers(words, w, h) {
  // Its words: three letters or more, and mostly letters (not a stave read as "——t+——eo").
  const isWord = (t) => {
    const letters = (t.match(/\p{L}/gu) || []).length;
    return letters >= 3 && letters >= t.length * 0.7;
  };
  const mh = median(words.filter((x) => isWord(x.text)).map((x) => x.y1 - x.y0));
  const nums = [];
  for (const x of words) {
    const n = numberOf(x.text);
    if (n && x.y1 - x.y0 >= 6) nums.push([n, Math.round(x.x0), Math.round(x.y0), Math.round(x.x1), Math.round(x.y1)]);
  }
  return { w: Math.round(w), h: Math.round(h), mh: Math.round(mh), nums };
}

// The hymn numbers to look for, in order: from to to, and the index's own
// numbers in that range with a letter (245a).
export function wantedNumbers(entries, from, to) {
  const lo = Math.max(1, Math.round(Number(from)));
  const hi = Math.round(Number(to));
  const out = new Set();
  for (let n = lo; n <= hi; n++) out.add(String(n));
  for (const e of entries) {
    if (e.kind !== 'hymn') continue;
    const m = /^(\d+)[a-z]$/i.exec(String(e.n).trim());
    if (m && Number(m[1]) >= lo && Number(m[1]) <= hi) out.add(String(e.n).trim().toLowerCase());
  }
  return [...out].sort(compareNumbers);
}

const before = (a, b) => a.index < b.index || (a.index === b.index && a.y < b.y - 1e-9);

// The longest run of candidates whose hymns come in order (by rank) through
// the book (by place). Where a number shows twice, the first one counts.
function longestRun(cands, size) {
  const tree = new Array(size + 1).fill(null); // Fenwick tree over ranks: the best run ending at or below
  const better = (a, b) => b && (!a || b.len > a.len);
  const query = (r) => {
    let best = null;
    for (let i = r; i > 0; i -= i & -i) if (better(best, tree[i])) best = tree[i];
    return best;
  };
  const update = (r, node) => {
    for (let i = r; i <= size; i += i & -i) if (better(tree[i], node)) tree[i] = node;
  };
  const sorted = [...cands].sort((a, b) => a.index - b.index || a.y - b.y || a.r - b.r);
  let best = null;
  // Candidates at the same place mustn't follow each other: done a place at a time.
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j].index === sorted[i].index && sorted[j].y === sorted[i].y) j++;
    const nodes = sorted.slice(i, j).map((c) => {
      const prev = query(c.r); // ranks below c's (Fenwick is 1-based: rank r is slot r + 1)
      return { c, len: (prev ? prev.len : 0) + 1, prev };
    });
    for (const node of nodes) {
      update(node.c.r + 1, node);
      if (better(best, node)) best = node;
    }
    i = j;
  }
  const run = [];
  for (let node = best; node; node = node.prev) run.push(node.c);
  return run.reverse();
}

// Where a place on the paper (a fraction down it, as read) is on the page as
// shown: crop is [top, height] of the part shown, as fractions.
const shownY = (y, crop) => Math.max(0, Math.min(1, (y - crop[0]) / crop[1]));

// Where the hymns start: pages [{ index, w, h, mh, nums, crop? }] (index:
// the page's place in the viewer; crop: [top, height] shown), wanted: the
// numbers in order (wantedNumbers). Returns a Map from each wanted number
// to { how, index, y, after, before }: how is 'found' (its number is
// there), 'guessed' (spaced between the found hymns either side) or 'none';
// index and y (0 to 1 down the page as shown) say where, but for 'none';
// after and before are the places of the found hymns either side (null at
// the ends).
export function findHymnStarts(pages, wanted) {
  const rank = new Map(wanted.map((n, i) => [String(n).toLowerCase(), i]));
  const cands = [];
  for (const p of pages) {
    if (!p || !p.h || !p.w) continue;
    const mh = p.mh || p.h * 0.011; // no words: as a hymnal's lyrics usually are
    const crop = p.crop || [0, 1];
    for (const [n, x0, y0, x1, y1] of p.nums || []) {
      const r = rank.get(String(n).toLowerCase());
      if (r === undefined) continue;
      const top = y0 / p.h;
      const start = top < AT_TOP ? 0 : shownY(Math.max(0, top - ABOVE), crop);
      cands.push({ r, n: wanted[r], index: p.index, y: start, rel: (y1 - y0) / mh, size: (y1 - y0) / p.h, x: (x0 + x1) / 2 / p.w });
    }
  }
  // A first look at the clearly big numbers.
  let anchors = [];
  for (const big of BIG) {
    anchors = longestRun(cands.filter((c) => c.rel >= big), wanted.length);
    if (anchors.length >= Math.max(3, wanted.length * 0.2)) break;
  }
  // How big this book prints them, and where across the page.
  let fits = (c) => c.rel >= BIG[BIG.length - 1];
  if (anchors.length >= 3) {
    const rel = median(anchors.map((c) => c.rel));
    const size = median(anchors.map((c) => c.size));
    let places = null; // strips across the page (with enough found to tell)
    if (anchors.length >= 8) {
      const zones = new Map();
      for (const c of anchors) {
        const z = Math.floor(c.x / ZONE);
        zones.set(z, (zones.get(z) || 0) + 1);
      }
      places = new Set();
      for (const [z, count] of zones) {
        if (count >= Math.max(2, anchors.length * 0.05)) [z - 1, z, z + 1].forEach((k) => places.add(k));
      }
    }
    fits = (c) => c.rel >= Math.max(MIN_REL, rel * 0.7) && c.size >= size * 0.6 && c.size <= size * 1.6 && (!places || places.has(Math.floor(c.x / ZONE)));
  }
  const found = longestRun(cands.filter(fits), wanted.length);

  const out = new Map(wanted.map((n) => [n, { how: 'none', index: null, y: null, after: null, before: null }]));
  for (const c of found) out.set(c.n, { how: 'found', index: c.index, y: c.y, after: null, before: null });
  // Between two found hymns: where the ones missing must be, and maybe are.
  const at = (c) => (c ? { index: c.index, y: c.y } : null);
  const ends = [null, ...found, null];
  for (let i = 0; i + 1 < ends.length; i++) {
    const a = ends[i];
    const b = ends[i + 1];
    const lo = a ? a.r + 1 : 0;
    const hi = b ? b.r - 1 : wanted.length - 1;
    const k = hi - lo + 1;
    if (k <= 0) continue;
    const span = a && b ? b.index - a.index : 0;
    // Pages that share out evenly (one a page, two...): there. Otherwise, at
    // least between them, spread out as the pages allow.
    const step = a && b && a.y === 0 && b.y === 0 && span % (k + 1) === 0 ? span / (k + 1) : 0;
    for (let r = lo; r <= hi; r++) {
      const j = r - lo + 1;
      let guess = { how: 'none', index: null, y: null };
      if (step >= 1 && step <= 4) guess = { how: 'guessed', index: a.index + j * step, y: 0 };
      else if (span >= 2) guess = { how: 'guessed', index: Math.max(a.index + 1, Math.min(b.index - 1, a.index + Math.round((span * j) / (k + 1)))), y: 0 };
      out.set(wanted[r], { ...guess, after: at(a), before: at(b) });
    }
  }
  return out;
}

// What finding does to the index: for each wanted number, its entry (or
// none), and what happens to it. action: 'add' (not in the index: put
// where found), 'move', 'same' (already there), 'keep' (not found; where
// it is fits between its neighbours, or there's nowhere better) or
// 'missing' (not found, not in the index). to: where it goes.
export function hymnChanges(entries, wanted, places) {
  const hymns = new Map();
  for (const e of entries) {
    if (e.kind !== 'hymn') continue;
    const k = String(e.n).trim().toLowerCase();
    if (!hymns.has(k)) hymns.set(k, e);
  }
  const out = [];
  for (const n of wanted) {
    const e = hymns.get(String(n).toLowerCase()) || null;
    const p = places.get(n) || { how: 'none' };
    const to = p.index != null ? { index: p.index, y: p.y } : null;
    let action;
    if (!e) action = to ? 'add' : 'missing';
    else if (p.how === 'found') action = e.index === to.index && Math.abs((e.y || 0) - to.y) < SAME_Y ? 'same' : 'move';
    else {
      const here = { index: e.index, y: e.y || 0 };
      const fits = (!p.after || before(p.after, here)) && (!p.before || before(here, p.before));
      action = fits || !to ? 'keep' : e.index === to.index && Math.abs((e.y || 0) - to.y) < SAME_Y ? 'same' : 'move';
    }
    out.push({ n, how: p.how, action, entry: e, to });
  }
  return out;
}

// Hymn numbers for a message: runs of three or more shortened ("3, 17–20,
// 45"), at most max parts, then "…".
export function shortList(ns, max = 12) {
  const parts = [];
  for (let i = 0; i < ns.length;) {
    let j = i;
    while (j + 1 < ns.length && /^\d+$/.test(ns[j]) && /^\d+$/.test(ns[j + 1]) && Number(ns[j + 1]) === Number(ns[j]) + 1) j++;
    if (j - i >= 2) parts.push(`${ns[i]}–${ns[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(ns[k]));
    i = j + 1;
  }
  return parts.length > max ? `${parts.slice(0, max).join(', ')}…` : parts.join(', ');
}

// The pages to look at again, where a hymn still missing could start (from
// the found hymn before it to the one after): their indexes, in order. last:
// the index of the last page.
export function pagesToLookAgain(places, last) {
  const out = new Set();
  for (const p of places.values()) {
    if (p.how === 'found') continue;
    const from = p.after ? p.after.index : 0;
    const to = p.before ? p.before.index : last;
    for (let i = from; i <= to; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

// A page's numbers with a second look's added (made to the first's scale).
export function withSecondLook(rec, more) {
  const k = more && more.w ? rec.w / more.w : 1;
  const extra = more ? more.nums.map(([n, ...xy]) => [n, ...xy.map((v) => Math.round(v * k))]) : [];
  return { ...rec, second: true, nums: [...rec.nums, ...extra] };
}
