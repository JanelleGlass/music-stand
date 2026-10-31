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

function openModal(build) {
  const dlg = $('#modal');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(v);
    };
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
export function actionSheet({ title, actions }) {
  return openModal((dlg, finish) => {
    dlg.innerHTML = `
      <div class="modal-body">${title ? `<h2>${esc(title)}</h2>` : ''}</div>
      <div class="sheet-actions">
        ${actions.map((a, i) => `<button class="btn ${a.danger ? 'danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}
        <button class="btn" data-i="-1">Cancel</button>
      </div>`;
    dlg.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => finish(b.dataset.i === '-1' ? null : actions[+b.dataset.i].value);
    });
  });
}
