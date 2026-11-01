// Google sign-in for Drive, without a server.
//
// Google gives browser-only apps access tokens that last about an hour and no
// refresh tokens, so each new hour of Drive access means another pass through
// Google. There are two ways to make that pass:
//  - pop-up (Google Identity Services token client): must start from a tap;
//    the app stays where it is.
//  - redirect (OAuth implicit grant): the page goes to Google and comes back
//    to this page with #access_token=…; needs no tap, but reloads the app.
//    Google calls this route "legacy" but still documents it, and it's the
//    one Home Screen apps on iPad are expected to handle.
// The Google Drive test panel in Settings checks which works on a device.

// From Google Cloud › Google Auth Platform › Clients. Not a secret: Google
// only accepts it from the origins listed with it.
export const CLIENT_ID = '867655341823-6agr4u77pj8duss1ldl7ihqc9j6mq44s.apps.googleusercontent.com';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GIS_URL = 'https://accounts.google.com/gsi/client';
const TOKEN_KEY = 'ms:gdrive:token'; // { accessToken, expiresAt, scope }
const ACCOUNT_KEY = 'ms:gdrive:account'; // { email, name }
const PENDING_KEY = 'ms:gdrive:pending'; // redirect in flight
const PENDING_TTL = 10 * 60 * 1000;

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked */ }
}

export function isConfigured() {
  return !!CLIENT_ID;
}

export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// The stored token, if it's good for at least minMs more.
export function currentToken(minMs = 60_000) {
  const t = read(TOKEN_KEY);
  return t && t.expiresAt - Date.now() > minMs ? t : null;
}

export function getAccount() {
  return read(ACCOUNT_KEY);
}

// Remembered so later sign-ins can skip Google's account chooser.
export function setAccount(account) {
  write(ACCOUNT_KEY, account);
}

// The account Google Drive sync is connected to, or null. (An account kept
// by the earlier Drive test panel, without sync: true, doesn't count.)
export function syncAccount() {
  const account = getAccount();
  return account && account.sync ? account : null;
}

function grantedDrive(scope) {
  return String(scope || '').split(/\s+/).includes(SCOPE);
}

function saveToken(accessToken, expiresIn, scope) {
  const t = { accessToken, expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000, scope: scope || SCOPE };
  write(TOKEN_KEY, t);
  return t;
}

// The token was refused (expired or revoked): forget it.
export function dropToken() {
  write(TOKEN_KEY, null);
}

// Forgets the sign-in and the account on this device only. (Withdrawing the
// app's access at Google would cut off the person's other devices too.)
export function forget() {
  write(TOKEN_KEY, null);
  write(ACCOUNT_KEY, null);
}

// ---- Redirect ----

export function redirectUri() {
  return new URL('./', location.href).href;
}

function randomState() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Leaves the app for Google; takeRedirectResult() picks up the answer when
// this page loads again. silent: fail instead of showing any Google screen.
// purpose is handed back with the result so the app knows what to resume.
export function signInWithRedirect({ silent = false, purpose = 'sync' } = {}) {
  // The ending says where the sign-in started, so the answer can tell it
  // landed in Google's sheet even if the sheet can't read this app's storage.
  const state = randomState() + (isStandalone() ? '.app' : '.tab');
  write(PENDING_KEY, { state, at: Date.now(), returnHash: location.hash, purpose, standalone: isStandalone() });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  if (silent) params.set('prompt', 'none');
  const account = getAccount();
  if (account && account.email) params.set('login_hint', account.email);
  location.assign(`${AUTH_URL}?${params}`);
}

