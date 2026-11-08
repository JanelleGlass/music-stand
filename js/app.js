import { loadSettings, getSettings, updateSettings, onSettings, onLibraryChange, getFile, touchFile, requestPersistence, markDamaged } from './data.js';
import { initLibrary } from './library.js';
import { Viewer } from './viewer.js';
import { Scrubber } from './scrubber.js';
import { AdjustUi } from './adjust-ui.js';
import { WinkCamera } from './wink-camera.js';
import { initSettings } from './settings-ui.js';
import { initNotesUi } from './notes-ui.js';
import { initIndexUi } from './index-ui.js';
import { getFolders, scoresIn, setMember, FAVORITES } from './lists.js';
import { describePdfError } from './pdfdoc.js';
import { takeRedirectResult, syncAccount } from './gdrive-auth.js';
import { initSync } from './sync.js';
import { initSyncUi, confirmAccountSwitch } from './sync-ui.js';
import { $, icon, toast, promptDialog, isBusy } from './ui.js';

const LAST_VIEW_KEY = 'ms:lastView';
// The score being opened, until its first page is drawn. Still there at the
// next start-up means opening it closed the app (iPadOS ran out of memory, or
// Safari couldn't read its PDF).
const OPENING_KEY = 'ms:opening';
const RESUME_WITHIN_MS = 12 * 60 * 60 * 1000;
const BAR_HIDE_MS = 3500;

let viewer;
let camera;
let library;
let settingsUi;
let sync;
let notesUi;
let indexUi;
let scrubber = null;
let adjustUi = null;
let viewerActive = false;
let settingsOpen = false;
let importing = false; // a backup is being imported
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

function watchOpening(fileId) {
  try {
    if (fileId) localStorage.setItem(OPENING_KEY, fileId);
    else localStorage.removeItem(OPENING_KEY);
  } catch { /* storage blocked */ }
}

// Opening a score closed the app last time: start in the library instead of
// opening it again (and again), and have Google Drive sync fetch a fresh copy
// of its PDF. Resolves to the score's id, or null.
async function recoverFromCrash() {
  let id = null;
  try {
    id = localStorage.getItem(OPENING_KEY);
    if (!id) return null;
    localStorage.removeItem(OPENING_KEY);
    localStorage.removeItem(LAST_VIEW_KEY);
  } catch {
    return null;
  }
  if (location.hash.startsWith('#/file/')) history.replaceState(null, '', '#/');
  await markDamaged(id).catch(() => {});
  return id;
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
  watchOpening(null);
  if (viewerActive) {
    notesUi.close();
    indexUi.reset();
    viewer.ink.setHidden(false);
    viewer.close();
    viewerActive = false;
    camera.release('viewer');
    releaseWakeLock();
  }
  $('#viewer').hidden = true;
  $('#library').hidden = false;
  document.title = 'Music Stand';
  rememberView();
  library.shown();
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
  watchOpening(fileId);
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
  updateStar();
}

// The star in the top bar shows whether the open score is a favourite.
async function updateStar() {
  if (!viewerActive || !viewer.key) return;
  const fav = scoresIn((await getFolders()).find((f) => f.id === FAVORITES)).has(viewer.key);
  const b = $('#v-star');
  b.setAttribute('aria-pressed', String(fav));
  b.setAttribute('aria-label', fav ? 'Remove from Favorites' : 'Add to Favorites');
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
  if (settingsOpen || notesUi.isOpen || indexUi.isOpen) return;
  $('#viewer').classList.remove('bar-visible');
}

function toggleBar() {
  if ($('#viewer').classList.contains('bar-visible')) hideBar();
  else showBar();
}

function updateZoomLabel() {
  $('#v-zoom').textContent = `${Math.round(viewer.zoom * 100)}%`;
}

// One page at a time or scrolling: the viewer, and the top-bar button that
// shows which (its icon) and switches.
function applyTurnMode() {
  const paged = getSettings().turnMode === 'page';
  viewer.setPaged(paged);
  const b = $('#v-mode');
  b.innerHTML = icon(paged ? 'one-page' : 'scroll');
  b.setAttribute('aria-pressed', String(paged));
  b.title = paged ? 'One page at a time' : 'Scrolling';
  if (scrubber) scrubber.update();
}

