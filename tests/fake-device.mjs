// An in-memory device for the sync tests: the library plus the sync records,
// with the same surface as the app's local adapter (js/sync-local.js), and the
// things a person does in the app (add, rename, delete).
import { sha256Hex as sha } from './sha256.mjs';
import { mergePage, pageIsEmpty, mergeFolder } from '../js/notes-merge.js';

const randomUUID = () => crypto.randomUUID();

export class FakeDevice {
  constructor(name, clock = { now: 1_700_000_000_000 }) {
    this.name = name;
    this.clock = clock;
    this.files = new Map(); // id -> { id, name, hash, addedAt, updatedAt, size }
    this.blobs = new Map(); // id -> Uint8Array
    this.positions = new Map(); // id -> { id, page }
    this.kv = new Map(); // 'sync:…' -> value
    this.parts = new Map(); // driveId -> [Blob]
    this.annotations = new Map(); // "id:page" -> { id, fileId, page, strokes, erased }
    this.lists = new Map(); // folderId -> folder record (members by score id)
    this.seq = 0;
    this.free = Infinity;
    this.failures = [];
  }

  now() {
    return (this.clock.now += 1000);
  }

  failNext(op, error = new Error(`fake ${op} failure`)) {
    this.failures.push({ op, error });
  }

  #maybeFail(op) {
    const i = this.failures.findIndex((f) => f.op === op);
    if (i >= 0) throw this.failures.splice(i, 1)[0].error;
  }

  // ---- What a person does ----

  add(name, content) {
    const bytes = new TextEncoder().encode(content);
    const hash = sha(bytes);
    for (const f of this.files.values()) if (f.hash === hash) return f.id;
    const id = randomUUID();
    const t = this.now();
    this.files.set(id, { id, name, hash, addedAt: t, size: bytes.length });
    this.blobs.set(id, bytes);
    this.positions.set(id, { id, page: 1 });
    return id;
  }

  rename(id, name) {
    this.files.get(id).name = name;
  }

  delete(id) {
    const f = this.files.get(id);
    this.#forget(id);
    this.kv.set(`sync:tomb:${id}`, { hash: f.hash, at: this.now() });
  }

  #forget(id) {
    this.files.delete(id);
    this.blobs.delete(id);
    this.positions.delete(id);
    for (const [k, r] of this.annotations) if (r.fileId === id) this.annotations.delete(k);
    for (const k of [...this.kv.keys()]) if (k.startsWith(`ocr:${id}:`)) this.kv.delete(k);
    for (const f of this.lists.values()) f.members = f.members.filter((m) => m.score !== id);
  }

  // Draws a stroke on a page; returns its id.
  draw(id, page, label = 'mark') {
    const sid = `${this.name}-${label}-${++this.seq}`;
    this.#notesPage(id, page, { strokes: [{ id: sid, at: this.now(), tool: 'pen', color: '#1d1d1f', w: 2, pts: [0, 0, 10, 10] }], erased: [] });
    return sid;
  }

  erase(id, page, strokeId) {
    this.#notesPage(id, page, { strokes: [], erased: [strokeId] });
  }

  // Zooms a score (scrolling), as the viewer does.
  setZoom(id, zoom) {
    const p = this.positions.get(id) || { id, page: 0, frac: 0 };
    this.positions.set(id, { ...p, zoom, zoomAt: this.now() });
  }

  zoomOf(id) {
    const p = this.positions.get(id);
    return p ? p.zoom : undefined;
  }

  // Reads a page with text recognition (js/ocr.js).
  readPage(id, page, text) {
    this.kv.set(`ocr:${id}:${page}`, { v: 1, text, at: this.now() });
  }

  textOf(id, page) {
    const t = this.kv.get(`ocr:${id}:${page}`);
    return t ? t.text : undefined;
  }

  // Adds index marks to a page (js/marks.js).
  addMarks(id, page, marks) {
    const at = this.now();
    this.#notesPage(id, page, { strokes: [], erased: [], marks: marks.map((m, i) => ({ id: `${this.name}-m${++this.seq}`, at: at + i, ...m })) });
  }

  // Changes or deletes (gone) a mark.
  changeMark(id, page, markId, patch) {
    const r = this.annotations.get(`${id}:${page}`);
    const m = r.marks.find((x) => x.id === markId);
    this.#notesPage(id, page, { strokes: [], erased: [], marks: [{ ...m, ...patch, at: this.now() }] });
  }

  marksOn(id, page) {
    const r = this.annotations.get(`${id}:${page}`);
    return r && r.marks ? r.marks.filter((m) => !m.gone) : [];
  }

  // Crops and turns a page (js/page-view.js).
  adjust(id, page, rot, crop = null) {
    this.#notesPage(id, page, { strokes: [], erased: [], view: { rot, crop, at: this.now() } });
  }

  // How a page is shown: { rot, crop }, or null.
  view(id, page) {
    const r = this.annotations.get(`${id}:${page}`);
    return r && r.view ? { rot: r.view.rot, crop: r.view.crop } : null;
  }

  #notesPage(id, page, change) {
    const key = `${id}:${page}`;
    const merged = mergePage(this.annotations.get(key), change);
    this.annotations.set(key, { id: key, fileId: id, page, ...merged });
  }

  // The ids of the strokes on a page.
  marks(id, page) {
    const r = this.annotations.get(`${id}:${page}`);
    return r ? r.strokes.map((s) => s.id).sort() : [];
  }

  makeFolder(name, folderId = `${this.name}-folder-${++this.seq}`) {
    const t = this.now();
    this.lists.set(folderId, { id: folderId, name, nameAt: t, createdAt: t, deleted: false, deletedAt: 0, members: [] });
    return folderId;
  }

  renameFolder(folderId, name) {
    const f = this.lists.get(folderId);
    this.lists.set(folderId, { ...f, name, nameAt: this.now() });
  }

  deleteFolder(folderId) {
    const f = this.lists.get(folderId);
    this.lists.set(folderId, { ...f, deleted: true, deletedAt: this.now() });
  }

  setMember(folderId, scoreId, inFolder) {
    const f = this.lists.get(folderId) || { id: folderId, name: 'Favorites', nameAt: 0, createdAt: this.now(), deleted: false, deletedAt: 0, members: [] };
    const members = f.members.filter((m) => m.score !== scoreId);
    members.push({ score: scoreId, in: inFolder, at: this.now() });
    this.lists.set(folderId, { ...f, members });
  }

  // Names of the scores in a folder, or null if there's no such folder here.
  folderNames(folderId) {
    const f = this.lists.get(folderId);
    if (!f || f.deleted) return null;
    return f.members.filter((m) => m.in && this.files.has(m.score)).map((m) => this.files.get(m.score).name).sort();
  }

  byName(name) {
    return [...this.files.values()].find((f) => f.name === name);
  }

  names() {
    return [...this.files.values()].map((f) => f.name).sort();
  }

  // ---- The adapter surface ----

  async scores() {
    return [...this.files.values()].map((f) => ({ ...f }));
  }

  async records() {
    const pick = (prefix) => new Map([...this.kv].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), structuredClone(v)]));
    return {
      links: pick('sync:link:'),
      tombs: pick('sync:tomb:'),
      uploads: pick('sync:upload:'),
      trashed: pick('sync:trashed:'),
      state: structuredClone(this.kv.get('sync:state') || {}),
      data: structuredClone(this.kv.get('sync:data') || {}),
      restore: structuredClone(this.kv.get('sync:restore') || null),
    };
  }

  async pdf(id) {
    const b = this.blobs.get(id);
    return b ? new Blob([b], { type: 'application/pdf' }) : null;
  }

  async addScore(blob, buf, fields) {
    this.#maybeFail('addScore');
    const bytes = new Uint8Array(buf);
    // Like the real one, it looks at the library only when it stores.
    if (this.beforeStore) await this.beforeStore(fields);
    for (const f of this.files.values()) if (f.hash === fields.hash) return f.id;
    if (this.files.has(fields.id)) return null;
    this.files.set(fields.id, { ...fields, size: bytes.length });
    this.blobs.set(fields.id, bytes);
    return fields.id;
  }

  async replaceContent(id, blob, buf, hash) {
    const f = this.files.get(id);
    if (!f) return null;
    f.hash = hash;
    f.size = buf.byteLength;
    this.blobs.set(id, new Uint8Array(buf));
    return id;
  }

  async renameScore(id, name, expectName) {
    const f = this.files.get(id);
    if (!f || f.name !== expectName) return false;
    f.name = name;
    return true;
  }

  async deleteScore(id) {
    this.#forget(id);
  }

  async rekey(from, to) {
    this.#maybeFail('rekey');
    if (!this.files.has(from) || this.files.has(to)) return false;
    this.files.set(to, { ...this.files.get(from), id: to });
    this.files.delete(from);
    this.blobs.set(to, this.blobs.get(from));
    this.blobs.delete(from);
    const pos = this.positions.get(from);
    if (pos) this.positions.set(to, { ...pos, id: to });
    this.positions.delete(from);
    for (const kind of ['link', 'upload']) {
      const v = this.kv.get(`sync:${kind}:${from}`);
      this.kv.delete(`sync:${kind}:${from}`);
      if (v) this.kv.set(`sync:${kind}:${to}`, v);
    }
    return true;
  }

  async room() { return this.free; }
  async partial(driveId) { return [...(this.parts.get(driveId) || [])]; }
  async savePart(driveId, index, blob) {
    const list = this.parts.get(driveId) || [];
    list[index] = blob;
    this.parts.set(driveId, list);
  }
  async dropPartial(driveId) { this.parts.delete(driveId); }
  async partials() { return [...this.parts.keys()]; }

  async setLink(id, link) { this.kv.set(`sync:link:${id}`, structuredClone(link)); }
  async dropLink(id) { this.kv.delete(`sync:link:${id}`); }
  async dropTomb(id) { this.kv.delete(`sync:tomb:${id}`); }
  async setUpload(id, rec) { this.kv.set(`sync:upload:${id}`, structuredClone(rec)); }
  async noteTrashed(driveId, at) { this.kv.set(`sync:trashed:${driveId}`, at); }
  async forgetTrashed(driveId) { this.kv.delete(`sync:trashed:${driveId}`); }
  async dropUpload(id) { this.kv.delete(`sync:upload:${id}`); }
  async setState(patch) { this.kv.set('sync:state', { ...(this.kv.get('sync:state') || {}), ...patch }); }

  async notesRecords() { return [...this.annotations.values()].map((r) => structuredClone(r)); }
  async folders() { return [...this.lists.values()].map((f) => structuredClone(f)); }
  async places() { return [...this.positions.values()].map((p) => structuredClone(p)); }
  async pageTexts() {
    return [...this.kv].filter(([k]) => k.startsWith('ocr:')).map(([k, v]) => {
      const i = k.lastIndexOf(':');
      return { fileId: k.slice(4, i), page: Number(k.slice(i + 1)), text: v.text, at: v.at };
    });
  }
  async applyData({ notes, lists, zooms = [], texts = [] }) {
    for (const t of texts) {
      if (!this.files.has(t.fileId)) continue;
      const key = `ocr:${t.fileId}:${t.page}`;
      const here = this.kv.get(key);
      if (!here || here.at < t.at) this.kv.set(key, { v: 1, text: t.text, at: t.at });
    }
    for (const z of zooms) {
      if (!this.files.has(z.fileId)) continue;
      const p = this.positions.get(z.fileId);
      if (p && p.zoomAt >= z.at) continue;
      this.positions.set(z.fileId, { ...(p || { id: z.fileId, page: 0, frac: 0 }), zoom: z.zoom, zoomAt: z.at });
    }
    this.#maybeFail('applyData');
    for (const { fileId, page, data } of notes) {
      if (!this.files.has(fileId)) continue;
      const key = `${fileId}:${page}`;
      const merged = mergePage(this.annotations.get(key), data);
      if (!pageIsEmpty(merged)) this.annotations.set(key, { id: key, fileId, page, ...merged });
    }
    for (const f of lists) this.lists.set(f.id, mergeFolder(this.lists.get(f.id), { ...f, members: f.members.filter((m) => this.files.has(m.score)) }));
  }
  async setDataState(state, restore) {
    this.kv.set('sync:data', structuredClone(state));
    if (restore && this.kv.get('sync:restore') && this.kv.get('sync:restore').at === restore.at) this.kv.delete('sync:restore');
  }
}