// Call once at startup, before routing. If this load is Google sending the
// user back, stores the token, restores the app's own address and returns
// { ok, error, purpose, inSheet }; otherwise returns null.
// inSheet: the answer landed in the sign-in sheet over a Home Screen app
// rather than in the app itself.
export function takeRedirectResult() {
  const hash = location.hash.slice(1);
  if (!/(^|&)(access_token|error)=/.test(hash)) return null;
  const p = new URLSearchParams(hash);
  const state = p.get('state') || '';
  const pending = read(PENDING_KEY);
  const fresh = !!pending && Date.now() - pending.at < PENDING_TTL;
  const out = { ok: false, error: null, purpose: fresh ? pending.purpose : null, inSheet: false };
  // Without a matching sign-in started here, a token can't be trusted.
  if (!pending) out.error = `no_sign_in_started_here (Google answered: ${p.get('error') || (p.get('access_token') ? 'a token' : 'nothing usable')})`;
  else if (!fresh) out.error = 'sign_in_too_old';
  else if (state !== pending.state) out.error = 'state_mismatch';
  else if (p.get('error')) out.error = p.get('error');
  else if (!grantedDrive(p.get('scope'))) out.error = 'drive_not_allowed';
  else {
    saveToken(p.get('access_token'), p.get('expires_in'), p.get('scope'));
    out.ok = true;
  }
  // The pending entry stays until it expires: the hand-back from Google's
  // sheet can load this page twice, and both loads must succeed.
  out.inSheet = state.endsWith('.app') && !isStandalone();
  // answered: the sign-in came back. taken: this copy of the app acts on it
  // (the sheet's copy leaves that to the app underneath).
  if (fresh && state === pending.state) write(PENDING_KEY, { ...pending, answered: true, taken: !out.inSheet });
  history.replaceState(null, '', location.pathname + location.search + ((fresh && pending.returnHash) || ''));
  return out;
}

// A sign-in whose answer came back in another copy of the app (Google's
// sheet over the Home Screen app): returns its purpose once, or null.
export function takeAnsweredSignIn() {
  const pending = read(PENDING_KEY);
  if (!pending || !pending.answered || pending.taken || Date.now() - pending.at > PENDING_TTL) return null;
  write(PENDING_KEY, { ...pending, taken: true });
  return pending.purpose;
}

// A sign-in that left for Google and never came back (no network, a wifi
// login page, the app was closed): returns its purpose once, or null.
// Call at startup after takeRedirectResult().
export function takeAbandonedSignIn() {
  const pending = read(PENDING_KEY);
  if (!pending || pending.answered || Date.now() - pending.at < 15_000) return null;
  write(PENDING_KEY, null);
  return pending.purpose;
}

// ---- Pop-up ----

let gisPromise = null;
let tokenClient = null;
let waiting = null;

function finishPopup(err, token) {
  const w = waiting;
  waiting = null;
  if (!w) return;
  if (err) w.reject(err);
  else w.resolve(token);
}

// Loads Google's sign-in script ahead of time: the pop-up has to open
// straight from a tap, with nothing to wait for in between.
export function preparePopup() {
  if (!CLIENT_ID) return Promise.reject(new Error('Google Drive isn’t set up yet.'));
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_URL;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Couldn’t reach Google. Check the internet connection.'));
      document.head.appendChild(s);
    }).then(() => {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        prompt: '',
        callback: (resp) => {
          if (resp.error) finishPopup(Object.assign(new Error(resp.error_description || resp.error), { code: resp.error }));
          else if (!grantedDrive(resp.scope)) finishPopup(Object.assign(new Error('Drive access wasn’t allowed.'), { code: 'drive_not_allowed' }));
          else finishPopup(null, saveToken(resp.access_token, resp.expires_in, resp.scope));
        },
        error_callback: (err) => finishPopup(Object.assign(new Error(err.message || err.type), { code: err.type })),
      });
    });
    gisPromise.catch(() => { gisPromise = null; });
  }
  return gisPromise;
}

export function popupReady() {
  return !!tokenClient;
}

// Call synchronously from a tap, once preparePopup() has finished. Google
// asks for permission the first time only.
export function signInWithPopup() {
  if (!tokenClient) return Promise.reject(new Error('Google sign-in is still loading. Try again in a moment.'));
  finishPopup(Object.assign(new Error('Replaced by a newer sign-in'), { code: 'superseded' }));
  return new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    const opts = { prompt: '' };
    const account = getAccount();
    if (account && account.email) opts.login_hint = account.email;
    tokenClient.requestAccessToken(opts);
  });
}
