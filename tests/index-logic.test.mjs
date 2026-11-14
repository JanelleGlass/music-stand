// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, sortEntries, findHymn, searchEntries, entryAt, nextNumber, placeLabel, placeIndex, pickLabels, pickLandmarks, parseTitleList, hymnRun, linkAt, boxBetween } from '../js/index-logic.js';
import { mergeMarks, normMark, mergePage, pageIsEmpty, restampMarks } from '../js/notes-merge.js';

const hymn = (id, n, title, index, y = 0) => ({ id, kind: 'hymn', n, title, index, num: index + 1, y });
const section = (id, title, index, y = 0) => ({ id, kind: 'section', title, index, num: index + 1, y });

const book = [
  section('s1', 'Advent', 4),
  hymn('h1', '1', 'O Come, O Come, Emmanuel', 4),
  hymn('h2', '2', 'Comfort, Comfort Now My People', 5),
  section('s2', 'Christmas', 6, 0.5),
  hymn('h3', '3', 'Silent Night', 6, 0.5),
  hymn('h10', '10', 'Joy to the World', 7),
  hymn('h10a', '10a', 'Joy to the World (descant)', 8),
  hymn('h245', '245', 'Amazing Grace', 9),
];

test('text is compared without case, accents or punctuation', () => {
  assert.equal(fold('  Jésus, Lover of My Soul!  '), 'jesus lover of my soul');
  assert.equal(fold('O God’s Love'), 'o gods love');
});

test('entries come in the order of the music, a section before its first hymn', () => {
  const shuffled = [book[7], book[4], book[3], book[0], book[1], book[2], book[6], book[5]];
  assert.deepEqual(sortEntries(shuffled).map((e) => e.id), book.map((e) => e.id));
});

test('a hymn is found by its number as typed', () => {
  assert.equal(findHymn(book, '245').id, 'h245');
  assert.equal(findHymn(book, ' 10A ').id, 'h10a');
  assert.equal(findHymn(book, '11'), null);
  assert.equal(findHymn(book, ''), null);
});

test('searching a number finds that hymn first, then numbers starting with it', () => {
  assert.deepEqual(searchEntries(book, '10').map((e) => e.id), ['h10', 'h10a']);
  assert.equal(searchEntries(book, '2')[0].id, 'h2');
  assert.ok(searchEntries(book, '2').some((e) => e.id === 'h245'));
});

test('searching words finds titles holding all of them, in any case and order', () => {
  assert.deepEqual(searchEntries(book, 'grace amazing').map((e) => e.id), ['h245']);
  assert.deepEqual(searchEntries(book, 'joy world').map((e) => e.id), ['h10', 'h10a']);
  assert.deepEqual(searchEntries(book, 'emmanu').map((e) => e.id), ['h1']);
  assert.deepEqual(searchEntries(book, 'christ').map((e) => e.id), ['s2']);
  assert.deepEqual(searchEntries(book, 'nothing like this'), []);
  assert.equal(searchEntries(book, '').length, book.length);
});

test('titles starting with the words come before ones with them inside', () => {
  const e = [hymn('a', '5', 'Come Thou Fount', 1), hymn('b', '6', 'O Come All Ye Faithful', 0)];
  assert.deepEqual(searchEntries(e, 'come').map((x) => x.id), ['a', 'b']);
});

test('the entry at a place is the last one starting at or before it', () => {
  assert.equal(entryAt(book, 6, 0.2, 'hymn').id, 'h2');
  assert.equal(entryAt(book, 6, 0.6, 'hymn').id, 'h3');
  assert.equal(entryAt(book, 2, 0, 'hymn'), null);
  assert.equal(entryAt(book, 7, 0, 'section').id, 's2');
});

test('a new hymn is offered the number after the one before it', () => {
  assert.equal(nextNumber(book, 9, 0.5), '246');
  assert.equal(nextNumber(book, 8, 0.1), '11');
  assert.equal(nextNumber(book, 0, 0), '');
});

