// Run with: node --test tests/hymn-find.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTsv, numberOf, pageNumbers, wantedNumbers, findHymnStarts, hymnChanges, shortList } from '../js/hymn-find.js';

test('words come from Tesseract’s TSV, with their boxes', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t1800\t2700\t-1\t',
    '5\t1\t1\t1\t1\t1\t1532\t123\t118\t65\t10.2\t2',
    '5\t1\t2\t1\t1\t1\t136\t499\t60\t28\t87.3\tgrace',
    '5\t1\t2\t1\t1\t2\t200\t499\t60\t28\t87.3\t ',
  ].join('\n');
  assert.deepEqual(parseTsv(tsv), [
    { text: '2', x0: 1532, y0: 123, x1: 1650, y1: 188 },
    { text: 'grace', x0: 136, y0: 499, x1: 196, y1: 527 },
  ]);
  assert.deepEqual(parseTsv(''), []);
});

test('a word is a hymn number with stray marks around it, and look-alike letters', () => {
  assert.equal(numberOf('245'), '245');
  assert.equal(numberOf('245.'), '245');
  assert.equal(numberOf('(245)'), '245');
  assert.equal(numberOf('“3'), '3');
  assert.equal(numberOf('245a'), '245a');
  assert.equal(numberOf('1O5'), '105');
  assert.equal(numberOf('l2'), '12');
  assert.equal(numberOf('|7'), '17');
  assert.equal(numberOf('0'), '');
  assert.equal(numberOf('8.7.8.7'), '');
  assert.equal(numberOf('Lord'), '');
  assert.equal(numberOf('Il'), ''); // no digit at all
  assert.equal(numberOf('12345'), '');
});

test('a page keeps its size, its words’ usual height and its numbers', () => {
  const words = [
    { text: '12', x0: 1600, y0: 100, x1: 1660, y1: 165 },
    { text: 'praise', x0: 100, y0: 500, x1: 200, y1: 530 },
    { text: 'glory', x0: 220, y0: 500, x1: 300, y1: 528 },
    { text: 'king', x0: 320, y0: 500, x1: 380, y1: 532 },
    { text: '——t+——r——eo', x0: 100, y0: 600, x1: 1600, y1: 647 }, // a stave
    { text: '——o—+—1——;', x0: 100, y0: 800, x1: 1600, y1: 845 },
    { text: '3', x0: 60, y0: 500, x1: 75, y1: 528 },
    { text: '.', x0: 60, y0: 700, x1: 62, y1: 702 },
    { text: '4', x0: 900, y0: 900, x1: 903, y1: 903 }, // a speck
  ];
  assert.deepEqual(pageNumbers(words, 1800, 2700), {
    w: 1800, h: 2700, mh: 30,
    nums: [['12', 1600, 100, 1660, 165], ['3', 60, 500, 75, 528]],
  });
});

test('the numbers looked for: the range, and the index’s numbers with letters in it', () => {
  const e = [{ kind: 'hymn', n: '3a' }, { kind: 'hymn', n: '9b' }, { kind: 'section', title: 'Lent' }];
  assert.deepEqual(wantedNumbers(e, 1, 5), ['1', '2', '3', '3a', '4', '5']);
  assert.deepEqual(wantedNumbers([], 3, 2), []);
});

