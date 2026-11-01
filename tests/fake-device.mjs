// An in-memory device for the sync tests: the library plus the sync records,
// with the same surface as the app's local adapter (js/sync-local.js), and the
// things a person does in the app (add, rename, delete).
import { sha256Hex as sha } from './sha256.mjs';

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
    this.files.delete(id);
    this.blobs.delete(id);
    this.positions.delete(id);
    this.kv.set(`sync:tomb:${id}`, { hash: f.hash, at: this.now() });
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
    this.files.delete(id);
    this.blobs.delete(id);
    this.positions.delete(id);
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
}