test('the scroll bar label names the hymn, or a section that has just begun', () => {
  assert.equal(placeLabel(book, 9, 0.1), '245 Amazing Grace');
  assert.equal(placeLabel(book, 6, 0.55), '3 Silent Night');
  assert.equal(placeLabel(book, 0, 0), '');
  const e = [hymn('h', '9', '', 1), section('s', 'Lent', 3)];
  assert.equal(placeLabel(e, 2, 0), 'Hymn 9');
  assert.equal(placeLabel(e, 3, 0.2), 'Lent');
});

test('labels down the bar keep their distance, sections first', () => {
  const items = [
    { id: 'h1', pos: 10, priority: 1 },
    { id: 's1', pos: 20, priority: 0 },
    { id: 'h2', pos: 45, priority: 1 },
    { id: 'h3', pos: 60, priority: 1 },
    { id: 'h4', pos: 100, priority: 1 },
  ];
  assert.deepEqual(pickLabels(items, 30).map((i) => i.id), ['s1', 'h3', 'h4']);
  assert.deepEqual(pickLabels([], 30), []);
});

test('a place is found among the entries in order', () => {
  assert.equal(placeIndex(book, 0, 0), -1); // before the first
  assert.equal(placeIndex(book, 4, 0), 1); // Advent and hymn 1 start together: the hymn
  assert.equal(placeIndex(book, 6, 0.2), 2); // hymn 2 still, Christmas starts lower
  assert.equal(placeIndex(book, 6, 0.5), 4); // Christmas and Silent Night
  assert.equal(placeIndex(book, 99, 0), 7);
  assert.equal(placeIndex([], 3, 0), -1);
});

// n hymns numbered from first, one every px down a bar.
const run = (n, every, first = 1) => Array.from({ length: n }, (_, i) => ({ id: `h${first + i}`, kind: 'hymn', n: String(first + i), pos: 10 + i * every }));
const ids = (items) => items.map((i) => i.id);

test('every hymn number goes down the bar when they all fit', () => {
  assert.deepEqual(ids(pickLandmarks(run(5, 40), 30)), ['h1', 'h2', 'h3', 'h4', 'h5']);
  assert.deepEqual(pickLandmarks([], 30), []);
});

test('crowded, the bar shows round numbers a step apart', () => {
  // 600 hymns 1.5px apart: every 20th fits (30px apart), every 10th doesn't.
  const kept = ids(pickLandmarks(run(600, 1.5), 30));
  assert.deepEqual(kept.slice(0, 6), ['h20', 'h40', 'h60', 'h80', 'h100', 'h120']);
  assert.equal(kept.length, 30);
  // 60 hymns 4px apart: every 10th.
  assert.deepEqual(ids(pickLandmarks(run(60, 4), 30)), ['h10', 'h20', 'h30', 'h40', 'h50', 'h60']);
  // Numbered from 701: still round numbers.
  assert.deepEqual(ids(pickLandmarks(run(30, 4, 701), 30)).slice(0, 3), ['h710', 'h720', 'h730']);
});

test('sections stay on the bar, and the rounder number where labels crowd', () => {
  const items = [...run(60, 4), { id: 's', kind: 'section', title: 'Lent', pos: 48 }];
  const kept = ids(pickLandmarks(items, 30));
  assert.ok(kept.includes('s'));
  assert.ok(!kept.includes('h10')); // 4px from Lent
  // 80 and 100 too close: 100 stays.
  const two = [{ id: 'h80', kind: 'hymn', n: '80', pos: 0 }, { id: 'h100', kind: 'hymn', n: '100', pos: 20 }];
  assert.deepEqual(ids(pickLandmarks(two, 30)), ['h100']);
});

test('numbers with letters go down the bar only when all fit', () => {
  const items = [{ id: 'a', kind: 'hymn', n: '10a', pos: 0 }, { id: 'b', kind: 'hymn', n: '11', pos: 40 }];
  assert.deepEqual(ids(pickLandmarks(items, 30)), ['a', 'b']);
  const crowded = [...run(20, 2), { id: 'x', kind: 'hymn', n: '5a', pos: 12 }];
  assert.ok(!ids(pickLandmarks(crowded, 30)).includes('x'));
});

