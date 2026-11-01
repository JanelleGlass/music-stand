// When Google Drive sync runs on this device, and its sign-in.
//
// Google gives the app an hour of access at a time. A new hour comes either
// from a pop-up, which must start from a tap, or from a quick trip to Google
// and back that reloads the page. The trip is only made as the app starts,
// before the library is drawn (tripAtLaunch), and never again soon after one
// that didn't come back with access. Otherwise the cloud button asks for a tap.
//
// Sync never runs while a score is open; one in progress pauses and carries
// on when the library shows again.
import * as auth from './gdrive-auth.js';
import { DriveError, getAbout, googleAnswers } from './gdrive.js';
import { syncOnce, SyncStopped, SyncRefused } from './sync-engine.js';
import { driveRemote } from './sync-remote.js';
import { localStore } from './sync-local.js';
import { onLibraryEdit, listFiles } from './data.js';

const LOG_KEY = 'ms:sync:log';
const MAX_LOG = 300;
const TRIP_KEY = 'ms:sync:tripAt'; // when the last automatic trip to Google started
const DECISION_KEY = 'ms:sync:decision'; // the person's answer about held deletions
const TRIP_PAUSE_MS = 6 * 60 * 60 * 1000;
const MIN_TOKEN_MS = 2 * 60 * 1000;
const EDIT_DELAY_MS = 2000;
const FOREGROUND_GAP_MS = 2 * 60 * 1000;
const BACK_GAP_MS = 10 * 60 * 1000;
const PROBE_MS = 2500;

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const writeJson = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
};
const forgetKey = (key) => {
  try { localStorage.removeItem(key); } catch { /* storage blocked */ }
};

// What Google's error codes mean for the person.
function signInMessage(code) {
  if (code === 'consent_required') return 'Google wants you to approve Music Stand again';
  if (code === 'access_denied') return 'Google didn’t allow this account';
  return 'Google needs you to sign in again';
}

