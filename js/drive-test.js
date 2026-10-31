// Settings › Google Drive (test): tries both ways of signing in to Google and
// a small upload and download, and keeps a report that can be copied and sent.
// It never touches the library.
import * as auth from './gdrive-auth.js';
import * as drive from './gdrive.js';
import { $, toast } from './ui.js';

const LOG_KEY = 'ms:gdrive:log';
const MAX_LINES = 300;
const KiB = 1024;

const minutesLeft = (t) => Math.max(0, Math.round((t.expiresAt - Date.now()) / 60000));
const secondsSince = (t0) => ((Date.now() - t0) / 1000).toFixed(1);
const where = () => `${auth.isStandalone() ? 'Home Screen app' : 'browser tab'}, ${navigator.userAgent}`;

export function initDriveTest() {
  const logEl = $('#d-log');
  const statusEl = $('#d-status');
  let lines = [];
  load();
  let seenToken = (auth.currentToken(0) || {}).accessToken;
  render();
  updateStatus();

  // The stored report is the real one: a second copy of the app, in Google's
  // sign-in sheet, can add to it. Re-read it before adding or showing.
  function load() {
    try { lines = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { /* keep what's here */ }
  }

  function log(text) {
    load();
    lines.push(`${new Date().toLocaleTimeString()}  ${text}`);
    lines = lines.slice(-MAX_LINES);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(lines)); } catch { /* storage blocked */ }
    render();
  }

  function render() {
    logEl.textContent = lines.join('\n');
    logEl.hidden = !lines.length;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function updateStatus() {
    const t = auth.currentToken(0);
    const account = auth.getAccount();
    if (!auth.isConfigured()) {
      statusEl.className = 'status-line s-error';
      statusEl.textContent = 'Not ready: the app doesn’t have its Google Client ID yet.';
    } else if (t) {
      statusEl.className = 'status-line s-running';
      statusEl.textContent = `Signed in${account ? ` as ${account.email}` : ''}, access for ${minutesLeft(t)} more min`;
    } else {
      statusEl.className = 'status-line';
      statusEl.textContent = account ? `Not signed in right now (last time: ${account.email})` : 'Not signed in';
    }
    for (const id of ['d-popup', 'd-redirect', 'd-silent', 'd-drive']) $('#' + id).disabled = !auth.isConfigured();
  }

  // A token that turns up while the app was in the background came from
  // Google's sign-in sheet.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    load();
    render();
    const t = auth.currentToken(0);
    if (t && t.accessToken !== seenToken) log(`Token appeared while the app was in the background (${minutesLeft(t)} min).`);
    seenToken = t && t.accessToken;
    updateStatus();
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== LOG_KEY && e.key !== null) return;
    load();
    render();
  });

  async function whoAmI(t) {
    const user = await drive.getAbout(t.accessToken);
    auth.setAccount({ email: user.emailAddress, name: user.displayName });
    log(`PASS Drive knows you as ${user.emailAddress}`);
  }

  function fail(step, e) {
    if (e && e.status === 401) auth.dropToken();
    log(`FAIL ${step}: ${(e && (e.code || e.status)) || ''} ${(e && e.message) || e}`);
  }

  $('#d-popup').addEventListener('click', () => {
    log(`Pop-up sign-in… (${where()})`);
    const t0 = Date.now();
    const slow = setTimeout(() => log('…no answer from the pop-up after 60 s.'), 60_000);
    // Must run straight from the tap, so the pop-up isn't blocked.
    auth.signInWithPopup()
      .then(async (t) => {
        seenToken = t.accessToken;
        log(`PASS pop-up: signed in after ${secondsSince(t0)} s, access for ${minutesLeft(t)} min`);
        await whoAmI(t).catch((e) => fail('asking Drive who you are', e));
      })
      .catch((e) => fail(`pop-up (after ${secondsSince(t0)} s)`, e))
      .finally(() => { clearTimeout(slow); updateStatus(); });
  });

  $('#d-redirect').addEventListener('click', () => {
    log(`Redirect sign-in… (${where()})`);
    auth.signInWithRedirect({ purpose: 'test' });
  });

  $('#d-silent').addEventListener('click', () => {
    if (!auth.getAccount()) log('(No account remembered yet, so Google may ask which account to use.)');
    log('Silent renewal: redirect that must not show any Google screen…');
    auth.signInWithRedirect({ silent: true, purpose: 'test' });
  });

  $('#d-drive').addEventListener('click', () => {
    runDriveTest().catch((e) => fail('Drive test', e)).finally(updateStatus);
  });

  async function runDriveTest() {
    const t = auth.currentToken();
    if (!t) {
      log('Sign in first.');
      return;
    }
    const token = t.accessToken;
    log('Drive test: starting');
    await whoAmI(t);

    const total = 600 * KiB;
    const piece = 256 * KiB;
    const data = new Uint8Array(total);
    for (let i = 0; i < total; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
    const blob = new Blob([data]);
    const session = await drive.startUpload(token, { name: 'Music Stand test (safe to delete).bin' }, total);
    log('PASS upload started; upload address readable');

    // The first piece goes without the token: if Drive takes it, uploads
    // can carry on after the hour-long token has run out.
    let r;
    let pieceToken; // stays unset while Drive takes pieces without it
    try {
      r = await drive.uploadChunk(session, blob.slice(0, piece), 0, total);
      log(`${r.next === piece ? 'PASS' : 'CHECK'} piece 1 without token: Drive has ${r.next} bytes (Range header: ${r.range || 'missing'})`);
    } catch (e) {
      // Not fail(): a refusal here says nothing about the token itself.
      log(`CHECK piece 1 without token refused: ${(e && e.status) || ''} ${(e && e.message) || e}`);
      pieceToken = token;
      r = await drive.uploadChunk(session, blob.slice(0, piece), 0, total, pieceToken);
      log(`piece 1 with token: Drive has ${r.next} bytes (Range header: ${r.range || 'missing'})`);
    }

    // What resuming after the iPad slept would do.
    r = await drive.uploadStatus(session, total, pieceToken);
    log(`${r.next === piece ? 'PASS' : 'CHECK'} resume check: Drive has ${r.next} bytes (Range header: ${r.range || 'missing'})`);

    r = await drive.uploadChunk(session, blob.slice(r.next, r.next + piece), r.next, total, token);
    r = await drive.uploadChunk(session, blob.slice(r.next), r.next, total, pieceToken);
    if (!r.file) throw new Error(`upload didn’t finish (Drive has ${r.next} bytes)`);
    log(`PASS upload finished: ${r.file.size} bytes`);

    const id = r.file.id;
    try {
      const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) => b.toString(16).padStart(2, '0')).join('');
      const meta = await drive.getFile(token, id);
      const sha = meta.sha256Checksum || r.file.sha256Checksum;
      log(`${sha === expected ? 'PASS' : 'CHECK'} Drive's SHA-256 ${sha ? (sha === expected ? 'matches' : 'differs') : 'not given'}; MD5 ${meta.md5Checksum ? 'given' : 'not given'}`);

      try {
        const part = await drive.downloadRange(token, id, 1000, 1999);
        const same = part.bytes.length === 1000 && part.bytes.every((b, i) => b === data[1000 + i]);
        log(`${same && part.status === 206 ? 'PASS' : 'FAIL'} partial download: status ${part.status}, ${part.bytes.length} bytes ${same ? 'match' : 'DIFFER'} (Content-Range: ${part.contentRange || 'missing'})`);
      } catch (e) {
        fail('partial download', e);
      }
    } finally {
      // Never leave the test file in the user's Drive.
      await drive.deleteFile(token, id).then(
        () => log('PASS test file deleted.'),
        (e) => fail('deleting the test file (delete “Music Stand test (safe to delete).bin” from My Drive by hand)', e),
      );
    }
    log('Drive test done.');
  }

  $('#d-copy').addEventListener('click', async () => {
    load();
    render();
    const text = `Music Stand Google Drive test\n${lines.join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Report copied. Paste it into your message.');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(logEl);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast('Couldn’t copy automatically. The report is selected; tap Copy.');
    }
  });

  $('#d-clear').addEventListener('click', () => {
    lines = [];
    try { localStorage.removeItem(LOG_KEY); } catch { /* storage blocked */ }
    render();
  });

  $('#d-signout').addEventListener('click', () => {
    const asked = auth.signOut();
    seenToken = null;
    log(asked
      ? 'Signed out; asked Google to withdraw the app’s Drive access.'
      : 'Signed out here only: no unexpired token to withdraw access with, so Google may still remember the app (myaccount.google.com/permissions).');
    updateStatus();
  });

  return {
    // Settings opened: get Google's script ready so the pop-up can open
    // straight from a tap.
    prepare() {
      load();
      render();
      updateStatus();
      if (auth.isConfigured() && !auth.popupReady()) {
        auth.preparePopup().catch((e) => log(`Couldn’t load Google sign-in: ${e.message}`));
      }
    },
    // The app just came back from Google's sign-in page.
    reportRedirect(result) {
      const t = auth.currentToken(0);
      if (result.ok) {
        seenToken = t && t.accessToken;
        log(`PASS redirect: signed in, access for ${t ? minutesLeft(t) : '?'} min (${where()})`);
        if (t) whoAmI(t).catch((e) => fail('asking Drive who you are', e)).finally(updateStatus);
      } else {
        log(`FAIL redirect: ${result.error} (${where()})`);
      }
      if (result.inSheet) log('Note: this answer arrived in Google’s sign-in sheet, not in the app itself.');
      if (result.withoutReload) log('Note: this answer reached the running app without a reload.');
      updateStatus();
    },
  };
}
