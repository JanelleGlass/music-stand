// Google Drive REST API (v3) with plain fetch. Calls take an access token
// from gdrive-auth.js; a DriveError with status 401 means it has expired.
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,size,md5Checksum,sha256Checksum,modifiedTime,trashed,appProperties';

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

async function request(token, url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  if (!res.ok) throw await failure(res);
  return res;
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