function turn(dir, source) {
  if (!viewerActive) return;
  // Not while the Pencil is writing (the mark would streak across the page),
  // nor while pages are being adjusted.
  if (viewer.ink.busy || (adjustUi && adjustUi.isOpen)) return;
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
  $('#v-star').addEventListener('click', async () => {
    if (!viewer.key) return;
    const on = $('#v-star').getAttribute('aria-pressed') !== 'true';
    await setMember(FAVORITES, viewer.key, on);
    toast(on ? 'Added to Favorites.' : 'Removed from Favorites.', 1400);
    showBar();
  });
  $('#v-mode').addEventListener('click', () => {
    const paged = getSettings().turnMode !== 'page';
    updateSettings({ turnMode: paged ? 'page' : 'scroll' });
    toast(paged ? 'One page at a time' : 'Scrolling', 1400);
    showBar();
  });
  adjustUi = new AdjustUi(viewer, { onOpenChange: (open) => (open ? showBar(false) : showBar()) });
  $('#v-adjust').addEventListener('click', () => adjustUi.open());
  $('#v-index').addEventListener('click', () => indexUi.open());
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
  // The scroll bar keeps the top bar up while it's held.
  scrubber = new Scrubber($('#v-scrub'), viewer, { onStart: () => showBar(false), onEnd: () => showBar() });
  viewer.addEventListener('zoom', updateZoomLabel);
  // The first page was drawn, or drawing failed without closing the app.
  viewer.addEventListener('drawn', () => watchOpening(null));
  viewer.addEventListener('error', () => watchOpening(null));
  viewer.addEventListener('damaged', () => {
    toast(syncAccount()
      ? 'This score’s PDF on this device is damaged. Close the score and Google Drive sync will download it again.'
      : 'This score’s PDF on this device is damaged. Delete it and add the PDF again.', 8000);
  });
  viewer.addEventListener('tap', (e) => {
    // With the markings tools open, fingers only scroll.
    if (notesUi.isOpen) return;
    // A tap area on a printed index goes where it says.
    if (indexUi.tapAt(e.detail.x, e.detail.y)) return;
    const fy = e.detail.fy;
    if (getSettings().tapToTurn && fy < 1 / 3) turn(-1, 'tap');
    else if (getSettings().tapToTurn && fy > 2 / 3) turn(1, 'tap');
    else toggleBar();
  });
  // One page at a time: sideways swipes, and the mouse wheel or trackpad.
  viewer.addEventListener('swipe', (e) => turn(e.detail.dir, 'swipe'));
  // Face tracking shares the main thread; pause it while a turn animates and
  // while the Pencil writes.
  let settle = 0;
  viewer.addEventListener('animstart', () => { camera.paused = true; });
  viewer.addEventListener('animend', () => { camera.paused = viewer.ink.busy; });
  viewer.ink.addEventListener('inkstart', () => {
    clearTimeout(settle);
    camera.paused = true;
  });
  viewer.ink.addEventListener('inkend', () => {
    clearTimeout(settle);
    settle = setTimeout(() => { camera.paused = viewer.animating; }, 320);
  });
  viewer.ink.addEventListener('hint', (e) => toast(e.detail, 3000));

  window.addEventListener('keydown', (e) => {
    if (!viewerActive || settingsOpen || document.querySelector('dialog[open]')) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key;
    if (indexUi.linking) {
      if (k === 'Escape') indexUi.stopLinking();
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') viewer.goToIndex(viewer.pageShowing() - 1);
      else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') viewer.goToIndex(viewer.pageShowing() + 1);
      return;
    }
    if (adjustUi.isOpen) {
      if (k === 'Escape') adjustUi.close();
      else if (k === 'ArrowLeft' || k === 'ArrowRight') adjustUi.step(k === 'ArrowLeft' ? -1 : 1);
      return;
    }
    let dir = 0;
    if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey) || k === 'Enter') dir = 1;
    else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) dir = -1;
    else if (k === 'Escape') {
      if (notesUi.isOpen) notesUi.close();
      else go('#/');
      return;
    } else if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) viewer.ink.redo();
      else viewer.ink.undo();
      return;
    }
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
    if (state !== 'running') {
      ring.style.strokeDashoffset = RING;
      drawEyes(null);
    }
  });
  camera.addEventListener('frame', (e) => {
    const p = e.detail.state === 'holding' ? e.detail.progress : 0;
    ring.style.strokeDashoffset = String(RING * (1 - p));
    drawEyes(e.detail);
  });
}