// A made-up hymnal, pages 1800 × 2700 px read, words 30px high. Each hymn's
// number is 65px at the top outer corner; the pages also have verse numbers
// 1-3 (30px, left), a time signature (40px), a credit with years and a page
// number. layout: for each page, the hymns starting on it (with y, 0 to 1).
function book(layout, { cont = [], index = [] } = {}) {
  return layout.map((starts, i) => {
    const nums = [];
    for (const [n, y] of starts) {
      const y0 = Math.round(y * 2700) + 100;
      nums.push([String(n), i % 2 ? 100 : 1600, y0, i % 2 ? 160 : 1660, y0 + 65]);
      for (const v of [1, 2, 3]) nums.push([String(v), 60, y0 + 300 + v * 48, 75, y0 + 330 + v * 48]);
      nums.push(['3', 140, y0 + 250, 170, y0 + 290], ['4', 140, y0 + 292, 170, y0 + 332]);
      nums.push(['1874', 400, y0 + 1000, 460, y0 + 1022]);
    }
    if (cont.includes(i)) nums.push([String(layout[i - 1][0][0]), 1500, 120, 1520, 158]);
    for (const n of index[i] || []) nums.push([String(n), 1500, 300 + n * 20, 1540, 322 + n * 20]);
    nums.push([String(i + 5), 880, 2620, 910, 2642]);
    return { index: i, w: 1800, h: 2700, mh: 30, nums };
  });
}
const wanted = (n) => Array.from({ length: n }, (_, i) => String(i + 1));
const placeOf = (m, n) => {
  const p = m.get(String(n));
  return p.how === 'none' ? p.how : `${p.how} ${p.index} ${p.y.toFixed(2)}`;
};

test('each hymn is found where its number is: one a page, two to a page, two pages', () => {
  // Page 0 front matter; 1: hymn 1; 2: hymns 2 and 3; 3: hymn 4; 4 its second
  // page, headed "4 (continued)"; 5: hymn 5; then 6..9 one a page.
  const layout = [[], [[1, 0.02]], [[2, 0.02], [3, 0.44]], [[4, 0.02]], [], [[5, 0.02]], [[6, 0.02]], [[7, 0.02]], [[8, 0.02]], [[9, 0.02]]];
  const m = findHymnStarts(book(layout, { cont: [4] }), wanted(9));
  assert.equal(placeOf(m, 1), 'found 1 0.00');
  assert.equal(placeOf(m, 2), 'found 2 0.00');
  assert.equal(placeOf(m, 3), 'found 2 0.46'); // a little above its number, which is at 0.44 + 100px
  assert.equal(placeOf(m, 4), 'found 3 0.00'); // not the "(continued)" on page 4
  assert.equal(placeOf(m, 5), 'found 5 0.00');
  assert.equal(placeOf(m, 9), 'found 9 0.00');
});

test('the printed index at the back and stray numbers don’t count', () => {
  const layout = [[[1, 0.02]], [[2, 0.02]], [[3, 0.02]], [[4, 0.02]], [[5, 0.02]], [[6, 0.02]], [], []];
  // The index lists every hymn in small type on the last two pages.
  const m = findHymnStarts(book(layout, { index: { 6: [1, 2, 3], 7: [4, 5, 6] } }), wanted(6));
  for (let n = 1; n <= 6; n++) assert.equal(placeOf(m, n), `found ${n - 1} 0.00`);
});

test('a hymn whose number wasn’t read goes between the hymns either side when the pages work out', () => {
  const layout = [[[1, 0.02]], [[2, 0.02]], [[3, 0.02]], [[4, 0.02]], [[5, 0.02]], [[6, 0.02]], [[7, 0.02]], [[8, 0.02]]];
  const pages = book(layout);
  // 4 and 5 weren't read.
  for (const k of [3, 4]) pages[k].nums = pages[k].nums.filter(([n, , y0, , y1]) => y1 - y0 < 60);
  const m = findHymnStarts(pages, wanted(8));
  assert.equal(placeOf(m, 4), 'guessed 3 0.00');
  assert.equal(placeOf(m, 5), 'guessed 4 0.00');
  assert.deepEqual(m.get('4').after, { index: 2, y: 0 });
  assert.deepEqual(m.get('4').before, { index: 5, y: 0 });
  // 3 takes two pages and 4 starts partway down the next: three pages for
  // two hymns don't share out evenly, so no guess, but 4 must be between.
  const two = book([[[1, 0.02]], [[2, 0.02]], [[3, 0.02]], [], [[4, 0.5]], [[5, 0.02]]]);
  two[4].nums = two[4].nums.filter(([n, , y0, , y1]) => y1 - y0 < 60);
  const t = findHymnStarts(two, wanted(5));
  assert.equal(placeOf(t, 4), 'none');
  assert.deepEqual([t.get('4').after.index, t.get('4').before.index], [2, 5]);
});