// canSync(): no score is open or opening. canReload(): the page may go to
// Google and back now by itself (library showing, nothing under way, no
// dialog open). canLeave(): the person asked to sign in, so the page may go
// even with Settings open. confirmSwitch(old, next): resolves true to connect
// with another Google account than the one this iPad synced with before.
export function initSync({ canSync, canReload, canLeave, confirmSwitch }) {
  const listeners = new Set();
  let status = { state: 'off', message: '' };
  let running = null;
  let again = false;
  let owed = false; // a sync is owed: it paused, or couldn't start
  let edited = false; // changes made here that no finished sync has sent yet
  let timer = 0;
  let lastSync = 0;
  let ready = false; // started() has run
  let held = null; // deletions waiting for the person's say
  let checkedToken = null; // the access token whose account was checked
  let lastTouch = 0;
  let wakeLock = null;
  let offlineAtStart = false; // the start-up check found no internet

  // Deletions not yet sent, or scores not yet in Drive, count as changes.
  Promise.all([localStore.records(), listFiles()]).then(([r, files]) => {
    lastSync = r.state.lastSync || 0;
    if (connected()) edited = edited || r.tombs.size > 0 || files.some((f) => !r.links.has(f.id));
    emit();
  }).catch(() => {});
  document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, true);

  // ---- Report ----

  function log(text) {
    const lines = readJson(LOG_KEY, []);
    lines.push(`${new Date().toLocaleString()}  ${text}`);
    writeJson(LOG_KEY, lines.slice(-MAX_LOG));
  }

  // ---- Status ----

  const connected = () => !!auth.syncAccount();

  function set(state, message = '') {
    status = { state, message };
    emit();
  }

  function emit() {
    if (!connected()) status = { state: 'off', message: status.state === 'off' ? status.message : '' };
    else if (status.state === 'off') status = canSync() ? { state: 'idle', message: '' } : { state: 'paused', message: 'Sync waits until the score is closed' };
    const s = { ...status, account: auth.syncAccount(), lastSync, pending: edited, held };
    for (const fn of listeners) fn(s);
  }

  // ---- Sign-in ----

  const token = () => {
    const t = auth.currentToken(0);
    if (!t) throw new DriveError(401, 'The Google sign-in ran out.');
    return t.accessToken;
  };

  // The trip to Google only makes sense if Google answers.
  const googleReachable = () => googleAnswers(PROBE_MS);

  function popupDone(e) {
    if (!e) {
      forgetKey(TRIP_KEY);
      return true;
    }
    log(`Pop-up sign-in didn’t finish: ${e.code || ''} ${e.message || e}`);
    if (e.code === 'not_ready' || e.code === 'offline') set(e.code === 'offline' ? 'offline' : 'tap', e.message);
    else set('signin', `${signInMessage(e.code)}. Tap to try again`);
    return false;
  }

  // From a tap: the pop-up has to open before anything is awaited. If
  // Google's script isn't loaded yet, the trip (with Google's screens) is
  // the fallback, as the person asked to sign in.
  function signInFromTap(purpose = 'sync') {
    if (!auth.popupReady()) {
      auth.preparePopup().catch(() => {});
      if (!canLeave()) return Promise.reject(Object.assign(new Error('Google sign-in is still loading. Try again in a moment.'), { code: 'not_ready' }));
      // Going to Google needs no tap, so it can wait for a check that
      // Google answers: offline, it would strand the app on an error page.
      return googleReachable().then((ok) => {
        if (!ok) throw Object.assign(new Error('Waiting for the internet'), { code: 'offline' });
        if (!canLeave()) throw Object.assign(new Error('Google sign-in is still loading. Try again in a moment.'), { code: 'not_ready' });
        log('Signing in by going to Google (the pop-up wasn’t ready).');
        auth.signInWithRedirect({ purpose });
        return new Promise(() => {}); // the page is leaving
      });
    }
    return auth.signInWithPopup();
  }

  // No sign-in: the person taps to sync. A reason already on screen (Google
  // refused, no internet at the start) stays.
  function needTap() {
    if (status.state === 'signin' || (status.state === 'offline' && offlineAtStart)) emit();
    else set('tap', edited ? 'Changes here are waiting to sync' : '');
    offlineAtStart = false;
    auth.preparePopup().catch(() => {});
  }

  // Each new sign-in must be for the account this iPad syncs with: Google's
  // account chooser makes picking another one easy.
  async function rightAccount() {
    const t = auth.currentToken(0);
    if (!t || t.accessToken === checkedToken) return true;
    const user = await getAbout(t.accessToken);
    const account = auth.syncAccount();
    if (account && user.emailAddress !== account.email) {
      auth.dropToken();
      log(`Signed in as ${user.emailAddress}, but this iPad syncs with ${account.email}.`);
      set('signin', `You signed in as ${user.emailAddress}, but this iPad syncs with ${account.email}. Tap to sign in as ${account.email}`);
      return false;
    }
    checkedToken = t.accessToken;
    return true;
  }

  // ---- Running ----

  function progress({ step, index, count, name, sent, size }) {
    const pct = size ? ` (${Math.round((sent / size) * 100)}%)` : '';
    const verb = step === 'upload' ? 'Uploading' : 'Downloading';
    set('syncing', `${verb} ${count > 1 ? `${index + 1} of ${count}: ` : ''}${name}${pct}`);
  }

  function describe(r) {
    const parts = [];
    if (r.uploaded) parts.push(`${r.uploaded} uploaded`);
    if (r.downloaded) parts.push(`${r.downloaded} downloaded`);
    if (r.renamed) parts.push(`${r.renamed} renamed`);
    if (r.deleted) parts.push(`${r.deleted} deleted here`);
    if (r.trashed) parts.push(`${r.trashed} moved to the Drive trash`);
    if (r.failed) parts.push(`${r.failed} failed`);
    return parts.join(', ') || 'nothing to change';
  }

  function failure(e) {
    if (e.reason === 'storageQuotaExceeded') return 'Your Google Drive is full, so sync stopped. Make room in Drive, then tap Sync now';
    if (e.name === 'QuotaExceededError') return 'This iPad is out of storage for Music Stand, so sync stopped';
    return `Sync stopped: ${e.message || e}`;
  }

  // The answer about held deletions lasts until a sync carrying it finishes,
  // even if the app is closed in between. Resolves to { raw, decision }.
  function savedDecision() {
    let raw = null;
    try { raw = localStorage.getItem(DECISION_KEY); } catch { /* storage blocked */ }
    const d = raw ? JSON.parse(raw) : null;
    if (!d) return { raw: null, decision: null };
    return { raw, decision: d.keep ? { keep: new Set(d.keep) } : { delete: new Set(d.delete || []) } };
  }

  // Forgets the answer a run carried, unless a newer one came meanwhile.
  function decisionDone(raw) {
    try {
      if (raw && localStorage.getItem(DECISION_KEY) === raw) localStorage.removeItem(DECISION_KEY);
    } catch { /* storage blocked */ }
  }

  async function holdWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock && !document.hidden) wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not allowed right now */ }
  }

  // why: 'launch' | 'foreground' | 'back' | 'edit' | 'tap' | 'signed-in' | 'online'
  async function run(why) {
    if (!connected()) return;
    if (running) {
      again = true;
      return;
    }
    if (!canSync()) {
      owed = true;
      emit();
      return;
    }
    if (!auth.currentToken(MIN_TOKEN_MS)) {
      owed = true;
      needTap();
      return;
    }
    running = (async () => {
      try {
        if (!(await rightAccount())) return;
      } catch (e) {
        owed = true;
        log(`Couldn’t check the Google account: ${e.status || ''} ${e.message || e}`);
        if (e.status === 401) {
          auth.dropToken();
          needTap();
        } else {
          set(e.name === 'TypeError' ? 'offline' : 'error', e.name === 'TypeError' ? 'Waiting for the internet' : failure(e));
        }
        return;
      }
      if (!connected()) return; // disconnected while the account was checked
      owed = false;
      const editedBefore = edited;
      edited = false; // edits from here on wait for the next run
      // The run belongs to this account: a disconnect, or a switch to
      // another account, stops it.
      const email = auth.syncAccount().email;
      const sameAccount = () => { const a = auth.syncAccount(); return !!a && a.email === email; };
      const saved = savedDecision();
      set('syncing', 'Checking Google Drive…');
      log(`Sync (${why})`);
      holdWakeLock();
      try {
        const r = await syncOnce({
          remote: driveRemote(token),
          local: localStore,
          log,
          progress,
          // Pause for a score or a disconnect; steps that need the sign-in
          // also wait when it is about to run out (upload pieces don't).
          shouldStop: () => !canSync() || !sameAccount(),
          needsToken: () => !auth.currentToken(60_000),
          decision: saved.decision,
        });
        decisionDone(saved.raw);
        lastSync = Date.now();
        held = r.held;
        log(`Done: ${describe(r)}.`);
        if (held) set('decision', `${held.ids.length} ${held.ids.length === 1 ? 'score was' : 'scores were'} deleted in Google Drive`);
        else if (r.failed) set('error', `${r.failed} ${r.failed === 1 ? 'score' : 'scores'} couldn’t sync. Copy the sync report for details`);
        else set('idle');
      } catch (e) {
        edited = edited || editedBefore; // nothing was sent for sure
        if (e instanceof SyncStopped) {
          owed = true;
          if (!sameAccount()) return;
          if (!auth.currentToken(60_000)) {
            log('Paused: the Google sign-in is about to run out.');
            needTap();
          } else {
            log('Paused while a score is open.');
            set('paused', 'Paused while a score is open');
          }
        } else if (e.status === 401) {
          auth.dropToken();
          owed = true;
          log('Google sign-in ran out.');
          needTap();
        } else if (e.name === 'TypeError' || e.name === 'AbortError') {
          owed = true;
          log(`No connection to Google Drive (${e.message}).`);
          set('offline', 'Waiting for the internet');
        } else {
          log(`Sync failed: ${e.status || ''} ${e.reason || ''} ${e.message || e}`);
          set('error', e instanceof SyncRefused ? e.message : failure(e));
        }
      } finally {
        if (wakeLock) wakeLock.release().catch(() => {});
        wakeLock = null;
      }
    })();
    try {
      await running;
    } finally {
      running = null;
      if (again) {
        again = false;
        schedule('edit', 500);
      }
    }
  }

  function schedule(why, ms) {
    clearTimeout(timer);
    timer = setTimeout(() => run(why), ms);
  }

  onLibraryEdit(() => {
    if (!connected()) return;
    edited = true;
    schedule('edit', EDIT_DELAY_MS);
  });
  window.addEventListener('online', () => {
    if (!connected()) return;
    auth.preparePopup().catch(() => {});
    if (status.state === 'offline') status = { state: 'idle', message: '' };
    if (owed) run('online');
    else emit();
  });
  // A sign-in answered in Google's sheet over the app (the sheet's copy of
  // the app keeps the token but does nothing else): finish it here.
  function answeredElsewhere() {
    if (!auth.currentToken(0) || connecting) return;
    const purpose = auth.takeAnsweredSignIn();
    if (purpose === 'connect' && !connected()) finishConnect(auth.currentToken(0)).catch(connectFailed);
    if (purpose === 'sync' && connected()) {
      forgetKey(TRIP_KEY);
      log('New hour of access from Google.');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!ready || document.hidden) return;
    answeredElsewhere();
    if (!connected()) return;
    if (!auth.popupReady()) auth.preparePopup().catch(() => {});
    if (owed || Date.now() - lastSync > FOREGROUND_GAP_MS) run('foreground');
  });

  // One connect at a time: a second call shares the first.
  let connecting = null;
  function finishConnect(t) {
    if (!connecting) connecting = connectWith(t).finally(() => { connecting = null; });
    return connecting;
  }

  async function connectWith(t) {
    if (!t) throw new Error('no sign-in from Google');
    const user = await getAbout(t.accessToken);
    const { state } = await localStore.records();
    if (state.account && state.account !== user.emailAddress && !(await confirmSwitch(state.account, user.emailAddress))) {
      auth.dropToken();
      return;
    }
    // A run for the previous account finishes (it stops itself) first.
    if (running) await running.catch(() => {});
    await localStore.connect(user.emailAddress);
    auth.setAccount({ email: user.emailAddress, name: user.displayName, sync: true });
    checkedToken = t.accessToken;
    forgetKey(TRIP_KEY);
    log(`Connected to Google Drive as ${user.emailAddress}.`);
    status = { state: 'off', message: '' }; // emit() picks the right state
    run('signed-in');
  }

  function connectFailed(e) {
    log(`Connecting didn’t finish: ${e.code || e.status || ''} ${e.message || e}`);
    let why = e.code === 'not_ready' ? e.message
      : e.code && e.code !== 'offline' ? `${signInMessage(e.code)}.`
        : 'Couldn’t reach Google Drive. Check the internet connection.';
    if (!/[.!?]$/.test(why)) why += '.';
    status = { state: 'off', message: `Couldn’t connect: ${why}` };
    emit();
  }

  const api = {
    onStatus(fn) {
      listeners.add(fn);
      emit();
      return () => listeners.delete(fn);
    },

    // Called as the app starts, before the library is drawn, when this page
    // load isn't Google's answer to a sign-in. If the sign-in has run out,
    // goes to Google for a new hour (the page reloads) and resolves true.
    // onCheck() is called if it first checks that Google can be reached.
    async tripAtLaunch(onCheck = () => {}) {
      if (!connected() || auth.currentToken(MIN_TOKEN_MS)) return false;
      if (Date.now() - (readJson(TRIP_KEY, 0) || 0) < TRIP_PAUSE_MS || !canReload()) return false;
      onCheck();
      const asked = Date.now();
      if (!(await googleReachable())) {
        log('Google isn’t reachable; sync waits for the internet.');
        offlineAtStart = true;
        set('offline', 'Waiting for the internet');
        return false;
      }
      // Anything the person started meanwhile wins.
      if (!canReload() || lastTouch >= asked) return false;
      log('Getting a new hour of access from Google…');
      writeJson(TRIP_KEY, Date.now());
      auth.signInWithRedirect({ silent: true, purpose: 'sync' });
      return true;
    },

    // The app has started, after its first route. result: what
    // takeRedirectResult() returned for this page load.
    started(result) {
      ready = true;
      if (auth.takeAbandonedSignIn() === 'sync') log('The last trip to Google for a sign-in didn’t come back.');
      if (result) {
        api.answered(result);
        return;
      }
      answeredElsewhere();
      if (connected()) {
        auth.preparePopup().catch(() => {});
        run('launch');
      }
    },

    // Google's answer to a trip there (takeRedirectResult()).
    answered(result) {
      if (result.purpose === 'connect') {
        if (result.ok) finishConnect(auth.currentToken(0)).catch(connectFailed);
        else connectFailed({ code: result.error, message: result.error });
        return;
      }
      if (!connected()) return;
      auth.preparePopup().catch(() => {});
      if (result.ok) {
        forgetKey(TRIP_KEY);
        log('New hour of access from Google.');
        run('signed-in');
      } else {
        log(`Google wants a tap to sign in again (${result.error}).`);
        set('signin', `${signInMessage(result.error)}. Tap to sign in`);
      }
    },

    // The library is showing again after a score.
    libraryShown() {
      if (!ready || !connected()) return;
      if (owed || Date.now() - lastSync > BACK_GAP_MS) run('back');
      else emit();
    },

    // From a tap (Settings or the cloud button).
    syncNow() {
      if (!connected()) return;
      if (auth.currentToken(MIN_TOKEN_MS)) {
        run('tap');
        return;
      }
      signInFromTap().then(() => {
        if (popupDone(null)) {
          log('Signed in again with the pop-up.');
          if (status.state === 'signin' || status.state === 'offline') status = { state: 'idle', message: '' };
          run('tap');
        }
      }, popupDone);
    },

    // From a tap: the person's answer about held deletions, 'delete' or
    // 'keep', for the scores they were shown (ids).
    decide(answer, ids) {
      if (!held) return;
      const shown = new Set(ids);
      const chosen = held.ids.filter((id) => shown.has(id));
      if (!chosen.length) return;
      writeJson(DECISION_KEY, { [answer]: chosen, at: Date.now() });
      log(answer === 'delete' ? `You chose to delete ${chosen.length} here too.` : `You chose to keep ${chosen.length}.`);
      held = null;
      if (!running) set('idle');
      else emit();
      api.syncNow();
    },

    // From a tap in Settings: sign in, then sync for the first time.
    connect() {
      signInFromTap('connect').then(finishConnect).catch(connectFailed);
    },

    // Stop syncing on this device. The scores stay here and in Drive.
    disconnect() {
      clearTimeout(timer);
      auth.forget();
      owed = false;
      held = null;
      forgetKey(DECISION_KEY);
      log('Disconnected on this device.');
      set('off');
    },

    prepare() {
      if (!auth.popupReady()) auth.preparePopup().catch(() => {});
    },

    report() {
      return readJson(LOG_KEY, []).join('\n');
    },
  };
  return api;
}
