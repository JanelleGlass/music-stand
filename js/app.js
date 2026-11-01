import { loadSettings, getSettings, updateSettings, onSettings, onLibraryChange, getFile, touchFile, requestPersistence } from './data.js';
import { initLibrary } from './library.js';
import { Viewer } from './viewer.js';
import { WinkCamera } from './wink-camera.js';
import { initSettings } from './settings-ui.js';
import { describePdfError } from './pdfdoc.js';
import { takeRedirectResult } from './gdrive-auth.js';
import { initSync } from './sync.js';
import { initSyncUi, confirmAccountSwitch } from './sync-ui.js';
import { $, icon, toast, promptDialog, isBusy } from './ui.js';

const LAST_VIEW_KEY = 'ms:lastView';
const RESUME_WITHIN_MS = 12 * 60 * 60 * 1000;
const BAR_HIDE_MS = 3500;

let viewer;
let camera;
let library;
let settingsUi;
let sync;
let viewerActive = false;
let settingsOpen = false;
let barTimer = 0;
let wakeLock = null;

function injectIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.outerHTML = icon(el.dataset.icon);
  }
}

// ---------- Routing ----------

function go(hash) {
  if (location.hash !== hash) location.hash = hash;
  else route();
}

async function route() {
  const m = location.hash.match(/^#\/file\/(.+)$/);
  if (m) await showViewer(decodeURIComponent(m[1]));
  else showLibrary();
}

function rememberView() {
  try {
    if (viewerActive) localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ hash: location.hash, at: Date.now() }));
    else localStorage.removeItem(LAST_VIEW_KEY);
  } catch { /* storage blocked */ }
}

// iPadOS often discards a backgrounded web app; reopen the score that was showing.
function resumeLastView() {
  if (location.hash && location.hash !== '#/') return;
  try {
    const last = JSON.parse(localStorage.getItem(LAST_VIEW_KEY) || 'null');
    if (last && last.hash && Date.now() - last.at < RESUME_WITHIN_MS) history.replaceState(null, '', last.hash);
  } catch { /* ignore */ }
}

function showLibrary() {
  if (viewerActive) {
    viewer.close();
    viewerActive = false;
    camera.release('viewer');
    releaseWakeLock();
  }
  $('#viewer').hidden = true;
  $('#library').hidden = false;
  document.title = 'Music Stand';
  rememberView();
  library.refresh();
  if (sync) sync.libraryShown();
}

async function showViewer(fileId) {
  const meta = await getFile(fileId);
  if (!meta) {
    toast('That score is no longer in your library.');
    history.replaceState(null, '', '#/');
    showLibrary();
    return;
  }
  $('#library').hidden = true;
  $('#viewer').hidden = false;
  $('#v-title').textContent = meta.name;
  document.title = meta.name;
  viewerActive = true;
  rememberView();
  showBar();
  updateZoomLabel();
  try {
    await viewer.open({ key: fileId, segments: [{ fileId }] });
    updateZoomLabel();
  } catch (e) {
    console.warn(e);
    toast(`Couldn't open this score: ${describePdfError(e)}`, 5000);
  }
  touchFile(fileId);
  syncWink();
  requestWakeLock();
}

// ---------- Viewer chrome ----------

function showBar(autoHide = true) {
  const v = $('#viewer');
  v.classList.add('bar-visible');
  clearTimeout(barTimer);
  if (autoHide) barTimer = setTimeout(hideBar, BAR_HIDE_MS);
}

function hideBar() {
  clearTimeout(barTimer);
  if (settingsOpen) return;
  $('#viewer').classList.remove('bar-visible');
}

function toggleBar() {
  if ($('#viewer').classList.contains('bar-visible')) hideBar();
  else showBar();
}

function updateZoomLabel() {
  $('#v-zoom').textContent = `${Math.round(viewer.zoom * 100)}%`;
}

function turn(dir, source) {
  if (!viewerActive) return;
  const moved = viewer.turn(dir);
  if (moved) {
    hideBar();
    if (source === 'wink') flash(dir);
  } else {
    toast(dir > 0 ? 'End of the music' : 'Top of the music', 1200);
  }
}

function flash(dir) {
  const el = $(dir > 0 ? '#flash-fwd' : '#flash-back');
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  const hud = $('#wink-hud');
  hud.classList.remove('fired');
  void hud.offsetWidth;
  hud.classList.add('fired');
}