// ---------- Eye outlines on the camera preview ----------

// Face-mesh points: a closed loop around each eyelid, the iris centre and one
// iris edge point, and the lid/corner points used to judge how open it is.
const EYES = [
  { lid: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], iris: 468, irisEdge: 469, top: 159, bottom: 145, inner: 133, outer: 33 },
  { lid: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466], iris: 473, irisEdge: 474, top: 386, bottom: 374, inner: 362, outer: 263 },
];

function drawEyes(d) {
  const video = $('#cam');
  const canvas = $('#cam-overlay');
  if (!video.classList.contains('preview')) return;
  const ctx = canvas.getContext('2d');
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const pts = d && d.face && d.landmarks;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!pts || !vw || !vh) return;

  // The video is drawn with object-fit: cover, so map the same way.
  const scale = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * scale) / 2;
  const oy = (ch - vh * scale) / 2;
  const at = (i) => ({ x: pts[i].x * vw * scale + ox, y: pts[i].y * vh * scale + oy });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // While a wink is being held (or has just fired), highlight the more-closed eye.
  const openness = EYES.map((e) => dist(at(e.top), at(e.bottom)) / (dist(at(e.inner), at(e.outer)) || 1));
  const winking = d.state === 'holding' || d.state === 'fired'
    ? (openness[0] < openness[1] ? 0 : 1) : -1;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e6b54a';

  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  EYES.forEach((e, n) => {
    const color = n === winking ? (d.state === 'fired' ? accent : '#e6b54a') : '#3fcf7a';
    ctx.strokeStyle = color;
    ctx.beginPath();
    e.lid.forEach((i, k) => {
      const p = at(i);
      if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.stroke();
    if (pts.length > e.irisEdge) {
      const c = at(e.iris);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(1, dist(c, at(e.irisEdge))), 0, Math.PI * 2);
      ctx.stroke();
    }
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

// ---------- Backup import ----------

// An import rewrites markings and folders: no sync may write them meanwhile,
// and an open score (Settings opens over it) is saved and closed first, so
// its markings in memory can't be saved over the imported ones.
async function aroundImport(fn, { replace = false } = {}) {
  importing = true;
  try {
    if (viewerActive) {
      go('#/');
      if (viewerActive) showLibrary();
    }
    // The closing score's last save; with Replace, markings that couldn't be
    // saved are dropped, so a later retry can't write them over the backup's.
    await viewer.ink.flush();
    if (replace) viewer.ink.store.discardPending();
    await sync.settle();
    return await fn();
  } finally {
    importing = false;
  }
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
    if ('turnMode' in patch) applyTurnMode();
  });

  viewer = new Viewer($('#viewer'));
  applyTurnMode();
  notesUi = initNotesUi({ ink: viewer.ink, onOpenChange: (open) => (open ? showBar(false) : showBar()) });
  indexUi = initIndexUi({ viewer, onOpenChange: (open) => (open ? showBar(false) : hideBar()) });
  setupWink();
  setupViewerControls();
  library = initLibrary({ onOpen: (id) => go(`#/file/${encodeURIComponent(id)}`) });
  settingsUi = initSettings({
    camera,
    aroundImport,
    onOpenChange: (open) => {
      settingsOpen = open;
      if (open) sync.prepare();
      if (viewerActive) (open ? showBar(false) : showBar());
    },
  });
  const inLibrary = () => !viewerActive && !location.hash.startsWith('#/file/');
  sync = initSync({
    canSync: () => inLibrary() && !importing,
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
    updateStar();
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
    if (crashed) {
      toast(syncAccount()
        ? 'A score closed the app while it opened, so Music Stand started in the library. Google Drive sync will download a fresh copy of it.'
        : 'A score closed the app while it opened, so Music Stand started in the library. If it happens again, delete the score and add the PDF again.', 9000);
    }
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

  const crashed = await recoverFromCrash();
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
