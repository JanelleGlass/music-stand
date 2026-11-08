// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenHash, buildLink, findScore, findPiece, pieceKey, linkName } from '../js/links.js';

test('a page link', () => {
  assert.deepEqual(parseOpenHash('#/open/Book%201%20Training%20Material?page=18'), { score: 'Book 1 Training Material', page: 18 });
});

test('a piece link, by title or by number', () => {
  assert.deepEqual(parseOpenHash('#/open/Suzuki%20Violin%20Book%201?piece=Lightly%20Row'), { score: 'Suzuki Violin Book 1', piece: 'Lightly Row' });
  assert.deepEqual(parseOpenHash('#/open/Suzuki%20Violin%20Book%201?piece=2'), { score: 'Suzuki Violin Book 1', piece: '2' });
  assert.deepEqual(parseOpenHash('#/open/Suzuki+Violin+Book+1?piece=Lightly+Row'), { score: 'Suzuki Violin Book 1', piece: 'Lightly Row' });
});

test('a link to just the score', () => {
  assert.deepEqual(parseOpenHash('#/open/Group%20Lessons'), { score: 'Group Lessons' });
  assert.deepEqual(parseOpenHash('#/open/Group%20Lessons?page=0'), { score: 'Group Lessons' });
  assert.deepEqual(parseOpenHash('#/open/Group%20Lessons?page=abc'), { score: 'Group Lessons' });
});

test('other addresses are not links', () => {
  assert.equal(parseOpenHash(''), null);
  assert.equal(parseOpenHash('#/'), null);
  assert.equal(parseOpenHash('#/file/abc'), null);
  assert.equal(parseOpenHash('#/open/'), null);
  assert.equal(parseOpenHash('#/open/%E0%A4%A'), null); // not decodable
});

test('a name with a question mark or slash survives the trip', () => {
  const link = buildLink('https://x.test/music-stand/', 'What? Now/Then', { page: 3 });
  assert.deepEqual(parseOpenHash(link.slice(link.indexOf('#'))), { score: 'What? Now/Then', page: 3 });
});

test('links are built in exactly the documented format', () => {
  const base = 'https://janelleglass.github.io/music-stand/';
  assert.equal(buildLink(base, 'Suzuki Violin Book 1', { piece: 'Lightly Row' }), 'https://janelleglass.github.io/music-stand/#/open/Suzuki%20Violin%20Book%201?piece=Lightly%20Row');
  assert.equal(buildLink(base, 'Book 1 Training Material.pdf', { page: 18 }), 'https://janelleglass.github.io/music-stand/#/open/Book%201%20Training%20Material?page=18');
  assert.equal(buildLink(base, 'Group Lessons'), 'https://janelleglass.github.io/music-stand/#/open/Group%20Lessons');
  assert.equal(linkName('Scales.PDF'), 'Scales');
});

const files = [
  { id: 'v1', name: 'Suzuki Violin Book 1' },
  { id: 'v2', name: 'Suzuki Violin Book 2' },
  { id: 'v10', name: 'Suzuki Violin Book 10' },
  { id: 'a1', name: 'Suzuki Viola Book 1.pdf' },
  { id: 't1', name: 'Book 1 Training Material' },
  { id: 'g', name: 'Group Lessons' },
];

test('a score is found by its name, whatever the case, accents or .pdf', () => {
  assert.equal(findScore(files, 'Suzuki Violin Book 1').file.id, 'v1');
  assert.equal(findScore(files, 'suzuki violin book 1.pdf').file.id, 'v1');
  assert.equal(findScore(files, 'Suzuki Viola Book 1').file.id, 'a1');
  assert.equal(findScore(files, 'Group Lessons').file.id, 'g');
  assert.equal(findScore([{ id: 'e', name: 'Études' }], 'etudes').file.id, 'e');
});

test('a single name holding the words is found; several are offered, not guessed', () => {
  assert.equal(findScore(files, 'Training').file.id, 't1');
  assert.deepEqual(findScore(files, 'Violin Book').choices.map((f) => f.id), ['v1', 'v2', 'v10']);
  assert.deepEqual(findScore(files, 'Cello Book 1').choices, []);
  assert.deepEqual(findScore(files, '').choices, []);
});

const entries = [
  { id: 'a', kind: 'hymn', n: '1', title: 'Twinkle Variations', index: 3, y: 0 },
  { id: 'b', kind: 'hymn', n: '2', title: 'Lightly Row', index: 6, y: 0.4 },
  { id: 'c', kind: 'hymn', n: '3', title: 'Song of the Wind', index: 7, y: 0 },
  { id: 'd', kind: 'hymn', n: '12', title: 'Minuet 1', index: 18, y: 0 },
  { id: 'e', kind: 'hymn', n: '13', title: 'Minuet 2', index: 19, y: 0 },
  { id: 'f', kind: 'hymn', n: '14', title: 'Minuet 3', index: 20, y: 0 },
  { id: 's', kind: 'section', title: 'Pre-Twinkle', index: 1, y: 0 },
];

test('a piece is found by number first, then by title', () => {
  assert.equal(findPiece(entries, '2').id, 'b');
  assert.equal(findPiece(entries, 'Lightly Row').id, 'b');
  assert.equal(findPiece(entries, 'lightly row').id, 'b');
  assert.equal(findPiece(entries, 'Minuet 1').id, 'd');
  assert.equal(findPiece(entries, 'Minuet 2').id, 'e');
  assert.equal(findPiece(entries, 'pre twinkle').id, 's');
  assert.equal(findPiece(entries, 'song wind').id, 'c');
});

test('a piece that is not in the index is not guessed', () => {
  assert.equal(findPiece(entries, '4'), null);
  assert.equal(findPiece(entries, 'Perpetual Motion'), null);
  assert.equal(findPiece(entries, ''), null);
  assert.equal(findPiece([], 'Lightly Row'), null);
});

test('a link to an entry uses its title when that is unique, else its number', () => {
  assert.equal(pieceKey(entries, entries[1]), 'Lightly Row');
  assert.equal(pieceKey(entries, entries[6]), 'Pre-Twinkle');
  const twice = [...entries, { id: 'g', kind: 'hymn', n: '30', title: 'Lightly Row', index: 40, y: 0 }];
  assert.equal(pieceKey(twice, twice[1]), '2');
  const numberTitle = [{ id: 'x', kind: 'hymn', n: '5', title: '2', index: 0, y: 0 }, entries[1]];
  assert.equal(pieceKey(numberTitle, numberTitle[0]), '5');
  for (const e of entries) assert.equal(findPiece(entries, pieceKey(entries, e)).id, e.id);
});