function setupViewerControls() {
  $('#v-back').addEventListener('click', () => go('#/'));
  $('#v-settings').addEventListener('click', () => settingsUi.open());
  $('#v-zoom-in').addEventListener('click', () => { viewer.zoomStep(1); showBar(); });
  $('#v-zoom-out').addEventListener('click', () => { viewer.zoomStep(-1); showBar(); });
  $('#v-wink').addEventListener('click', () => {
    const on = !getSettings().winkEnabled;
    updateSettings({ winkEnabled: on });
    toast(on ? 'Wink control on' : 'Wink control off', 1400);
    showBar();
  });
  $('#v-page').addEventListener('click', async () => {
    clearTimeout(barTimer);
    const count = viewer.pages.length;
    const v = await promptDialog({ title: `Go to page (1–${count})`, type: 'number', min: 1, max: count, value: String(viewer.currentIndex + 1), ok: 'Go' });
    const n = parseInt(v, 10);
    if (n >= 1 && n <= count) viewer.goToIndex(n - 1);
    showBar();
  });
  // Keep the bar up while it's being used.
  $('.vbar').addEventListener('pointerdown', () => showBar());

  viewer.addEventListener('page', (e) => {
    const { index, count } = e.detail;
    const label = `${index + 1} / ${count}`;
    $('#v-page').textContent = label;
    $('#v-pill').textContent = label;
  });
  viewer.addEventListener('zoom', updateZoomLabel);
  viewer.addEventListener('tap', (e) => {
    const fy = e.detail.fy;
    if (getSettings().tapToTurn && fy < 1 / 3) turn(-1, 'tap');
    else if (getSettings().tapToTurn && fy > 2 / 3) turn(1, 'tap');
    else toggleBar();
  });
  // Face tracking shares the main thread; pause it while a turn animates.
  viewer.addEventListener('animstart', () => { camera.paused = true; });
  viewer.addEventListener('animend', () => { camera.paused = false; });

  window.addEventListener('keydown', (e) => {
    if (!viewerActive || settingsOpen || document.querySelector('dialog[open]')) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key;
    let dir = 0;
    if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey) || k === 'Enter') dir = 1;
    else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) dir = -1;
    else if (k === 'Escape') { go('#/'); return; }
    if (dir) {
      e.preventDefault();
      if (!e.repeat) turn(dir, 'key');
    }
  });
}

// ---------- Wink control ----------

function setupWink() {
  camera = new WinkCamera($('#cam'));
  const apply = () => {
    const s = getSettings();
    camera.configure({ sensitivity: s.winkSensitivity, holdMs: s.winkHoldMs, fps: s.winkFps, swap: s.winkSwap });
    $('#cam').classList.toggle('preview', s.winkPreview && camera.state !== 'off');
  };
  apply();
  onSettings((s, patch) => {
    apply();
    if ('winkEnabled' in patch) syncWink();
  });

  camera.addEventListener('wink', (e) => {
    if (!viewerActive || settingsOpen) return;
    const s = getSettings();
    if (e.detail.eye === s.winkForwardEye) turn(1, 'wink');
    else if (s.winkBack) turn(-1, 'wink');
  });

  const hud = $('#wink-hud');
  const btn = $('#v-wink');
  const ring = hud.querySelector('.prog');
  const RING = 100.53;
  camera.addEventListener('status', (e) => {
    const { state, message } = e.detail;
    hud.className = `wink-hud ${state}`;
    btn.className = `icon-btn wink-btn s-${state}`;
    btn.title = message || '';
    $('#cam').classList.toggle('preview', getSettings().winkPreview && state !== 'off');
    if (state === 'error' && viewerActive) toast(message, 6000);
    if (state !== 'running') ring.style.strokeDashoffset = RING;
  });
  camera.addEventListener('frame', (e) => {
    const p = e.detail.state === 'holding' ? e.detail.progress : 0;
    ring.style.strokeDashoffset = String(RING * (1 - p));
  });
}

// Camera runs only while a score is open and wink control is on.
function syncWink() {
  const on = getSettings().winkEnabled;
  $('#v-wink').setAttribute('aria-pressed', String(on));
  if (on && viewerActive) camera.acquire('viewer');
  else camera.release('viewer');
}

// ---------- Screen wake lock ----------

async function requestWakeLock() {
  if (!viewerActive || !getSettings().keepAwake || document.hidden || wakeLock) return;
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed right now */ }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// ---------- Service worker / updates ----------

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.version) $('#app-version').textContent = `version ${e.data.version}`;
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => {
      $('#update-banner').hidden = false;
      $('#update-reload').onclick = () => {
        reloading = true;
        worker.postMessage('skipWaiting');
      };
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !viewerActive) reg.update().catch(() => {});
    });
    navigator.serviceWorker.ready.then((r) => r.active && r.active.postMessage('version'));
  }).catch((e) => console.warn('Service worker registration failed', e));
}

