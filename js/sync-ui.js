// Google Drive sync on screen: the Settings section, the cloud button in the
// library's top bar, and the strip that asks about deletions.
import { $, toast, confirmDialog, actionSheet } from './ui.js';

function ago(ms) {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `today at ${time}` : `${d.toLocaleDateString()} at ${time}`;
}

// A sentence, with one full stop.
const sentence = (t) => (/[.!?…]$/.test(t) ? t : `${t}.`);

// What the status line says, and its colour.
function describe(s) {
  const who = s.account ? s.account.email : '';
  const last = s.lastSync ? ` Last synced ${ago(s.lastSync)}.` : '';
  switch (s.state) {
    case 'off': return { cls: s.message ? 's-error' : '', text: s.message || 'Not connected.' };
    case 'syncing': return { cls: 's-loading', text: s.message || 'Syncing…' };
    case 'paused': return { cls: '', text: `${sentence(s.message)}${last}` };
    case 'tap': return { cls: '', text: `${s.message ? `${sentence(s.message)} ` : ''}Sync needs a tap to sign in to Google again.${last}` };
    case 'signin': return { cls: 's-loading', text: sentence(s.message) };
    case 'decision': return { cls: 's-loading', text: `${sentence(s.message)} Tap Review to decide what happens on this iPad.` };
    case 'offline': return { cls: '', text: `${sentence(s.message)}${last}` };
    case 'error': return { cls: 's-error', text: sentence(s.message) };
    default: return { cls: 's-running', text: s.lastSync ? `Synced with ${who}, ${ago(s.lastSync)}.` : `Connected as ${who}.` };
  }
}

export function initSyncUi(sync) {
  const status = $('#g-status');
  const connectBtn = $('#g-connect');
  const syncBtn = $('#g-sync');
  const reviewBtn = $('#g-review');
  const disconnectBtn = $('#g-disconnect');
  const cloud = $('#lib-sync');
  const banner = $('#sync-banner');
  let current = { state: 'off' };

  function render() {
    const s = current;
    const on = s.state !== 'off';
    const { cls, text } = describe(s);
    status.className = `status-line ${cls}`;
    status.textContent = text;
    connectBtn.hidden = on;
    syncBtn.hidden = !on;
    disconnectBtn.hidden = !on;
    reviewBtn.hidden = s.state !== 'decision';
    syncBtn.disabled = s.state === 'syncing';
    syncBtn.textContent = s.state === 'signin' || s.state === 'tap' ? 'Sign in and sync' : 'Sync now';

    cloud.hidden = !on;
    cloud.className = `icon-btn sync-btn s-${s.state}${s.pending ? ' pending' : ''}`;
    cloud.setAttribute('aria-label', `Google Drive sync: ${text}`);
    cloud.title = text;

    banner.hidden = s.state !== 'decision';
    if (s.held) $('#sync-banner-text').textContent = sentence(s.message);
  }

  sync.onStatus((s) => {
    current = s;
    render();
  });
  // "2 min ago" moves on.
  setInterval(() => { if (current.state !== 'syncing') render(); }, 60_000);

  // These can start sign-in pop-ups, so they call straight into sync from the tap.
  connectBtn.addEventListener('click', () => sync.connect());
  syncBtn.addEventListener('click', () => sync.syncNow());
  cloud.addEventListener('click', () => {
    if (current.state === 'syncing') {
      toast(current.message || 'Syncing…');
    } else if (current.state === 'decision') {
      review();
    } else {
      sync.syncNow();
      if (current.state === 'idle' || current.state === 'paused' || current.state === 'offline') toast('Syncing with Google Drive…', 1500);
    }
  });

  // Deletions sync held back: the person decides, from a tap.
  async function review() {
    const held = current.held;
    if (!held) return;
    const n = held.ids.length;
    const list = held.names.slice(0, 8).join(', ') + (n > 8 ? `, and ${n - 8} more` : '');
    const inTrash = held.folders.length > 0;
    const choice = await actionSheet({
      title: inTrash ? 'The Music Stand folder is in your Google Drive trash' : `${n} scores were deleted in Google Drive`,
      message: (inTrash
        ? `So these ${n} scores look deleted: ${list}. `
        : `They were deleted on another device or in Drive, or are missing from it: ${list}. `) +
        'Sync has left them on this iPad until you decide.',
      actions: [
        { label: inTrash ? 'Take the folder out of the trash' : 'Keep them', value: 'keep' },
        { label: 'Delete them from this iPad too', value: 'delete', danger: true },
      ],
    });
    if (choice) sync.decide(choice, held.ids);
  }
  reviewBtn.addEventListener('click', review);
  $('#sync-review').addEventListener('click', review);

  disconnectBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Stop syncing on this iPad?',
      message: 'Your scores stay on this iPad and in Google Drive, and your other devices keep syncing. ' +
        'Changes here aren’t synced until you connect again, and scores you delete meanwhile come back from Google Drive then.',
      ok: 'Stop syncing',
    });
    if (ok) sync.disconnect();
  });

  $('#g-copy').addEventListener('click', async () => {
    const text = `Music Stand sync report\n${sync.report()}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Sync report copied. Paste it into your message.');
    } catch {
      toast('Couldn’t copy the sync report.');
    }
  });
}

// Connecting with another Google account than this iPad synced with before.
export function confirmAccountSwitch(old, next) {
  return confirmDialog({
    title: `Sync with ${next}?`,
    message: `This iPad used to sync with ${old}. Your scores here will be added to ${next}’s Google Drive, and its scores will come to this iPad.`,
    ok: `Use ${next}`,
  });
}

