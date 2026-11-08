// Small UI helpers: icons, toasts, and modal dialogs built on <dialog>.

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  wink: '<path d="M3 13c2.5 3 5.5 4.5 9 4.5s6.5-1.5 9-4.5"/><path d="M6 16.5l-1.5 2M12 17.5V20M18 16.5l1.5 2"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .4-8.98A6.5 6.5 0 0 0 5.4 11.6 3.8 3.8 0 0 0 6.5 19z"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  pen: '<path d="M4 20l1.2-4.6L16.4 4.2a1.9 1.9 0 0 1 2.7 0l.7.7a1.9 1.9 0 0 1 0 2.7L8.6 18.8z"/><path d="M14.5 6l3.5 3.5"/>',
  marker: '<path d="M9 15l-3 3v2h4l3-3"/><path d="M9 15l7.5-10.5a1.8 1.8 0 0 1 2.6-.3l.7.7a1.8 1.8 0 0 1-.3 2.6L13 17z"/>',
  eraser: '<path d="M8.5 20H20"/><path d="M5.6 15.2l8.9-8.9a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8L12 19.2a2 2 0 0 1-1.4.6H8.4a2 2 0 0 1-1.4-.6l-1.4-1.4a2 2 0 0 1 0-2.6z"/><path d="M9.5 11.3l5.2 5.2"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5v-7a1.5 1.5 0 0 1 3 0V12"/><path d="M14 11.5V6a1.5 1.5 0 0 1 3 0v7.5"/><path d="M17 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L4.6 15.6a1.6 1.6 0 0 1 2.4-2.1L8 14.5"/>',
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4"/><path d="M6.6 6.6C3.6 8.5 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7"/><path d="M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v6.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'one-page': '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8.5 7.5h7M8.5 11.5h7M8.5 15.5h4.5"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  crop: '<path d="M6 2.5V18h15.5"/><path d="M2.5 6H18v15.5"/>',
  'turn-left': '<path d="M4 4v5h5"/><path d="M4.6 14a8 8 0 1 0 1.9-8.3L4 9"/>',
  'turn-right': '<path d="M20 4v5h-5"/><path d="M19.4 14a8 8 0 1 1-1.9-8.3L20 9"/>',
  text: '<path d="M5 7V4.5h14V7"/><path d="M12 4.5V19.5"/><path d="M9 19.5h6"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
  scroll: '<rect x="3.5" y="3" width="11" height="18" rx="1.8"/><path d="M19.5 5.5v13M17.3 7.7l2.2-2.2 2.2 2.2M17.3 16.3l2.2 2.2 2.2-2.2"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---- Work under way ----

// Counts things the person started that a page reload would cut short
// (adding PDFs, a backup), so sign-in doesn't reload the page meanwhile.
let busyCount = 0;
export async function whileBusy(fn) {
  busyCount++;
  try {
    return await fn();
  } finally {
    busyCount--;
  }
}
export function isBusy() {
  return busyCount > 0;
}

// ---- Toast ----

let toastTimer = 0;
export function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
export function hideToast() {
  $('#toast').classList.remove('show');
}

// ---- Modal dialogs ----

let closeActive = null;

// build(dlg, finish) fills the dialog; finish(value) closes it and resolves
// with value (null when cancelled).
export function openModal(build) {
  const dlg = $('#modal');
  // One dialog at a time: one still open counts as cancelled.
  if (closeActive) closeActive(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (closeActive === finish) closeActive = null;
      dlg.close();
      resolve(v);
    };
    closeActive = finish;
    dlg.innerHTML = '';
    build(dlg, finish);
    // A close event from the previous modal can arrive after this one opened;
    // only treat it as a cancel if the dialog is actually closed.
    dlg.onclose = () => { if (!dlg.open) finish(null); };
    dlg.onclick = (e) => { if (e.target === dlg) finish(null); };
    dlg.showModal();
    const focusEl = dlg.querySelector('[autofocus]');
    if (focusEl) setTimeout(() => focusEl.focus(), 50);
  });
}

export function confirmDialog({ title, message = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  return openModal((dlg, finish) => {
    dlg.innerHTML = `
      <div class="modal-body">
        <h2>${esc(title)}</h2>
        ${message ? `<p>${esc(message)}</p>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn" data-v="0">${esc(cancel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-v="1">${esc(ok)}</button>
      </div>`;
    dlg.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => finish(b.dataset.v === '1')));
  }).then((v) => v === true);
}

export function promptDialog({ title, value = '', placeholder = '', ok = 'OK', type = 'text', min, max }) {
  return openModal((dlg, finish) => {
    dlg.innerHTML = `
      <form class="modal-body" method="dialog">
        <h2>${esc(title)}</h2>
        <input class="field" type="${type}" ${type === 'number' ? 'inputmode="numeric"' : ''}
          ${min != null ? `min="${min}"` : ''} ${max != null ? `max="${max}"` : ''}
          placeholder="${esc(placeholder)}" value="${esc(value)}" autofocus>
      </form>
      <div class="modal-actions">
        <button class="btn" data-v="0">Cancel</button>
        <button class="btn primary" data-v="1">${esc(ok)}</button>
      </div>`;
    const input = dlg.querySelector('input');
    const submit = () => finish(input.value);
    dlg.querySelector('form').onsubmit = (e) => { e.preventDefault(); submit(); };
    dlg.querySelector('[data-v="0"]').onclick = () => finish(null);
    dlg.querySelector('[data-v="1"]').onclick = submit;
    setTimeout(() => input.select(), 60);
  });
}

// actions: [{ label, value, danger }]
export function actionSheet({ title, message = '', actions }) {
  return openModal((dlg, finish) => {
    dlg.innerHTML = `
      <div class="modal-body">${title ? `<h2>${esc(title)}</h2>` : ''}${message ? `<p>${esc(message)}</p>` : ''}</div>
      <div class="sheet-actions">
        ${actions.map((a, i) => `<button class="btn ${a.danger ? 'danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}
        <button class="btn" data-i="-1">Cancel</button>
      </div>`;
    dlg.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => finish(b.dataset.i === '-1' ? null : actions[+b.dataset.i].value);
    });
  });
}

// ---- Copying ----

// Copies text to the clipboard (call it straight from a tap), saying so.
// Where the browser won't, the text is shown selected, to copy by hand.
export function copyText(text, what = 'Link') {
  const done = () => toast(`${what} copied.`, 1600);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => showCopyBox(text, what));
      return;
    }
  } catch { /* not allowed: the old way, or by hand */ }
  if (legacyCopy(text)) done();
  else showCopyBox(text, what);
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0;font-size:16px';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not supported */ }
  ta.remove();
  return ok;
}

function showCopyBox(text, what) {
  return openModal((dlg, finish) => {
    dlg.innerHTML = `
      <div class="modal-body">
        <h2>${esc(what)}</h2>
        <p>Copy it from here:</p>
        <input class="field copy-field" readonly value="${esc(text)}">
      </div>
      <div class="modal-actions">
        <button class="btn" data-v="0">Done</button>
        <button class="btn primary" data-v="1">Copy</button>
      </div>`;
    const input = dlg.querySelector('input');
    const select = () => { input.focus(); input.select(); input.setSelectionRange(0, text.length); };
    dlg.querySelector('[data-v="0"]').onclick = () => finish(null);
    dlg.querySelector('[data-v="1"]').onclick = () => {
      select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* not supported */ }
      if (ok) {
        finish(null);
        toast(`${what} copied.`, 1600);
      }
    };
    setTimeout(select, 50);
  });
}
