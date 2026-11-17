// Reading the words on scanned pages (text recognition, Tesseract.js in a
// worker). Used by the Index panel (js/index-ui.js) to fill in hymn titles
// from a printed index, to read every page so the words of the music can be
// searched, and to find where hymns start from the numbers on the pages.
//
// The engine (about 11 MB, vendor/tesseract/) loads the first time it's
// needed; the service worker keeps it for offline use from then on. What a
// page says is kept in kv "ocr:<fileId>:<page>" (Google Drive sync carries
// it, js/sync-data.js). The numbers on a page, for finding hymns
// (js/hymn-find.js), are kept on this device only, in kv
// "nums:<fileId>:<page>": they're quick to read again.
import * as db from './db.js';
import { parseTsv, pageNumbers } from './hymn-find.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;
const READ_WIDTH = 1800; // px a page is drawn at for reading
const IDLE_MS = 60_000; // the engine is let go after this long unused
export const TEXT_VERSION = 1;
export const NUMS_VERSION = 1;

let enginePromise = null;
let idleTimer = 0;
let queue = Promise.resolve();

async function engine(onProgress) {
  clearTimeout(idleTimer);
  if (!enginePromise) {
    enginePromise = (async () => {
      const { default: Tesseract } = await import('../vendor/tesseract/tesseract.esm.min.js');
      return Tesseract.createWorker('eng', 1 /* LSTM only */, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE,
        langPath: BASE + 'lang',
        workerBlobURL: false,
        cacheMethod: 'none', // the service worker keeps the files
        logger: (m) => { if (onProgress && m && m.status) onProgress(m); },
      });
    })();
    enginePromise.catch(() => { enginePromise = null; });
  }
  return enginePromise;
}

// Lets the engine go (its memory with it) once nothing has been read for a
// while, or now.
export function release(now = false) {
  clearTimeout(idleTimer);
  const go = () => {
    const p = enginePromise;
    enginePromise = null;
    if (p) p.then((w) => w.terminate()).catch(() => {});
  };
  if (now) go();
  else idleTimer = setTimeout(go, IDLE_MS);
}

// Reads one canvas at a time: data as Tesseract gives it. layout: find the
// blocks of text on the page (so a hymn number standing apart is a word of
// its own) rather than taking the page as one block of lines.
function recognize(canvas, { onLoading, layout = false, words = false } = {}) {
  const job = queue.then(async () => {
    const w = await engine(onLoading);
    await w.setParameters({ tessedit_pageseg_mode: layout ? '3' : '6' });
    const { data } = await w.recognize(canvas, {}, { text: true, tsv: words });
    return data || {};
  });
  queue = job.catch(() => {});
  job.finally(() => release());
  return job;
}

// The text on a canvas, one line of the page per line.
export async function readCanvas(canvas, options) {
  return (await recognize(canvas, options)).text || '';
}

// How page index of the open score is turned and straightened for reading.
export function readingView(viewer, index) {
  const p = viewer.pages[index];
  return { rot: p.view ? p.view.rot || 0 : 0, tilt: p.view ? p.view.tilt || 0 : 0 };
}

// Page index of the open score drawn for reading: whole, turned and
// straightened as it shows.
async function pageCanvas(viewer, index) {
  const p = viewer.pages[index];
  const { rot, tilt } = readingView(viewer, index);
  const turned = rot % 180 ? [p.ph, p.pw] : [p.pw, p.ph];
  const h = Math.round((READ_WIDTH * turned[1]) / turned[0]);
  return viewer.paperImage(index, rot, READ_WIDTH, h, 1, tilt);
}

// The text on page index of the open score.
export async function readPage(viewer, index, options) {
  const canvas = await pageCanvas(viewer, index);
  try {
    return await readCanvas(canvas, options);
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// Page index of the open score read for finding hymns: { text, nums } (nums
// as js/hymn-find.js keeps a page's numbers).
export async function readPageNumbers(viewer, index, options = {}) {
  const canvas = await pageCanvas(viewer, index);
  try {
    const data = await recognize(canvas, { ...options, layout: true, words: true });
    return { text: data.text || '', nums: pageNumbers(parseTsv(data.tsv), canvas.width, canvas.height) };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// ---- What pages say, kept on this device ----

const textKey = (fileId, num) => `ocr:${fileId}:${num}`;

export async function savedTexts(fileId) {
  const out = new Map();
  for (const [k, v] of await db.getAllWithPrefix('kv', `ocr:${fileId}:`)) {
    if (v && v.v === TEXT_VERSION && typeof v.text === 'string') out.set(Number(k.slice(k.lastIndexOf(':') + 1)), v.text);
  }
  return out;
}

export function saveText(fileId, num, text) {
  return db.put('kv', { v: TEXT_VERSION, text, at: Date.now() }, textKey(fileId, num));
}

export async function forgetTexts(fileId) {
  const keys = [];
  for (const prefix of [`ocr:${fileId}:`, `nums:${fileId}:`]) keys.push(...(await db.getAllWithPrefix('kv', prefix)).map(([k]) => k));
  if (keys.length) await db.transact(['kv'], (s) => { for (const k of keys) s.kv.delete(k); });
}

// ---- The numbers on pages, kept on this device ----

const numsKey = (fileId, num) => `nums:${fileId}:${num}`;

// page → { rot, tilt, w, h, mh, nums } as read (rot and tilt: how the page
// was turned and straightened; read again when that changes).
export async function savedNumbers(fileId) {
  const out = new Map();
  for (const [k, v] of await db.getAllWithPrefix('kv', `nums:${fileId}:`)) {
    if (v && v.v === NUMS_VERSION && Array.isArray(v.nums)) out.set(Number(k.slice(k.lastIndexOf(':') + 1)), v);
  }
  return out;
}

export function saveNumbers(fileId, num, rec) {
  return db.put('kv', { ...rec, v: NUMS_VERSION, at: Date.now() }, numsKey(fileId, num));
}
