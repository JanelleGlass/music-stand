// Google Drive REST API (v3) with plain fetch. Calls take an access token
// from gdrive-auth.js; a DriveError with status 401 means it has expired.
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,mimeType,parents,size,md5Checksum,sha256Checksum,createdTime,modifiedTime,trashed,explicitlyTrashed,appProperties';

export class DriveError extends Error {
  constructor(status, message, reason = '') {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function failure(res) {
  let message = `Google Drive error ${res.status}`;
  let reason = '';
  try {
    const { error } = await res.json();
    if (error) {
      message = error.message || message;
      reason = (error.errors && error.errors[0] && error.errors[0].reason) || error.status || '';
    }
  } catch { /* not JSON */ }
  return new DriveError(res.status, message, reason);
}

const RETRY_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError']);
const RETRY_DELAYS = [1000, 2000, 4000, 8000];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Drive asks apps to retry when it is busy, waiting longer each time.
function retryable(e) {
  return e.status === 429 || e.status >= 500 || (e.status === 403 && RETRY_REASONS.has(e.reason));
}

async function request(token, url, { method = 'GET', headers = {}, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
    if (res.ok) return res;
    const e = await failure(res);
    if (attempt >= RETRY_DELAYS.length || !retryable(e)) throw e;
    await wait(RETRY_DELAYS[attempt] + Math.random() * 500);
  }
}

// Whether Google's API answers at all: asked without a sign-in, a real
// answer is a readable 401. No network, or a wifi login page in the way,
// shows up as a failed request.
export async function googleAnswers(timeoutMs = 4000) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/about?fields=kind`, { cache: 'no-store', signal: ctrl.signal });
    return res.status === 401 || res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function getAbout(token) {
  const res = await request(token, `${API}/about?fields=user(displayName,emailAddress)`);
  return (await res.json()).user;
}

export async function getFile(token, id, fields = FILE_FIELDS) {
  const res = await request(token, `${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`);
  return res.json();
}

export async function deleteFile(token, id) {
  await request(token, `${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Every file matching q, across all pages of results.
export async function listFiles(token, q, fields = FILE_FIELDS) {
  // Keyed by id: a file changed while the pages are read can turn up twice.
  const out = new Map();
  let pageToken = '';
  do {
    const params = new URLSearchParams({ q, pageSize: '1000', spaces: 'drive', fields: `nextPageToken,files(${fields})` });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await (await request(token, `${API}/files?${params}`)).json();
    for (const f of body.files || []) out.set(f.id, f);
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return [...out.values()];
}

// A file without content (a folder, say).
export async function createFile(token, metadata, fields = FILE_FIELDS) {
  const res = await request(token, `${API}/files?fields=${encodeURIComponent(fields)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(metadata),
  });
  return res.json();
}

// Changes a file's name, trashed state or appProperties. params: more query
// parameters (addParents and removeParents move it to another folder).
export async function updateFile(token, id, metadata, fields = FILE_FIELDS, params = {}) {
  const query = new URLSearchParams({ fields, ...params });
  const res = await request(token, `${API}/files/${encodeURIComponent(id)}?${query}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(metadata),
  });
  return res.json();
}

// A small file sent in one request: its details and its content together.
function multipart(metadata, text, type) {
  const boundary = `ms${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${type}\r\n\r\n${text}\r\n--${boundary}--`;
  return { body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } };
}

// A new small file with text content (notes, folders).
export async function createTextFile(token, metadata, text, type = 'application/json') {
  const { body, headers } = multipart({ ...metadata, mimeType: type }, text, type);
  const res = await request(token, `${UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'POST', headers, body });
  return res.json();
}

// New text content for a file, and optionally new details (name, appProperties).
export async function updateTextFile(token, id, text, metadata = {}, type = 'application/json') {
  const { body, headers } = multipart(metadata, text, type);
  const res = await request(token, `${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'PATCH', headers, body });
  return res.json();
}

// A file's content as text.
export async function downloadText(token, id) {
  const res = await request(token, `${API}/files/${encodeURIComponent(id)}?alt=media`);
  return res.text();
}

// A file's whole content.
export async function download(token, id) {
  const res = await request(token, `${API}/files/${encodeURIComponent(id)}?alt=media`);
  return res.blob();
}

// Starts a resumable upload and returns its session address. Drive keeps the
// session for about a week, so an upload can carry on after the iPad sleeps.
export async function startUpload(token, metadata, size, type = 'application/octet-stream') {
  const res = await request(token, `${UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': type,
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify(metadata),
  });
  const session = res.headers.get('Location');
  if (!session) throw new DriveError(0, 'Google Drive didn’t say where to upload (Location header not readable).');
  return session;
}

// The same for new content of an existing file.
export async function startUpdateUpload(token, id, size, type = 'application/octet-stream') {
  const res = await request(token, `${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': type,
      'X-Upload-Content-Length': String(size),
    },
    body: '{}',
  });
  const session = res.headers.get('Location');
  if (!session) throw new DriveError(0, 'Google Drive didn’t say where to upload (Location header not readable).');
  return session;
}

// 308 "resume incomplete" carries a Range header ("bytes=0-262143") saying
// what Drive has so far; anything else successful is the finished file.
async function uploadResult(res) {
  if (res.status === 308) {
    const range = res.headers.get('Range');
    return { next: range ? Number(range.split('-')[1]) + 1 : 0, range };
  }
  if (res.ok) return { file: await res.json() };
  throw await failure(res);
}

function sessionHeaders(token, extra) {
  return token ? { Authorization: `Bearer ${token}`, ...extra } : extra;
}

// Sends one piece of an upload: chunk holds bytes from start onwards, out of
// total. Every piece but the last must be a multiple of 256 KiB. Returns
// { next } while more is needed, or { file } once Drive has it all.
export async function uploadChunk(session, chunk, start, total, token) {
  const range = `bytes ${start}-${start + chunk.size - 1}/${total}`;
  const res = await fetch(session, { method: 'PUT', headers: sessionHeaders(token, { 'Content-Range': range }), body: chunk });
  return uploadResult(res);
}

// Asks how much of an interrupted upload Drive already has.
export async function uploadStatus(session, total, token) {
  const res = await fetch(session, { method: 'PUT', headers: sessionHeaders(token, { 'Content-Range': `bytes */${total}` }) });
  return uploadResult(res);
}

// Bytes start..end (inclusive) of a file's content.
export async function downloadRange(token, id, start, end) {
  const res = await request(token, `${API}/files/${encodeURIComponent(id)}?alt=media`, { headers: { Range: `bytes=${start}-${end}` } });
  const contentRange = res.headers.get('Content-Range'); // "bytes 0-99/614400"
  return {
    status: res.status,
    bytes: new Uint8Array(await res.arrayBuffer()),
    total: contentRange ? Number(contentRange.split('/')[1]) : null,
    contentRange,
  };
}
