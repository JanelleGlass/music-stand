// Google Drive's side of sync, in the shape js/sync-engine.js expects
// (tests/fake-drive.mjs is the test version).
import * as drive from './gdrive.js';
import { FOLDER_MIME } from './sync-plan.js';
import { DATA_NAME } from './sync-data.js';

// Everything the app made for sync, in the trash or not.
const LISTING = "(appProperties has { key='msKind' and value='score' } or appProperties has { key='msKind' and value='folder' } or appProperties has { key='msKind' and value='retired' }) and (trashed = true or trashed = false)";

const DATA_LISTING = "appProperties has { key='msKind' and value='data' } and trashed = false";
// Drive takes files up to 5 MB in one request; a bigger data file goes the
// resumable way, in one piece.
const ONE_REQUEST = 4 * 1024 * 1024;
const DATA_DETAILS = {
  name: DATA_NAME,
  mimeType: 'application/json',
  appProperties: { msKind: 'data' },
  description: 'Music Stand keeps your markings, favorites and folders here. Leave this file as it is.',
};

async function sendWhole(session, blob) {
  const r = await drive.uploadChunk(session, blob, 0, blob.size);
  if (!r.file) throw new drive.DriveError(0, 'Google Drive didn’t take the whole notes-and-folders file.');
  return r.file;
}

const CHUNK = 32 * 256 * 1024; // 8 MiB; pieces must be multiples of 256 KiB
const MAX_FAILURES = 5;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Worth trying an upload piece again: the network dropped, or Drive is busy.
function retryable(e) {
  return e.name === 'TypeError' || e.status >= 500 || e.status === 429 ||
    (e.status === 403 && (e.reason === 'rateLimitExceeded' || e.reason === 'userRateLimitExceeded'));
}

// getToken() returns an access token, or throws a DriveError with status 401
// once it has run out.
export function driveRemote(getToken) {
  return {
    list: () => drive.listFiles(getToken(), LISTING),

    createFolder: (name, appProperties) => drive.createFile(getToken(), {
      name,
      mimeType: FOLDER_MIME,
      appProperties,
      description: 'Music Stand keeps your scores here. Add music with the Add PDF button in the app: files put in this folder directly don’t show up in it.',
    }),

    get: (id) => drive.getFile(getToken(), id),

    update: (id, patch) => drive.updateFile(getToken(), id, patch),

    move: (id, from, to) => drive.updateFile(getToken(), id, {}, undefined, { addParents: to, removeParents: from }),

    download: (id) => drive.download(getToken(), id),

    // The markings-and-folders file (js/sync-data.js).
    listData: () => drive.listFiles(getToken(), DATA_LISTING),
    readData: (id) => drive.downloadText(getToken(), id),
    async createData(folderId, text) {
      const blob = new Blob([text], { type: 'application/json' });
      if (blob.size <= ONE_REQUEST) return drive.createTextFile(getToken(), { ...DATA_DETAILS, parents: [folderId] }, text);
      return sendWhole(await drive.startUpload(getToken(), { ...DATA_DETAILS, parents: [folderId] }, blob.size, 'application/json'), blob);
    },
    async writeData(id, text) {
      const blob = new Blob([text], { type: 'application/json' });
      if (blob.size <= ONE_REQUEST) return drive.updateTextFile(getToken(), id, text);
      return sendWhole(await drive.startUpdateUpload(getToken(), id, blob.size, 'application/json'), blob);
    },
    // A file that can't be read is kept, out of the way, rather than lost.
    setAside: (id) => drive.updateFile(getToken(), id, { name: 'Music Stand notes and folders (unreadable).json', appProperties: { msKind: 'data-bad' } }),

    // Bytes start..end of a file. whole: Drive sent the entire file instead.
    async downloadRange(id, start, end) {
      const r = await drive.downloadRange(getToken(), id, start, end);
      return { bytes: r.bytes, whole: r.status === 200 };
    },

    // A resumable upload, in pieces. The pieces go without the token (the
    // session address is enough, as the iPad test showed), so a big upload
    // carries on after the hour-long sign-in runs out. Resolves to the new
    // file, or null if shouldStop() asked it to pause.
    async upload(metadata, blob, { resumeFrom = null, onSession = () => {}, onProgress = () => {}, shouldStop = () => false } = {}) {
      const size = blob.size;
      let session = resumeFrom;
      let next = 0;
      if (session) {
        // An expired session looks like a network failure in Safari (Drive's
        // 404 has no CORS header), so ask a few times, and if Google itself
        // doesn't answer either, stop here and keep the session for later.
        let r = null;
        let offline = true;
        for (let i = 0; i < 3 && !r; i++) {
          if (i) await wait(1000 * 2 ** i);
          try {
            r = await drive.uploadStatus(session, size);
          } catch (e) {
            if (!retryable(e)) {
              offline = false;
              break;
            }
            if (e.name !== 'TypeError') offline = false;
          }
        }
        if (!r && offline && !(await drive.googleAnswers())) throw new TypeError('Load failed');
        if (r && r.file) return r.file;
        if (r) next = r.next;
        else session = null;
      }
      if (!session) {
        session = await drive.startUpload(getToken(), metadata, size, 'application/pdf');
        await onSession(session);
        next = 0;
      }
      // Consecutive failures; any progress starts the count again.
      let failures = 0;
      for (;;) {
        if (shouldStop()) return null;
        let r;
        try {
          r = await drive.uploadChunk(session, blob.slice(next, Math.min(size, next + CHUNK)), next, size);
          if (!r.file && r.next <= next && ++failures > MAX_FAILURES) throw new drive.DriveError(0, 'Google Drive stopped taking the upload.');
        } catch (e) {
          // A dropped connection or a busy Drive: wait, ask how much it has,
          // and carry on from there.
          if (!retryable(e) || ++failures > MAX_FAILURES) throw e;
          await wait(Math.min(32_000, 1000 * 2 ** failures) + Math.random() * 1000);
          try {
            r = await drive.uploadStatus(session, size);
          } catch (e2) {
            if (!retryable(e2)) throw e2;
            continue;
          }
        }
        if (r.file) return r.file;
        if (r.next > next) failures = 0;
        next = r.next;
        onProgress(next, size);
      }
    },
  };
}