test('a pasted index gives numbers and titles, number first or last', () => {
  const list = parseTitleList([
    '245 Amazing Grace',
    '  10. Joy to the World ',
    '12a – All Creatures of Our God and King',
    'Abide with Me ........ 31',
    'Be Thou My Vision · 451',
    '',
    'ADVENT',
    '1984',
  ].join('\n'));
  assert.deepEqual(list, [
    { n: '245', title: 'Amazing Grace' },
    { n: '10', title: 'Joy to the World' },
    { n: '12a', title: 'All Creatures of Our God and King' },
    { n: '31', title: 'Abide with Me' },
    { n: '451', title: 'Be Thou My Vision' },
  ]);
});

test('a run of hymns lands one every few pages, within the score', () => {
  assert.deepEqual(hymnRun(1, 3, 12, 1, 100), [{ n: '1', num: 12 }, { n: '2', num: 13 }, { n: '3', num: 14 }]);
  assert.deepEqual(hymnRun(5, 7, 1, 2, 4), [{ n: '5', num: 1 }, { n: '6', num: 3 }]);
  assert.deepEqual(hymnRun(9, 3, 1, 1, 100), []);
  assert.deepEqual(hymnRun('x', 3, 1, 1, 100), []);
});

test('a tap finds the smallest tap area under it', () => {
  const links = [{ id: 'big', box: [0, 0, 500, 500] }, { id: 'small', box: [100, 100, 50, 20] }];
  assert.equal(linkAt(links, 120, 110).id, 'small');
  assert.equal(linkAt(links, 300, 300).id, 'big');
  assert.equal(linkAt(links, 600, 600), null);
  assert.equal(linkAt(links, 503, 10, 5).id, 'big');
  assert.deepEqual(boxBetween(50, 80, 10, 20), [10, 20, 40, 60]);
});

// ---- Marks between devices ----

const m = (id, at, extra = {}) => ({ id, at, kind: 'hymn', n: '1', title: '', y: 0, ...extra });

test('marks are cleaned up, and bad ones left out', () => {
  assert.equal(normMark({ id: 'a', at: 1, kind: 'hymn', n: '  ' }), null);
  assert.equal(normMark({ id: 'a', at: 1, kind: 'nope' }), null);
  assert.equal(normMark({ id: 'a', at: 1, kind: 'link', box: [0, 0, 0, 5], page: 3 }), null);
  assert.deepEqual(normMark({ id: 'a', at: 1, kind: 'link', box: [1, 2, 3, 4], page: '7' }), { id: 'a', at: 1, kind: 'link', box: [1, 2, 3, 4], page: 7 });
  assert.deepEqual(normMark({ id: 'a', at: 1, kind: 'section', title: ' Lent  season ', y: 3 }), { id: 'a', at: 1, kind: 'section', title: 'Lent season', y: 1 });
  assert.deepEqual(normMark({ id: 'a', at: 4, gone: true, kind: 'hymn' }), { id: 'a', at: 4, gone: true });
});

test('the newer change to a mark wins, and a delete reaches every copy', () => {
  const a = [m('x', 1, { title: 'Old' }), m('y', 5)];
  const b = [m('x', 2, { title: 'New' }), { id: 'y', at: 6, gone: true }];
  const out = mergeMarks(a, b);
  assert.equal(out.find((x) => x.id === 'x').title, 'New');
  assert.ok(out.find((x) => x.id === 'y').gone);
  // An older copy doesn't bring a deleted mark back.
  assert.ok(mergeMarks(out, [m('y', 5)]).find((x) => x.id === 'y').gone);
});

test('combining marks is order-free and repeatable', () => {
  const a = [m('x', 3, { title: 'A' }), m('z', 1)];
  const b = [m('x', 3, { title: 'B' }), { id: 'z', at: 1, gone: true }];
  const c = [m('w', 9)];
  const one = mergeMarks(mergeMarks(a, b), c);
  const two = mergeMarks(c, mergeMarks(b, a));
  assert.deepEqual(one, two);
  assert.deepEqual(mergeMarks(one, one), one);
  assert.ok(one.find((x) => x.id === 'z').gone); // on a tie, the delete
});