// ---------- Google sign-in ----------

// Google's answer landed in the sign-in sheet shown over the Home Screen app,
// not in the app itself. The app picks the sign-in up when the sheet closes.
function showSignInNote(result) {
  const note = document.createElement('div');
  note.className = 'signin-note';
  note.innerHTML = result.ok
    ? '<h2>Signed in to Google</h2><p>Tap <b>Done</b> at the top of the screen to go back to Music Stand.</p>'
    : '<h2>Google sign-in didn’t finish</h2><p>Tap <b>Done</b> at the top of the screen to go back to Music Stand, then try again.</p>';
  document.body.appendChild(note);
}

// ---------- Boot ----------

async function main() {
  injectIcons();
  // Before routing: the address may hold Google's answer to a sign-in.
  const signIn = takeRedirectResult();
  await loadSettings();

  const applyDisplay = () => document.documentElement.classList.toggle('night', getSettings().nightMode);
  applyDisplay();
  onSettings((s, patch) => {
    if ('nightMode' in patch) applyDisplay();
    if ('keepAwake' in patch) (s.keepAwake ? requestWakeLock() : releaseWakeLock());
  });

  viewer = new Viewer($('#viewer'));
  setupWink();
  setupViewerControls();
  library = initLibrary({ onOpen: (id) => go(`#/file/${encodeURIComponent(id)}`) });
  settingsUi = initSettings({
    camera,
    onOpenChange: (open) => {
      settingsOpen = open;
      if (open) sync.prepare();
      if (viewerActive) (open ? showBar(false) : showBar());
    },
  });
  const inLibrary = () => !viewerActive && !location.hash.startsWith('#/file/');
  sync = initSync({
    canSync: inLibrary,
    // Going to Google and back reloads the page: only with the library
    // showing, no dialog (or Settings) open and nothing under way.
    canReload: () => inLibrary() && !document.hidden && !document.querySelector('dialog[open]') && !isBusy(),
    canLeave: () => inLibrary() && !isBusy(),
    confirmSwitch: confirmAccountSwitch,
  });
  initSyncUi(sync);
  $('#lib-settings').addEventListener('click', () => settingsUi.open());

  // Restoring a backup can remove the score that's open.
  onLibraryChange(async () => {
    if (!viewerActive || !viewer.key || (await getFile(viewer.key))) return;
    viewer.key = null; // no reading place to save for it
    go('#/');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      viewer.flushPosition();
      rememberView();
    } else {
      requestWakeLock();
    }
  });
  window.addEventListener('pagehide', () => viewer.flushPosition());

  // The rest of starting up, once (it may wait for a trip to Google).
  let booted = false;
  async function finishBoot(result) {
    if (booted) return;
    booted = true;
    $('#boot-note').hidden = true;
    await route();
    sync.started(result);
    setupServiceWorker();
    requestPersistence();
  }

  window.addEventListener('hashchange', async () => {
    // Google's answer can also reach the running app as a jump within the
    // page, without a reload.
    const result = takeRedirectResult();
    if (!booted) {
      await finishBoot(result);
      return;
    }
    await route();
    if (result) sync.answered(result);
  });
  window.musicStand = { viewer, camera, library, sync, settings: getSettings }; // for the Web Inspector

  if (signIn && signIn.inSheet) {
    // This copy of the app is running in Google's sign-in sheet: show only
    // the note, not the score (and its camera), and don't sync from here.
    showSignInNote(signIn);
    return;
  }

  resumeLastView();
  // A new hour of Google access, if needed, before the library is drawn, so
  // the trip there and back is part of starting up.
  if (!signIn && !location.hash.startsWith('#/file/')) {
    const leaving = await sync.tripAtLaunch(() => { $('#boot-note').hidden = false; });
    if (leaving) {
      // Normally the page unloads now. If Google's page opened over the app
      // instead (or the answer comes back as a jump within the page), start
      // up anyway when the app is in view again, or after a while.
      setTimeout(() => finishBoot(null), 10_000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) finishBoot(null); });
      return;
    }
  }
  await finishBoot(signIn);
}

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<p style="padding:24px;font:16px system-ui">Music Stand failed to start: ${String(e && e.message || e)}</p>`;
});