test('a number misread out of order is left out', () => {
  const layout = Array.from({ length: 12 }, (_, i) => [[i + 1, 0.02]]);
  const pages = book(layout);
  // Hymn 9's number read as 3.
  pages[8].nums = pages[8].nums.map((x) => (x[0] === '9' && x[4] - x[2] > 60 ? ['3', ...x.slice(1)] : x));
  const m = findHymnStarts(pages, wanted(12));
  assert.equal(placeOf(m, 3), 'found 2 0.00');
  assert.equal(placeOf(m, 9), 'guessed 8 0.00');
});

test('a crop moves where a hymn starting partway down shows', () => {
  const pages = book([[[1, 0.02]], [[2, 0.02], [3, 0.5]], [[4, 0.02]], [[5, 0.02]], [[6, 0.02]], [[7, 0.02]]]);
  pages[1].crop = [0.1, 0.8];
  const m = findHymnStarts(pages, wanted(7));
  assert.equal(placeOf(m, 2), 'found 1 0.00');
  // Its number's top is at 0.5 + 100/2700 = 0.537; less 0.015, less the crop's 0.1, over 0.8.
  assert.equal(placeOf(m, 3), `found 1 ${((0.537 - 0.015 - 0.1) / 0.8).toFixed(2)}`);
});

test('what finding does to the index', () => {
  const places = new Map([
    ['1', { how: 'found', index: 1, y: 0 }],
    ['2', { how: 'found', index: 2, y: 0 }],
    ['3', { how: 'found', index: 2, y: 0.46 }],
    ['4', { how: 'guessed', index: 3, y: 0, after: { index: 2, y: 0.46 }, before: { index: 5, y: 0 } }],
    ['5', { how: 'none', index: null, y: null, after: { index: 2, y: 0.46 }, before: { index: 5, y: 0 } }],
    ['6', { how: 'none', index: null, y: null, after: { index: 2, y: 0.46 }, before: { index: 5, y: 0 } }],
    ['7', { how: 'none', index: null, y: null, after: { index: 2, y: 0.46 }, before: { index: 5, y: 0 } }],
    ['8', { how: 'guessed', index: 4, y: 0, after: { index: 2, y: 0.46 }, before: { index: 5, y: 0 } }],
  ]);
  const h = (id, n, index, y = 0) => ({ id, kind: 'hymn', n, index, y });
  const entries = [h('a', '1', 1), h('b', '2', 3), h('c', '4', 4), h('d', '5', 4), h('e', '6', 9), h('f', '8', 1)];
  const got = hymnChanges(entries, ['1', '2', '3', '4', '5', '6', '7', '8'], places).map((c) => `${c.n} ${c.action}${c.to ? ` ${c.to.index}` : ''}`);
  assert.deepEqual(got, [
    '1 same 1', // already there
    '2 move 2',
    '3 add 2', // not in the index yet
    '4 keep 3', // not read, but where it is fits between its neighbours
    '5 keep', // the same, with no guess
    '6 keep', // out of place, but nowhere better
    '7 missing',
    '8 move 4', // out of place: to the guess
  ]);
});

test('numbers for a message: runs shortened, and not too many', () => {
  assert.equal(shortList(['3', '17', '18', '19', '20', '45', '46']), '3, 17–20, 45, 46');
  assert.equal(shortList(['9', '10a', '11']), '9, 10a, 11');
  assert.equal(shortList(['1', '3', '5', '7'], 2), '1, 3…');
  assert.equal(shortList([]), '');
});