test('a page keeps its marks with its markings, and isn’t empty while it has any', () => {
  const page = mergePage({ strokes: [], erased: [], marks: [m('x', 1)] }, { strokes: [], erased: [] });
  assert.equal(page.marks.length, 1);
  assert.equal(pageIsEmpty(page), false);
  assert.equal(pageIsEmpty({ strokes: [], erased: [], marks: [] }), true);
  assert.equal('marks' in mergePage({ strokes: [], erased: [] }, null), false);
});

test('marks restored with Replace count as changed just now', () => {
  const out = restampMarks([m('x', 5), { id: 'y', at: 50, gone: true }], 20);
  assert.deepEqual(out.map((x) => x.at), [20, 51]);
});

test('marks travel in the Google Drive file and come back the same', async () => {
  const { serialize, parse, mergeDocs } = await import('../js/sync-data.js');
  const marks = [m('x', 3, { n: '245', title: 'Amazing Grace' }), { id: 'l', at: 2, kind: 'link', box: [10, 20, 300, 18], hymn: '245' }, { id: 'g', at: 4, gone: true }];
  const doc = mergeDocs({ notes: { abc: { 3: { strokes: [], erased: [], marks } } }, folders: [], zooms: {} }, { notes: {}, folders: [], zooms: {} });
  const back = parse(serialize(doc)).doc;
  assert.deepEqual(back.notes.abc['3'].marks, mergeMarks(marks, null));
});

// ---- Words read from the pages ----
import { joinSyllables, searchPages } from '../js/index-logic.js';

test('words split into syllables under the notes are joined back up', () => {
  assert.equal(joinSyllables('A - maz - ing grace, how sweet the sound'), 'Amazing grace, how sweet the sound');
  assert.equal(joinSyllables('Hal- le- lu- jah'), 'Hallelujah');
  assert.equal(joinSyllables('re -joice'), 'rejoice');
  assert.equal(joinSyllables('well-known 1 - 3'), 'well-known 1 - 3');
});

test('pages are found by the words on them, with the words round the match', () => {
  const pages = [
    { index: 0, num: 1, text: 'Index\n1 Amazing Grace\n2 Abide with Me' },
    { index: 5, num: 6, text: '245 Amazing Grace\nA - maz - ing grace, how sweet the sound that saved a wretch like me' },
    { index: 7, num: 8, text: 'Silent night, holy night' },
  ];
  assert.deepEqual(searchPages(pages, 'wretch saved').map((p) => p.num), [6]);
  assert.deepEqual(searchPages(pages, 'amazing').map((p) => p.num), [1, 6]);
  assert.deepEqual(searchPages(pages, 'HOLY'), [{ index: 7, num: 8, snippet: 'Silent night, holy night' }]);
  assert.match(searchPages(pages, 'wretch')[0].snippet, /^… .*wretch like me$/);
  assert.deepEqual(searchPages(pages, 'x'), []);
  assert.deepEqual(searchPages(pages, 'nowhere'), []);
});

test('an index read by text recognition still gives numbers and titles', () => {
  assert.deepEqual(parseTitleList('Abide with Me ______ 10\nBe Thou My Vision • • • 451\nCome, Thou Fount,,, 12'), [
    { n: '10', title: 'Abide with Me' },
    { n: '451', title: 'Be Thou My Vision' },
    { n: '12', title: 'Come, Thou Fount' },
  ]);
});

test('an index in two columns, read a row at a time, gives each hymn', () => {
  assert.deepEqual(parseTitleList('Amazing Grace .................... 1 Holy, Holy, Holy .................. 5\nCome Thou Fount ...................4 Rockoff Ages. cin\n1 Abide with Me 2 Be Still, My Soul'), [
    { n: '1', title: 'Amazing Grace' },
    { n: '5', title: 'Holy, Holy, Holy' },
    { n: '4', title: 'Come Thou Fount' },
    { n: '1', title: 'Abide with Me' },
    { n: '2', title: 'Be Still, My Soul' },
  ]);
});

test('a match leaves out what staff lines were read as', () => {
  const [hit] = searchPages([{ index: 1, num: 2, text: 'I _— that saved a wretch like me! Ee TT I a SE —_—— ee' }], 'wretch');
  assert.equal(hit.snippet, 'I that saved a wretch like me! I a');
});
