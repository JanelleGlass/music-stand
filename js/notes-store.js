// The notes of the score that is open: loaded once, changed in memory as the
// person writes, saved page by page a moment later. Saving merges with what
// is stored (js/notes-merge.js), so nothing written elsewhere meanwhile is
// lost. Undo and redo cover what was done since the score was opened.
import * as db from './db.js';
import { libraryEdited } from './data.js';
import { mergePage, pageIsEmpty } from './notes-merge.js';

const SAVE_DELAY_MS = 500;
const RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60 * 1000;
const MAX_UNDO = 200;

export const pageKey = (fileId, num) => `${fileId}:${num}`;

export function newStrokeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export class NotesStore {
  // write: saves pages (the tests pass their own).
  constructor({ write = save } = {}) {
    this.write = write;
    this.pages = new Map(); // "fileId:page" → { strokes, erased }
    this.unsaved = new Set();
    this.failed = new Map(); // pages whose save failed, kept for the next try
    this.alias = new Map(); // stroke id → the id of the copy that replaced it (undo of an erase)
    this.undoStack = [];
    this.redoStack = [];
    this.timer = 0;
    this.saving = Promise.resolve();
    this.onChange = () => {};
    this.onError = () => {};
    this.failing = false; // saves are failing; the person has been told
    this.retryMs = RETRY_MS;
    this.gen = 0; // bumped when unsaved pages are dropped
  }

  async load(fileIds) {
    this.pages.clear();
    this.alias.clear();
    this.undoStack = [];
    this.redoStack = [];
    for (const fileId of new Set(fileIds)) {
      for (const r of await db.getAllByIndex('annotations', 'fileId', fileId)) {
        this.pages.set(r.id, { strokes: r.strokes || [], erased: r.erased || [] });
      }
    }
  }

  strokes(fileId, num) {
    const p = this.pages.get(pageKey(fileId, num));
    return p ? p.strokes : [];
  }

  hasNotes(fileId, num) {
    return this.strokes(fileId, num).length > 0;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ---- Changes (each one can be undone) ----

  add(fileId, num, stroke) {
    this.#apply({ type: 'add', fileId, num, strokes: [stroke], fresh: true });
  }

  erase(fileId, num, ids) {
    const gone = this.strokes(fileId, num).filter((s) => ids.includes(s.id));
    if (gone.length) this.#apply({ type: 'erase', fileId, num, strokes: gone });
  }

  clear(fileId, num) {
    const gone = this.strokes(fileId, num);
    if (gone.length) this.#apply({ type: 'erase', fileId, num, strokes: gone });
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return null;
    const back = this.#invert(op);
    this.#do(back);
    this.redoStack.push(back);
    this.onChange(back);
    return back;
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return null;
    const again = this.#invert(op);
    this.#do(again);
    this.undoStack.push(again);
    this.onChange(again);
    return again;
  }

  // An erased stroke can't come back under its old id (the erase may already
  // be on other devices), so undoing an erase draws copies. Later undos and
  // redos that name the old stroke act on its copy.
  #invert(op) {
    if (op.type === 'add') return { ...op, type: 'erase', fresh: false, strokes: op.strokes.map((s) => ({ ...s, id: this.#current(s.id) })) };
    return {
      ...op,
      type: 'add',
      fresh: false,
      strokes: op.strokes.map((s) => {
        const copy = { ...s, id: newStrokeId() };
        this.alias.set(s.id, copy.id);
        return copy;
      }),
    };
  }

  #current(id) {
    while (this.alias.has(id)) id = this.alias.get(id);
    return id;
  }

  #apply(op) {
    this.#do(op);
    this.undoStack.push(op);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.onChange(op);
  }

  #do(op) {
    const key = pageKey(op.fileId, op.num);
    const page = this.pages.get(key) || { strokes: [], erased: [] };
    const change = op.type === 'add'
      ? { strokes: op.strokes, erased: [] }
      : { strokes: [], erased: op.strokes.map((s) => s.id) };
    this.pages.set(key, mergePage(page, change));
    this.unsaved.add(key);
    this.#saveSoon();
  }

  // ---- Saving ----

  #saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  // Saves the pages changed since the last save. Safe to call any time. A
  // failed save keeps its pages (even if another score is opened meanwhile)
  // and is tried again.
  flush() {
    clearTimeout(this.timer);
    if (!this.unsaved.size && !this.failed.size) return this.saving;
    const keys = new Set([...this.unsaved, ...this.failed.keys()]);
    this.unsaved.clear();
    const writes = [...keys].map((key) => ({ key, page: mergePage(this.failed.get(key), this.pages.get(key)) }));
    this.failed.clear();
    const gen = this.gen;
    this.saving = this.saving.then(() => this.write(writes)).then(() => {
      this.failing = false;
      this.retryMs = RETRY_MS;
    }, (e) => {
      console.warn('Saving markings failed', e);
      if (gen !== this.gen) return; // dropped meanwhile (a backup replaced them)
      for (const { key, page } of writes) this.failed.set(key, mergePage(this.failed.get(key), page));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 3, MAX_RETRY_MS);
      if (!this.failing) {
        this.failing = true;
        this.onError(e);
      }
    });
    return this.saving;
  }

  // Forgets pages not saved yet, including a save under way that fails
  // (restoring a backup with Replace makes them out of date).
  discardPending() {
    clearTimeout(this.timer);
    this.unsaved.clear();
    this.failed.clear();
    this.gen++;
  }
}

// Writes pages, merged with the stored copies (Google Drive sync may have
// added to them meanwhile), and tells sync.
async function save(writes) {
  const at = Date.now();
  await db.transact(['annotations'], (s) => {
    for (const { key, page } of writes) {
      const i = key.lastIndexOf(':');
      const fileId = key.slice(0, i);
      const num = Number(key.slice(i + 1));
      const req = s.annotations.get(key);
      req.onsuccess = () => {
        const merged = mergePage(req.result, page);
        if (pageIsEmpty(merged)) s.annotations.delete(key);
        else s.annotations.put({ id: key, fileId, page: num, ...merged, updatedAt: at });
      };
    }
  });
  libraryEdited();
}
