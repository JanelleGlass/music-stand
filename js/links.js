// Links that open a score at a page or a piece, from outside the app (a
// curriculum map, a note in another app):
//
//   #/open/<score>?page=<n>       the score at page n of its PDF
//   #/open/<score>?piece=<what>   the score at an Index entry: its number
//                                 (?piece=2) or its title (?piece=Lightly%20Row)
//   #/open/<score>                the score, where it was left
//
// The score and the values are URL-encoded. No DOM here, unit tested
// (tests/links.test.mjs).
import { fold, findHymn, searchEntries, sortEntries } from './index-logic.js';

const PREFIX = '#/open/';

// What a link asks for: { score, page } or { score, piece } or { score };
// null if the address isn't a link of this kind.
export function parseOpenHash(hash) {
  const h = String(hash || '');
  if (!h.startsWith(PREFIX)) return null;
  const rest = h.slice(PREFIX.length);
  const q = rest.indexOf('?');
  let score;
  try {
    score = decodeURIComponent((q < 0 ? rest : rest.slice(0, q)).replace(/\+/g, ' ')).trim();
  } catch {
    return null;
  }
  if (!score) return null;
  const out = { score };
  if (q >= 0) {
    const params = new URLSearchParams(rest.slice(q + 1));
    const page = Math.round(Number(params.get('page')));
    const piece = (params.get('piece') || '').trim();
    if (params.has('page') && page >= 1) out.page = page;
    else if (piece) out.piece = piece;
  }
  return out;
}

// A score's name as it goes in a link: without ".pdf".
export function linkName(name) {
  return String(name || '').replace(/\.pdf$/i, '').trim();
}

// The link to a score (place: { page } or { piece }). base is the app's
// address without its #part.
export function buildLink(base, name, place = {}) {
  let out = `${base}${PREFIX}${encodeURIComponent(linkName(name))}`;
  if (place.page) out += `?page=${Math.round(place.page)}`;
  else if (place.piece != null && String(place.piece).trim()) out += `?piece=${encodeURIComponent(String(place.piece).trim())}`;
  return out;
}

const key = (name) => fold(linkName(name));

// The score a link names, among files ([{ id, name }]): the one whose name
// is the same (case, accents, punctuation and a trailing .pdf aside), or
// else the only one whose name holds it. Returns { file } when there's one
// (with exact: true when it has that very name),
// { choices: [files] } when several match, or { choices: [] } for none.
export function findScore(files, name) {
  const want = key(name);
  if (!want) return { choices: [] };
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
  const same = files.filter((f) => key(f.name) === want);
  if (same.length === 1) return { file: same[0], exact: true };
  if (same.length > 1) return { choices: same.sort(byName) };
  const holding = files.filter((f) => key(f.name).includes(want));
  if (holding.length === 1) return { file: holding[0] };
  return { choices: holding.sort(byName) };
}

// The Index entry a link names (entries as js/index-logic.js has them). A
// number finds the entry with that number; words find the entry with that
// title, or else the best match for them. Null if nothing fits; a number
// that no entry has never stands for another one.
export function findPiece(entries, query) {
  const q = fold(query);
  if (!q) return null;
  const numbered = findHymn(entries, query);
  if (numbered) return numbered;
  const titled = sortEntries(entries.filter((e) => fold(e.title) === q));
  if (titled.length) return titled[0];
  if (/^\d+[a-z]?$/.test(q.replace(/\s+/g, ''))) return null;
  return searchEntries(entries, query)[0] || null;
}

// What a link to an Index entry says: its title, when no other entry has
// that title, or else its number.
export function pieceKey(entries, entry) {
  const t = fold(entry.title);
  if (t && entries.filter((e) => fold(e.title) === t).length === 1 && !findHymn(entries, entry.title)) return entry.title;
  return entry.kind === 'hymn' ? entry.n : entry.title;
}
