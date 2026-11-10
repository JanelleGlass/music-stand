// Run with: node --test tests/colors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEN_COLORS, HL_COLORS, normalHex, palette, chosen, withColor, withoutColor, isBuiltIn, colorName, listKey } from '../js/colors.js';

test('normalHex reads typed and picked codes', () => {
  assert.equal(normalHex('#AABBCC'), '#aabbcc');
  assert.equal(normalHex('12ab9f'), '#12ab9f');
  assert.equal(normalHex(' #12AB9F '), '#12ab9f');
  assert.equal(normalHex('#abc'), '#aabbcc');
  assert.equal(normalHex('F0a'), '#ff00aa');
});

test('normalHex refuses what is not a colour code', () => {
  for (const s of ['', '#', '#12', '#1234', '#12345', '#1234567', 'red', '#ggg000', null, undefined, 12]) {
    assert.equal(normalHex(s), null, String(s));
  }
});

test('the built-in colours until the list is changed', () => {
  assert.deepEqual(palette({}, 'pen'), PEN_COLORS);
  assert.deepEqual(palette({ penColors: null }, 'pen'), PEN_COLORS);
  assert.deepEqual(palette({}, 'hl'), HL_COLORS);
  assert.notEqual(palette({}, 'pen'), PEN_COLORS); // a copy
});

test('a changed list is kept, cleaned up', () => {
  const s = { penColors: ['#1D1D1F', '#123456', 'nonsense', '#123456', 'abc'], hlColors: [] };
  assert.deepEqual(palette(s, 'pen'), ['#1d1d1f', '#123456', '#aabbcc']);
  assert.deepEqual(palette(s, 'hl'), []);
  assert.equal(listKey('pen'), 'penColors');
  assert.equal(listKey('hl'), 'hlColors');
});

test('the colour in use, from a code or (older versions) a place in the list', () => {
  assert.equal(chosen({ penColor: '#ABCDEF' }, 'penColor'), '#abcdef');
  assert.equal(chosen({ penColor: 2 }, 'penColor'), PEN_COLORS[2]);
  assert.equal(chosen({ textColor: 4 }, 'textColor'), PEN_COLORS[4]);
  assert.equal(chosen({ hlColor: 3 }, 'hlColor'), HL_COLORS[3]);
  assert.equal(chosen({ hlColor: 9 }, 'hlColor'), HL_COLORS[0]);
  assert.equal(chosen({ penColor: 'nope' }, 'penColor'), PEN_COLORS[0]);
  assert.equal(chosen({}, 'hlColor'), HL_COLORS[0]);
});

test('saving a colour adds it once, at the end', () => {
  const list = ['#111111'];
  assert.deepEqual(withColor(list, '#ABCDEF'), ['#111111', '#abcdef']);
  assert.deepEqual(withColor(list, '#111111'), ['#111111']);
  assert.deepEqual(withColor(list, 'nope'), ['#111111']);
  assert.deepEqual(list, ['#111111']); // unchanged
});

test('removing a colour keeps the last one', () => {
  assert.deepEqual(withoutColor(['#111111', '#222222'], '#111111'), ['#222222']);
  assert.deepEqual(withoutColor(['#111111'], '#111111'), ['#111111']);
  assert.deepEqual(withoutColor(['#111111'], '#999999'), ['#111111']);
});

test('built-in lists and names', () => {
  assert.equal(isBuiltIn(PEN_COLORS.slice(), 'pen'), true);
  assert.equal(isBuiltIn(withColor(PEN_COLORS, '#123456'), 'pen'), false);
  assert.equal(isBuiltIn(PEN_COLORS.slice(1), 'pen'), false);
  assert.equal(colorName('#d0312d'), 'Red');
  assert.equal(colorName('#123456'), 'Colour #123456');
});
