// Reading the words on scanned pages (text recognition, Tesseract.js in a
// worker). Used by the Index panel (js/index-ui.js) to fill in hymn titles
// from a printed index, and to read every page so the words of the music
// can be searched.
//
// The engine (about 11 MB, vendor/tesseract/) loads the first time it's
// needed; the service worker keeps it for offline use from then on. What a
// page says is kept on this device only (kv "ocr:<fileId>:<page>"): it's
// quick to read again, so it isn't synced or backed up.
import * as db from './db.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;
const READ_WIDTH = 1800; // px a page is drawn at for reading
const IDLE_MS = 60_000; // the engine is let go after this long unused
export const TEXT_VERSION = 1;

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

// The text on a canvas, one line of the page per line. Reads one canvas at
// a time.
export function readCanvas(canvas, { onLoading } = {}) {
  const job = queue.then(async () => {
    const w = await engine(onLoading);
    const { data } = await w.recognize(canvas);
    return (data && data.text) || '';
  });
  queue = job.catch(() => {});
  job.finally(() => release());
  return job;
}

// Reads page index of the open score (drawn whole, turned and straightened
// as it shows).
export async function readPage(viewer, index, options) {
  const p = viewer.pages[index];
  const rot = p.view ? p.view.rot : 0;
  const tilt = p.view ? p.view.tilt || 0 : 0;
  const turned = rot % 180 ? [p.ph, p.pw] : [p.pw, p.ph];
  const w = READ_WIDTH;
  const h = Math.round((READ_WIDTH * turned[1]) / turned[0]);
  const canvas = await viewer.paperImage(index, rot, w, h, 1, tilt);
  try {
    return await readCanvas(canvas, options);
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
  const keys = (await db.getAllWithPrefix('kv', `ocr:${fileId}:`)).map(([k]) => k);
  if (keys.length) await db.transact(['kv'], (s) => { for (const k of keys) s.kv.delete(k); });
}
