// Settings sheet: page turning, wink control (with live test + calibration),
// display, and backup.
import { getSettings, updateSettings, storageEstimate, requestPersistence } from './data.js';
import { exportBackup, inspectBackup, previewImport, importBackup, saveFile, backupFilename } from './backup.js';
import { thresholds } from './wink-logic.js';
import { syncAccount } from './gdrive-auth.js';
import { $, toast, actionSheet, formatBytes, whileBusy } from './ui.js';

// aroundImport(fn, { replace }): runs a backup import, kept apart from sync
// and from an open score.
export function initSettings({ camera, onOpenChange, aroundImport = (fn) => fn() }) {
  const dlg = $('#settings');
  const syncers = [];
  const sync = () => syncers.forEach((fn) => fn());

  function bindRange(id, key, fmt) {
    const el = $('#' + id);
    const out = $('#' + id + '-out');
    el.addEventListener('input', () => {
      out.textContent = fmt(+el.value);
      updateSettings({ [key]: +el.value });
    });
    syncers.push(() => {
      el.value = getSettings()[key];
      out.textContent = fmt(+el.value);
    });
  }

  function bindToggle(id, key) {
    const el = $('#' + id);
    el.addEventListener('change', () => updateSettings({ [key]: el.checked }));
    syncers.push(() => { el.checked = !!getSettings()[key]; });
  }

  bindRange('s-amount', 'scrollAmount', (v) => `${v}% of screen`);
  bindRange('s-duration', 'scrollDuration', (v) => (v ? `${v} ms` : 'Off (jump)'));
  bindToggle('s-guide', 'readingGuide');
  bindToggle('s-tap', 'tapToTurn');
  bindToggle('s-wink', 'winkEnabled');
  bindToggle('s-wink-back', 'winkBack');
  bindRange('s-sens', 'winkSensitivity', (v) => String(v));
  bindRange('s-hold', 'winkHoldMs', (v) => `${v} ms`);
  bindToggle('s-preview', 'winkPreview');
  bindToggle('s-swap', 'winkSwap');
  bindToggle('s-night', 'nightMode');
  bindToggle('s-awake', 'keepAwake');
  bindToggle('s-pencil', 'pencilDraws');

  const fps = $('#s-fps');
  fps.addEventListener('change', () => updateSettings({ winkFps: +fps.value }));
  syncers.push(() => { fps.value = String(getSettings().winkFps); });

  // One page at a time or scrolling; the scroll-only settings hide with it.
  const mode = $('#s-mode');
  mode.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) updateSettings({ turnMode: b.dataset.v });
    sync();
  });
  syncers.push(() => {
    const paged = getSettings().turnMode === 'page';
    for (const b of mode.querySelectorAll('button')) b.setAttribute('aria-checked', String((b.dataset.v === 'page') === paged));
    $('#s-mode-note').textContent = paged
      ? 'Each page fits the screen and turns like a book’s. Drag a page to the left, or swipe up, for the next one.'
      : 'The music is one long strip. Each turn moves part of the screen, and you can scroll freely.';
    for (const el of dlg.querySelectorAll('.scroll-only')) el.hidden = paged;
  });

  const seg = $('#s-fwd-eye');
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) updateSettings({ winkForwardEye: b.dataset.v });
    sync();
  });
  syncers.push(() => {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === getSettings().winkForwardEye));
  });

  // ---- Wink tester ----

  const tBody = $('#t-body');
  const tStart = $('#t-start');
  const tStatus = $('#t-status');
  const tEvent = $('#t-event');
  const meters = { left: $('#m-left'), right: $('#m-right') };
  let testing = false;
  let eventTimer = 0;
  let calib = null;

  function setThresholdLines() {
    const { close } = thresholds(getSettings().winkSensitivity);
    for (const m of Object.values(meters)) m.querySelector('.thresh').style.bottom = `${close * 100}%`;
  }
  $('#s-sens').addEventListener('input', setThresholdLines);
  syncers.push(setThresholdLines);

  function startTest() {
    testing = true;
    tBody.hidden = false;
    tStart.textContent = 'Stop test';
    showStatus(camera.state, camera.message);
    camera.acquire('settings-test');
  }

  function stopTest() {
    if (!testing) return;
    testing = false;
    calib = null;
    tBody.hidden = true;
    tStart.textContent = 'Start test';
    tEvent.textContent = '';
    camera.release('settings-test');
  }

  tStart.addEventListener('click', () => (testing ? stopTest() : startTest()));

  function showStatus(state, message) {
    tStatus.className = `status-line s-${state}`;
    tStatus.textContent = state === 'off' ? 'Camera off' : message;
  }

  function flashEvent(text, cls = '') {
    tEvent.className = `t-event ${cls}`;
    tEvent.textContent = text;
    clearTimeout(eventTimer);
    if (!cls) eventTimer = setTimeout(() => { tEvent.textContent = ''; }, 1200);
  }

  camera.addEventListener('status', (e) => { if (testing) showStatus(e.detail.state, e.detail.message); });

  camera.addEventListener('frame', (e) => {
    if (!testing) return;
    const d = e.detail;
    for (const side of ['left', 'right']) {
      const m = meters[side];
      const v = d.face ? (side === 'left' ? d.l : d.r) : 0;
      m.querySelector('.fill').style.height = `${Math.round(v * 100)}%`;
      m.classList.toggle('holding', d.state === 'holding' && d.eye === side);
      m.classList.toggle('fired', d.state === 'fired' && d.eye === side);
    }
    if (calib) stepCalibration(d);
  });

  camera.addEventListener('wink', (e) => {
    if (!testing || calib) return;
    const s = getSettings();
    const eye = e.detail.eye;
    const name = eye === 'left' ? 'Left' : 'Right';
    if (eye === s.winkForwardEye) flashEvent(`${name} wink → Forward ▼`);
    else if (s.winkBack) flashEvent(`${name} wink → Back ▲`);
    else flashEvent(`${name} wink (back is off)`);
  });

  // Calibration: ask for a right-eye wink and see which channel responds.
  $('#t-calibrate').addEventListener('click', () => {
    if (!testing) startTest();
    calib = { started: performance.now(), since: 0, side: null };
    flashEvent('Close only your RIGHT eye and hold it…', 'calib');
  });

  function stepCalibration(d) {
    const now = performance.now();
    if (now - calib.started > 12000) {
      calib = null;
      flashEvent("Didn't see a wink. Try again with your face well lit.", 'calib');
      return;
    }
    const hi = d.face ? Math.max(d.rawL, d.rawR) : 0;
    const diff = d.face ? Math.abs(d.rawL - d.rawR) : 0;
    const side = d.face && hi > 0.4 && diff > 0.22 ? (d.rawR > d.rawL ? 'right' : 'left') : null;
    if (!side || side !== calib.side) {
      calib.side = side;
      calib.since = now;
      return;
    }
    if (now - calib.since < 450) return;
    const swapped = side === 'left';
    if (swapped) updateSettings({ winkSwap: !getSettings().winkSwap });
    calib = null;
    sync();
    flashEvent(swapped ? 'Calibrated ✓ (eyes were swapped, now fixed)' : 'Calibrated ✓ (eyes were already correct)', 'calib');
    setTimeout(() => { if (!calib) flashEvent(''); }, 2500);
  }

  // ---- Backup ----

  const scores = (n) => `${n} ${n === 1 ? 'score' : 'scores'}`;
  function describeBackup({ scores: n, fresh }) {
    if (!n) return 'This backup has no scores.';
    if (fresh === n) return `${scores(n)}, ${n === 1 ? 'new' : 'all new'} to this device.`;
    if (!fresh) return `${scores(n)}, ${n === 1 ? 'already' : 'all already'} on this device.`;
    return `${scores(n)}, ${fresh} new to this device.`;
  }

  const bStatus = $('#b-status');
  const bExport = $('#b-export');
  const bSave = $('#b-save');
  const bFile = $('#b-file');
  let prepared = null;

  bExport.addEventListener('click', async () => {
    bExport.disabled = true;
    bSave.hidden = true;
    prepared = null;
    try {
      const blob = await whileBusy(() => exportBackup((i, n, name) => {
        bStatus.textContent = n ? `Preparing backup… ${i} of ${n}${name ? ` (${name})` : ''}` : 'Preparing backup…';
      }));
      prepared = { blob, name: backupFilename() };
      bStatus.textContent = `Backup ready: ${formatBytes(blob.size)}. Tap “Save backup file”, then choose Save to Files.`;
      bSave.hidden = false;
    } catch (e) {
      console.warn(e);
      bStatus.textContent = `Export failed: ${(e && e.message) || String(e)}`;
    } finally {
      bExport.disabled = false;
    }
  });

  // Separate tap so Safari allows the share sheet.
  bSave.addEventListener('click', async () => {
    if (!prepared) return;
    const how = await saveFile(prepared.blob, prepared.name);
    if (how === 'shared' || how === 'downloaded') {
      bStatus.textContent = how === 'shared' ? 'Backup handed to the share sheet.' : `Downloaded ${prepared.name}.`;
      bSave.hidden = true;
      prepared = null;
    }
  });

  $('#b-import').addEventListener('click', () => bFile.click());
  bFile.addEventListener('change', async () => {
    const file = bFile.files && bFile.files[0];
    bFile.value = '';
    if (!file) return;
    try {
      const backup = await inspectBackup(file);
      const when = backup.manifest.exportedAt ? new Date(backup.manifest.exportedAt).toLocaleString() : 'unknown date';
      const mode = await actionSheet({
        title: `Backup from ${when}`,
        message: `${describeBackup(await previewImport(backup))} ` +
          'Merge adds what’s missing and keeps this device’s settings. Replace makes this device match the backup.' +
          (syncAccount() ? ' (With Google Drive sync on, the scores in your Drive come back at the next sync.)' : ''),
        actions: [
          { label: 'Merge into my library', value: 'merge' },
          { label: 'Replace everything on this device', value: 'replace', danger: true },
        ],
      });
      if (!mode) return;
      const replace = mode === 'replace';
      const res = await whileBusy(() => aroundImport(() => importBackup(backup, { replace }, (i, total, name) => {
        bStatus.textContent = total ? `Importing ${i} of ${total}${name ? ` (${name})` : ''}…` : 'Importing…';
      }), { replace }));
      sync();
      const already = res.here ? ` ${res.here} ${res.here === 1 ? 'was' : 'were'} already on this device.` : '';
      if (replace) bStatus.textContent = `Restored ${scores(res.added)}.`;
      else bStatus.textContent = res.added ? `Added ${scores(res.added)}.${already}` : `Nothing new to add.${already}`;
      toast('Backup imported.');
      updateStorage();
    } catch (e) {
      console.warn(e);
      bStatus.textContent = `Import failed: ${(e && e.message) || String(e)}`;
    }
  });

  async function updateStorage() {
    const el = $('#storage-info');
    const est = await storageEstimate();
    const persisted = await requestPersistence();
    const parts = [];
    if (est && est.usage != null) parts.push(`Using ${formatBytes(est.usage)}${est.quota ? ` of ${formatBytes(est.quota)} available` : ''}.`);
    parts.push(persisted ? 'Storage is marked persistent.' : 'Tip: add the app to your Home Screen so iPadOS keeps its data.');
    el.textContent = parts.join(' ');
  }

  // ---- Open / close ----

  function open() {
    sync();
    updateStorage();
    if (!dlg.open) dlg.showModal();
    onOpenChange(true);
  }

  function close() {
    if (dlg.open) dlg.close();
  }

  dlg.addEventListener('close', () => {
    stopTest();
    onOpenChange(false);
  });
  $('#settings-close').addEventListener('click', close);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });

  return { open, close, get isOpen() { return dlg.open; } };
}
