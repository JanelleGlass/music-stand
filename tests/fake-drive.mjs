// An in-memory Google Drive with the same surface as the app's Drive adapter
// (js/sync-remote.js), shared by several fake devices in the sync tests.
import { sha256Hex as sha } from './sha256.mjs';

export class FakeDrive {
  constructor() {
    this.files = new Map(); // id -> { meta, bytes }
    this.clock = 1_700_000_000_000;
    this.seq = 0;
    this.sessions = new Map();
    this.failures = []; // { op, error, after } consumed in order
    this.calls = [];
  }

  tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  // The next call of op throws error (once). after: let the call do its
  // work first, then throw (the reply was lost).
  failNext(op, error = new Error(`fake ${op} failure`), { after = false } = {}) {
    this.failures.push({ op, error, after });
  }

  #maybeFail(op, when) {
    const i = this.failures.findIndex((f) => f.op === op && f.after === (when === 'after'));
    if (i < 0) return;
    const [f] = this.failures.splice(i, 1);
    throw f.error;
  }

  #copy(meta) {
    return JSON.parse(JSON.stringify(meta));
  }

  #create(metadata, bytes) {
    const id = `drive-${++this.seq}`;
    const now = this.tick();
    const meta = {
      id,
      name: metadata.name,
      mimeType: metadata.mimeType || 'application/octet-stream',
      parents: metadata.parents || ['root'],
      trashed: false,
      explicitlyTrashed: false,
      createdTime: now,
      modifiedTime: now,
      appProperties: { ...(metadata.appProperties || {}) },
    };
    if (bytes) {
      meta.size = String(bytes.length);
      meta.sha256Checksum = sha(bytes);
    }
    this.files.set(id, { meta, bytes });
    return meta;
  }

  // ---- The adapter surface ----

  async list() {
    this.calls.push('list');
    this.#maybeFail('list', 'before');
    return [...this.files.values()].map((f) => this.#copy(f.meta));
  }

  async get(id) {
    this.calls.push(`get:${id}`);
    const f = this.files.get(id);
    if (!f) throw Object.assign(new Error('File not found'), { status: 404 });
    return this.#copy(f.meta);
  }

  async createFolder(name, appProperties) {
    this.calls.push('createFolder');
    this.#maybeFail('createFolder', 'before');
    const meta = this.#create({ name, appProperties, mimeType: 'application/vnd.google-apps.folder' });
    this.#maybeFail('createFolder', 'after');
    return this.#copy(meta);
  }

  async update(id, patch) {
    this.calls.push(`update:${id}`);
    this.#maybeFail('update', 'before');
    const f = this.files.get(id);
    if (!f) throw Object.assign(new Error('File not found'), { status: 404 });
    const m = f.meta;
    if ('name' in patch) m.name = patch.name;
    if ('trashed' in patch) {
      this.#setTrashed(m, patch.trashed, true);
    }
    if (patch.appProperties) {
      for (const [k, v] of Object.entries(patch.appProperties)) {
        if (v === null) delete m.appProperties[k];
        else m.appProperties[k] = v;
      }
    }
    this.#maybeFail('update', 'after');
    return this.#copy(m);
  }

  #setTrashed(m, trashed, explicit) {
    m.trashed = !!trashed;
    m.explicitlyTrashed = !!trashed && explicit;
    // Children of a folder follow it into (and out of) the trash.
    if (m.mimeType === 'application/vnd.google-apps.folder') {
      for (const c of this.files.values()) {
        if (c.meta.parents.includes(m.id) && (trashed || !c.meta.explicitlyTrashed)) {
          this.#setTrashed(c.meta, trashed, false);
        }
      }
    }
  }

  async move(id, from, to) {
    this.calls.push(`move:${id}`);
    this.#maybeFail('move', 'before');
    const m = this.files.get(id).meta;
    m.parents = [...m.parents.filter((p) => p !== from), to];
    return this.#copy(m);
  }

  // A new version of a file's content, as "Manage versions" in Drive does.
  webNewVersion(id, content) {
    const f = this.files.get(id);
    f.bytes = new TextEncoder().encode(content);
    f.meta.size = String(f.bytes.length);
    f.meta.sha256Checksum = sha(f.bytes);
    f.meta.modifiedTime = this.tick();
  }

  async upload(metadata, blob, { resumeFrom = null, onSession = () => {}, onProgress = () => {}, shouldStop = () => false } = {}) {
    this.calls.push('upload');
    this.#maybeFail('upload', 'before');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = resumeFrom && this.sessions.get(resumeFrom);
    if (s && s.done) return this.#copy(this.files.get(s.done).meta);
    if (!s) {
      const session = `session-${++this.seq}`;
      s = { session, metadata, sent: 0, done: null };
      this.sessions.set(session, s);
      onSession(session);
    }
    const CHUNK = 256 * 1024;
    while (s.sent < bytes.length) {
      if (shouldStop()) return null;
      s.sent = Math.min(bytes.length, s.sent + CHUNK);
      onProgress(s.sent, bytes.length);
    }
    const meta = this.#create(s.metadata, bytes);
    s.done = meta.id;
    this.#maybeFail('upload', 'after');
    return this.#copy(meta);
  }

  // ---- The markings-and-folders file ----

  async listData() {
    this.calls.push('listData');
    this.#maybeFail('listData', 'before');
    return [...this.files.values()].map((f) => f.meta).filter((m) => !m.trashed && m.appProperties.msKind === 'data').map((m) => this.#copy(m));
  }

  async readData(id) {
    this.calls.push(`readData:${id}`);
    this.#maybeFail('readData', 'before');
    const f = this.files.get(id);
    if (!f || !f.bytes) throw Object.assign(new Error('File not found'), { status: 404 });
    return new TextDecoder().decode(f.bytes);
  }

  async createData(folderId, text) {
    this.calls.push('createData');
    this.#maybeFail('createData', 'before');
    const meta = this.#create({ name: 'Music Stand notes and folders.json', parents: [folderId], mimeType: 'application/json', appProperties: { msKind: 'data' } }, new TextEncoder().encode(text));
    meta.md5Checksum = meta.sha256Checksum.slice(0, 32);
    this.#maybeFail('createData', 'after');
    return this.#copy(meta);
  }

  async writeData(id, text) {
    this.calls.push(`writeData:${id}`);
    this.#maybeFail('writeData', 'before');
    const f = this.files.get(id);
    if (!f) throw Object.assign(new Error('File not found'), { status: 404 });
    f.bytes = new TextEncoder().encode(text);
    f.meta.size = String(f.bytes.length);
    f.meta.sha256Checksum = sha(f.bytes);
    f.meta.md5Checksum = f.meta.sha256Checksum.slice(0, 32);
    f.meta.modifiedTime = this.tick();
    this.#maybeFail('writeData', 'after');
    return this.#copy(f.meta);
  }

  async setAside(id) {
    return this.update(id, { name: 'Music Stand notes and folders (unreadable).json', appProperties: { msKind: 'data-bad' } });
  }

  // The data file's content, parsed.
  data() {
    const live = this.live('data');
    if (!live.length) return null;
    return JSON.parse(new TextDecoder().decode(this.files.get(live[0].id).bytes));
  }

  // What the person can do to the file on the web.
  webWriteData(id, text) {
    const f = this.files.get(id);
    f.bytes = new TextEncoder().encode(text);
    f.meta.sha256Checksum = sha(f.bytes);
    f.meta.md5Checksum = f.meta.sha256Checksum.slice(0, 32);
  }

  async downloadRange(id, start, end) {
    this.calls.push(`range:${id}:${start}`);
    this.#maybeFail('download', 'before');
    const f = this.files.get(id);
    if (!f || !f.bytes) throw Object.assign(new Error('File not found'), { status: 404 });
    return { bytes: f.bytes.slice(start, end + 1), whole: false };
  }

  async download(id) {
    this.calls.push(`download:${id}`);
    this.#maybeFail('download', 'before');
    const f = this.files.get(id);
    if (!f || !f.bytes) throw Object.assign(new Error('File not found'), { status: 404 });
    return new Blob([f.bytes], { type: 'application/pdf' });
  }

  // ---- What the user can do in Drive in a web browser ----

  webRename(id, name) {
    const m = this.files.get(id).meta;
    m.name = name;
    m.modifiedTime = this.tick();
  }

  webTrash(id) {
    this.#setTrashed(this.files.get(id).meta, true, true);
  }

  webRestore(id) {
    this.#setTrashed(this.files.get(id).meta, false, false);
  }

  // Delete forever (or empty the trash).
  webPurge(id) {
    const m = this.files.get(id).meta;
    if (m.mimeType === 'application/vnd.google-apps.folder') {
      for (const [cid, c] of this.files) if (c.meta.parents.includes(id)) this.files.delete(cid);
    }
    this.files.delete(id);
  }

  // ---- Inspection ----

  live(kind = 'score') {
    return [...this.files.values()].map((f) => f.meta).filter((m) => !m.trashed && m.appProperties.msKind === kind);
  }
}
