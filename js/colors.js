// The colours of the pen and highlighter: the built-in ones, the person's own
// list (colours they saved or removed), and the one in use. No DOM here
// (unit tested).
//
// Settings keep penColors and hlColors (null until the list is changed, so
// the built-in colours are used), and penColor, hlColor and textColor as
// '#rrggbb'. Versions before 1.11.0 kept the colour in use as a number, its
// place in the built-in list; those still work.

export const PEN_COLORS = ['#1d1d1f', '#d0312d', '#1f5fd1', '#2a8a3e', '#e07a10'];
export const HL_COLORS = ['#ffd60a', '#5be36b', '#ff7eb6', '#5ac8fa'];

const NAMES = {
  '#1d1d1f': 'Black', '#d0312d': 'Red', '#1f5fd1': 'Blue', '#2a8a3e': 'Green', '#e07a10': 'Orange',
  '#ffd60a': 'Yellow', '#5be36b': 'Green', '#ff7eb6': 'Pink', '#5ac8fa': 'Blue',
};

const DEFAULTS = { pen: PEN_COLORS, hl: HL_COLORS };
const LIST_KEY = { pen: 'penColors', hl: 'hlColors' };

// '#rrggbb' from what was typed or picked ('#ABC', 'abc', ' 12ab9f '), or null.
export function normalHex(s) {
  const m = /^\s*#?([0-9a-f]{3}|[0-9a-f]{6})\s*$/i.exec(String(s ?? ''));
  if (!m) return null;
  const h = m[1].toLowerCase();
  return '#' + (h.length === 3 ? h.replace(/./g, '$&$&') : h);
}

// The setting that keeps the pen's or highlighter's list.
export function listKey(kind) {
  return LIST_KEY[kind];
}

// The colours offered for 'pen' (also typed notes) or 'hl'.
export function palette(s, kind) {
  const saved = s && s[LIST_KEY[kind]];
  if (!Array.isArray(saved)) return DEFAULTS[kind].slice();
  const out = [];
  for (const c of saved) {
    const h = normalHex(c);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

// The colour in use: key is 'penColor', 'hlColor' or 'textColor'.
export function chosen(s, key) {
  const defaults = key === 'hlColor' ? HL_COLORS : PEN_COLORS;
  const v = s && s[key];
  if (typeof v === 'number') return defaults[v] || defaults[0];
  return normalHex(v) || defaults[0];
}

// The list with the colour added at the end (once).
export function withColor(list, hex) {
  const h = normalHex(hex);
  if (!h || list.includes(h)) return list.slice();
  return [...list, h];
}

// The list without the colour. The last colour stays.
export function withoutColor(list, hex) {
  const h = normalHex(hex);
  const out = list.filter((c) => c !== h);
  return out.length ? out : list.slice();
}

// True when the list is the built-in one.
export function isBuiltIn(list, kind) {
  const d = DEFAULTS[kind];
  return list.length === d.length && list.every((c, i) => c === d[i]);
}

// A name for reading aloud: the built-in colour's, or its code.
export function colorName(hex) {
  return NAMES[hex] || `Colour ${hex}`;
}
