// The Index panel of an open score: its hymns and sections, searched by
// number or by words of their titles; adding them where the music is, many
// at once, or titles from a pasted list. And drawing tap areas on a printed
// index page, each going to a hymn or a page. The marks are kept by
// js/marks.js; js/index-logic.js has the rules.
import { $, esc, icon, toast, openModal, confirmDialog, actionSheet } from './ui.js';
import { sortEntries, searchEntries, findHymn, nextNumber, entryAt, parseTitleList, hymnRun, boxBetween, compareNumbers } from './index-logic.js';

const MIN_BOX_PX = 14; // a drag smaller than this either way isn't a tap area
const RETURN_MS = 12000; // how long "Back" shows after following a tap area

export function initIndexUi({ viewer, onOpenChange = () => {} }) {
  const marks = viewer.marks;
  const sheet = $('#index');
  const search = $('#ix-search');
  const list = $('#ix-list');
  const bar = $('#links-bar');
  let linking = null; // drawing tap areas: { draw, onDown, ... }
  let returnTo = null;
  let returnTimer = 0;

  const entries = () => marks.entries();
  const pageCount = () => viewer.pages.length;
  const indexOfNum = (num) => viewer.pages.findIndex((p) => p.num === num);

  // ---- The panel ----

  function open() {
    if (!viewer.isOpen) return;
    search.value = '';
    render();
    sheet.showModal();
    onOpenChange(true);
  }

  function close() {
    if (sheet.open) sheet.close();
  }
  sheet.addEventListener('close', () => onOpenChange(false));
  $('#ix-done').addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });

  function render() {
    const all = entries();
    const q = search.value.trim();
    const shown = q ? searchEntries(all, q) : sortEntries(all);
    const hymns = all.filter((e) => e.kind === 'hymn').length;
    const sections = all.length - hymns;
    $('#ix-count').textContent = all.length ? [hymns && `${hymns} hymn${hymns === 1 ? '' : 's'}`, sections && `${sections} section${sections === 1 ? '' : 's'}`].filter(Boolean).join(', ') : '';
    if (!all.length) {
      list.innerHTML = `<div class="ix-empty">
        <p><b>Make an index for this score.</b></p>
        <p>Go to where a hymn starts and tap <b>Hymn here</b>, or add a whole run of hymns at once with <b>Add many</b> (for example hymns 1 to 600, one a page, from page 12). Then paste their titles with <b>Paste titles</b> to search them by words.</p>
        <p>Sections (Advent, Communion…) label the scroll bar, so you can jump straight to them.</p>
      </div>`;
      return;
    }
    if (!shown.length) {
      list.innerHTML = `<div class="ix-empty"><p>Nothing in the index matches “${esc(q)}”.</p></div>`;
      return;
    }
    list.innerHTML = shown.map((e) => {
      const main = e.kind === 'section'
        ? `<span class="ix-title">${esc(e.title)}</span>`
        : `<span class="ix-n">${esc(e.n)}</span><span class="ix-title">${e.title ? esc(e.title) : '<i>No title</i>'}</span>`;
      return `<div class="ix-row ${e.kind}" data-id="${esc(e.id)}">
        <button type="button" class="ix-go">${main}<span class="ix-page">p. ${e.num}</span></button>
        <button type="button" class="icon-btn ix-edit" aria-label="Change">${icon('pen')}</button>
      </div>`;
    }).join('');
  }

  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = searchEntries(entries(), search.value)[0];
    if (first) goToEntry(first);
  });

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.ix-row');
    if (!row) return;
    const entry = entries().find((x) => x.id === row.dataset.id);
    if (!entry) return;
    if (e.target.closest('.ix-edit')) editEntry(entry);
    else goToEntry(entry);
  });

  function goToEntry(entry) {
    close();
    search.blur();
    viewer.goTo(entry.index, entry.y);
  }

  marks.addEventListener('change', () => { if (sheet.open) render(); });
  marks.addEventListener('hint', (e) => toast(e.detail, 4000));

  // ---- Adding and changing ----

  // Where a new entry goes: the top of the screen.
  function here() {
    const [index, y] = viewer.topPlace();
    return { index, y: viewer.paged || y < 0.03 ? 0 : y, page: viewer.pages[index] };
  }

  $('#ix-add-hymn').addEventListener('click', async () => {
    const at = here();
    if (!at.page) return;
    const v = await formDialog({
      title: 'Hymn here',
      fields: [
        { name: 'n', label: 'Number', value: nextNumber(entries(), at.index, at.y), inputmode: 'numeric', autofocus: true },
        { name: 'title', label: 'Title', placeholder: 'Optional' },
        { name: 'page', label: 'Page', value: String(at.page.num), type: 'number', min: 1, max: pageCount() },
      ],
      ok: 'Add',
    });
    if (!v || !v.n.trim()) return;
    const num = clampPage(v.page, at.page.num);
    const y = num === at.page.num ? at.y : 0;
    const same = findHymn(entries(), v.n);
    if (same) {
      const choice = await actionSheet({
        title: `Hymn ${same.n} is already in the index`,
        message: `It’s on page ${same.num}.`,
        actions: [{ label: `Move hymn ${same.n} here`, value: 'move' }, { label: 'Add it again', value: 'add' }],
      });
      if (!choice) return;
      if (choice === 'move') {
        marks.update(same.id, { n: v.n.trim(), title: v.title.trim() || same.title, y }, num);
        toast(`Hymn ${v.n.trim()} moved to page ${num}.`, 1600);
        return;
      }
    }
    marks.add([{ fileId: at.page.fileId, num, mark: { kind: 'hymn', n: v.n.trim(), title: v.title.trim(), y } }]);
    toast(`Hymn ${v.n.trim()} added.`, 1400);
  });

  $('#ix-add-section').addEventListener('click', async () => {
    const at = here();
    if (!at.page) return;
    const v = await formDialog({
      title: 'Section here',
      message: 'A part of the book, such as Advent or Communion. Sections label the scroll bar.',
      fields: [
        { name: 'title', label: 'Name', autofocus: true },
        { name: 'page', label: 'Page', value: String(at.page.num), type: 'number', min: 1, max: pageCount() },
      ],
      ok: 'Add',
    });
    if (!v || !v.title.trim()) return;
    const num = clampPage(v.page, at.page.num);
    marks.add([{ fileId: at.page.fileId, num, mark: { kind: 'section', title: v.title.trim(), y: num === at.page.num ? at.y : 0 } }]);
    toast(`Section “${v.title.trim()}” added.`, 1400);
  });

  async function editEntry(entry) {
    const isHymn = entry.kind === 'hymn';
    const v = await formDialog({
      title: isHymn ? `Hymn ${entry.n}` : entry.title,
      fields: isHymn
        ? [
          { name: 'n', label: 'Number', value: entry.n, inputmode: 'numeric' },
          { name: 'title', label: 'Title', value: entry.title, placeholder: 'Optional' },
          { name: 'page', label: 'Page', value: String(entry.num), type: 'number', min: 1, max: pageCount() },
        ]
        : [
          { name: 'title', label: 'Name', value: entry.title },
          { name: 'page', label: 'Page', value: String(entry.num), type: 'number', min: 1, max: pageCount() },
        ],
      ok: 'Save',
      extra: { label: 'Delete', value: 'delete', danger: true },
    });
    if (!v) return;
    if (v === 'delete') {
      marks.remove(entry.id);
      toast(isHymn ? `Hymn ${entry.n} taken out of the index.` : `Section “${entry.title}” taken out of the index.`, 1600);
      return;
    }
    const num = clampPage(v.page, entry.num);
    const patch = isHymn ? { n: v.n.trim() || entry.n, title: v.title.trim() } : { title: v.title.trim() || entry.title };
    if (num !== entry.num) patch.y = 0;
    marks.update(entry.id, patch, num);
  }

  function clampPage(value, fallback) {
    const n = Math.round(Number(value));
    return n >= 1 && n <= pageCount() ? viewer.pages[Math.max(0, indexOfNum(n))].num : fallback;
  }

  // Many hymns at once: one every few pages.
  $('#ix-add-many').addEventListener('click', async () => {
    const at = here();
    const v = await formDialog({
      title: 'Add many hymns',
      message: 'For a book with a hymn on each page (or every 2 pages). Hymns already in the index stay where they are. You can move any that land on the wrong page afterwards.',
      fields: [
        { name: 'from', label: 'From hymn', value: nextNumber(entries(), at.index, at.y) || '1', type: 'number', min: 0 },
        { name: 'to', label: 'To hymn', type: 'number', min: 0, autofocus: true },
        { name: 'page', label: 'First one on page', value: String(at.page ? at.page.num : 1), type: 'number', min: 1, max: pageCount() },
        { name: 'per', label: 'Pages each', value: '1', type: 'number', min: 1, max: 10 },
      ],
      ok: 'Add',
    });
    if (!v) return;
    const run = hymnRun(v.from, v.to, v.page, v.per, pageCount());
    if (!run.length) {
      toast('Those numbers don’t make a run of hymns in this score.', 2600);
      return;
    }
    const all = entries();
    const fresh = run.filter((h) => !findHymn(all, h.n) && indexOfNum(h.num) >= 0);
    marks.add(fresh.map((h) => ({ fileId: viewer.pages[indexOfNum(h.num)].fileId, num: h.num, mark: { kind: 'hymn', n: h.n, title: '', y: 0 } })));
    const skipped = run.length - fresh.length;
    const short = Number(v.to) - Number(v.from) + 1 > run.length;
    toast(`${fresh.length} hymn${fresh.length === 1 ? '' : 's'} added${skipped ? ` (${skipped} already in the index)` : ''}${short ? '. The score ran out of pages before the last ones.' : '.'}`, 3200);
  });

  // Titles for the hymns in the index, from a list typed or pasted.
  $('#ix-paste').addEventListener('click', async () => {
    const value = await openModal((dlg, finish) => {
      dlg.innerHTML = `
        <form class="modal-body" method="dialog">
          <h2>Paste titles</h2>
          <p>One hymn a line, with its number first or last, as in the book’s index:<br>245 Amazing Grace<br>Abide with Me ...... 10</p>
          <textarea class="field ix-text" rows="9" autocapitalize="off" spellcheck="false" autofocus></textarea>
        </form>
        <div class="modal-actions">
          <button class="btn" data-v="0">Cancel</button>
          <button class="btn primary" data-v="1">Set titles</button>
        </div>`;
      const ta = dlg.querySelector('textarea');
      dlg.querySelector('[data-v="0"]').onclick = () => finish(null);
      dlg.querySelector('[data-v="1"]').onclick = () => finish(ta.value);
    });
    if (!value) return;
    const lines = parseTitleList(value);
    if (!lines.length) {
      toast('No hymn numbers found in that list.', 2400);
      return;
    }
    const all = entries();
    const missing = [];
    let set = 0;
    marks.batch(() => {
      for (const { n, title } of lines) {
        const h = findHymn(all, n);
        if (!h) missing.push(n);
        else if (h.title !== title) {
          marks.update(h.id, { title });
          set++;
        }
      }
    });
    const ms = [...new Set(missing)].sort(compareNumbers);
    const msg = `${set} title${set === 1 ? '' : 's'} set.` + (ms.length ? ` ${ms.length} number${ms.length === 1 ? ' isn’t' : 's aren’t'} in the index yet (${ms.slice(0, 6).join(', ')}${ms.length > 6 ? '…' : ''}). Add those hymns first, then paste again.` : '');
    await confirmDialog({ title: 'Titles', message: msg, ok: 'OK', cancel: 'Close' });
  });

  // ---- Following a tap area ----

  // A tap on the music: a tap area there goes where it says. Returns whether
  // it was one.
  function tapAt(x, y) {
    if (linking || x == null) return false;
    const hit = marks.linkAtPoint(x, y);
    if (!hit) return false;
    follow(hit.link);
    return true;
  }

  function follow(link) {
    const from = viewer.topPlace();
    if (link.hymn) {
      const h = findHymn(entries(), link.hymn);
      if (!h) {
        toast(`Hymn ${link.hymn} isn’t in the index yet. Add it from Index.`, 3200);
        return;
      }
      viewer.goTo(h.index, h.y);
    } else {
      const i = indexOfNum(link.page);
      if (i < 0) {
        toast(`This score has no page ${link.page}.`, 2400);
        return;
      }
      viewer.goTo(i, 0);
    }
    offerReturn(from);
  }

  // "Back" for a moment, to the page the tap area was on.
  function offerReturn(place) {
    returnTo = place;
    const b = $('#v-return');
    b.hidden = false;
    clearTimeout(returnTimer);
    returnTimer = setTimeout(hideReturn, RETURN_MS);
  }
  function hideReturn() {
    clearTimeout(returnTimer);
    returnTo = null;
    $('#v-return').hidden = true;
  }
  $('#v-return').addEventListener('click', () => {
    if (returnTo) viewer.goTo(returnTo[0], returnTo[1]);
    hideReturn();
  });

  // ---- Drawing tap areas ----

  $('#ix-links').addEventListener('click', () => {
    close();
    startLinking();
  });

  function startLinking() {
    if (linking || !viewer.isOpen) return;
    viewer.ink.commit();
    viewer.inputBlocked = true;
    viewer.root.classList.add('linking');
    bar.hidden = false;
    hideReturn();
    const sc = viewer.scroller;
    const box = document.createElement('div');
    box.className = 'link-draft';
    box.hidden = true;
    viewer.root.appendChild(box);
    const l = { draw: null, box };
    l.onDown = (e) => {
      if (!e.isPrimary || l.draw) return;
      const at = marks.pointAt(e.clientX, e.clientY);
      if (!at) return;
      e.preventDefault();
      try { sc.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      const r = at.page.el.getBoundingClientRect();
      l.draw = { id: e.pointerId, page: at.page, rect: r, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    };
    l.onMove = (e) => {
      const d = l.draw;
      if (!d || d.id !== e.pointerId) return;
      d.x1 = Math.max(d.rect.left, Math.min(d.rect.right, e.clientX));
      d.y1 = Math.max(d.rect.top, Math.min(d.rect.bottom, e.clientY));
      const [x, y, w, h] = boxBetween(d.x0, d.y0, d.x1, d.y1);
      const vr = viewer.root.getBoundingClientRect();
      Object.assign(box.style, { left: `${x - vr.left}px`, top: `${y - vr.top}px`, width: `${w}px`, height: `${h}px` });
      box.hidden = w < 3 && h < 3;
    };
    l.onUp = async (e) => {
      const d = l.draw;
      if (!d || d.id !== e.pointerId) return;
      l.draw = null;
      box.hidden = true;
      if (e.type !== 'pointerup') return;
      const w = Math.abs(d.x1 - d.x0);
      const h = Math.abs(d.y1 - d.y0);
      if (w < MIN_BOX_PX || h < MIN_BOX_PX) {
        const hit = marks.linkAtPoint(d.x0, d.y0);
        if (hit) await changeLink(hit.link);
        else if (w < 4 && h < 4) toast('Drag across a line of the index to make a tap area.', 2000);
        return;
      }
      const a = marks.pointAt(d.x0, d.y0);
      const b = pointOn(d.page, d.x1, d.y1);
      if (!a || a.page !== d.page || !b) return;
      await newLink(d.page, boxBetween(a.u, a.v, b.u, b.v));
    };
    l.onTouch = (e) => e.preventDefault(); // nothing scrolls while drawing
    sc.addEventListener('pointerdown', l.onDown, true);
    sc.addEventListener('pointermove', l.onMove, true);
    sc.addEventListener('pointerup', l.onUp, true);
    sc.addEventListener('pointercancel', l.onUp, true);
    sc.addEventListener('touchstart', l.onTouch, { passive: false, capture: true });
    linking = l;
    updateLinksBar();
    viewer.addEventListener('page', updateLinksBar);
  }

  function stopLinking() {
    const l = linking;
    if (!l) return;
    linking = null;
    const sc = viewer.scroller;
    sc.removeEventListener('pointerdown', l.onDown, true);
    sc.removeEventListener('pointermove', l.onMove, true);
    sc.removeEventListener('pointerup', l.onUp, true);
    sc.removeEventListener('pointercancel', l.onUp, true);
    sc.removeEventListener('touchstart', l.onTouch, { capture: true });
    viewer.removeEventListener('page', updateLinksBar);
    l.box.remove();
    viewer.inputBlocked = false;
    viewer.root.classList.remove('linking');
    bar.hidden = true;
  }

  // A point on a given page (the end of a drag can be off it).
  function pointOn(page, x, y) {
    const r = page.el.getBoundingClientRect();
    const at = marks.pointAt(Math.max(r.left + 1, Math.min(r.right - 1, x)), Math.max(r.top + 1, Math.min(r.bottom - 1, y)));
    return at && at.page === page ? at : null;
  }

  function updateLinksBar() {
    const i = viewer.pageShowing();
    $('#lb-num').textContent = `Page ${viewer.pages[i] ? viewer.pages[i].num : ''}`;
  }

  $('#lb-done').addEventListener('click', stopLinking);
  $('#lb-prev').addEventListener('click', () => viewer.goToIndex(viewer.pageShowing() - 1));
  $('#lb-next').addEventListener('click', () => viewer.goToIndex(viewer.pageShowing() + 1));

  // Where a tap area goes: a hymn in the index, or a page.
  async function linkTarget(title, link = null) {
    return formDialog({
      title,
      message: 'Type the hymn number from the line you drew round. It goes to that hymn in the index. Or give a page instead.',
      fields: [
        { name: 'hymn', label: 'Hymn number', value: link && link.hymn ? link.hymn : '', inputmode: 'numeric', autofocus: true },
        { name: 'page', label: 'or page', value: link && link.page ? String(link.page) : '', type: 'number', min: 1, max: pageCount() },
      ],
      ok: 'Save',
      extra: link ? { label: 'Delete', value: 'delete', danger: true } : null,
    });
  }

  function targetOf(v) {
    const hymn = v.hymn.trim();
    if (hymn) return { hymn };
    const page = Math.round(Number(v.page));
    if (page >= 1 && page <= pageCount()) return { page };
    return null;
  }

  async function newLink(page, box) {
    const v = await linkTarget('Tap area');
    if (!v) return;
    const to = targetOf(v);
    if (!to) {
      toast('Give a hymn number or a page.', 2000);
      return;
    }
    marks.add([{ fileId: page.fileId, num: page.num, mark: { kind: 'link', box, ...to } }]);
    if (to.hymn && !findHymn(entries(), to.hymn)) toast(`Saved. Hymn ${to.hymn} isn’t in the index yet: add it so this goes somewhere.`, 3600);
  }

  async function changeLink(link) {
    const v = await linkTarget(link.hymn ? `Tap area: hymn ${link.hymn}` : `Tap area: page ${link.page}`, link);
    if (!v) return;
    if (v === 'delete') {
      marks.remove(link.id);
      return;
    }
    const to = targetOf(v);
    if (!to) return;
    marks.update(link.id, to.hymn ? { hymn: to.hymn, page: undefined } : { page: to.page, hymn: undefined });
  }

  // The score is closing.
  function reset() {
    stopLinking();
    hideReturn();
    close();
  }

  return {
    open,
    close,
    reset,
    tapAt,
    get isOpen() { return sheet.open; },
    get linking() { return !!linking; },
    stopLinking,
    // What the page chip offers: a hymn number goes to that hymn.
    findHymn: (n) => findHymn(entries(), n),
    hasHymns: () => entries().some((e) => e.kind === 'hymn'),
    entryAt: (index, y) => entryAt(entries(), index, y),
  };
}

// A small form in a modal. fields: [{ name, label, value, type, placeholder,
// min, max, inputmode, autofocus }]. Resolves to { name: value }, extra's
// value if that button was chosen, or null.
function formDialog({ title, message = '', fields, ok = 'OK', extra = null }) {
  return openModal((dlg, finish) => {
    dlg.innerHTML = `
      <form class="modal-body ix-form" method="dialog">
        <h2>${esc(title)}</h2>
        ${message ? `<p>${esc(message)}</p>` : ''}
        ${fields.map((f) => `<label class="ix-field"><span>${esc(f.label)}</span><input class="field" name="${f.name}" type="${f.type || 'text'}"
          ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.type === 'number' ? 'inputmode="numeric"' : ''}
          ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}
          placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}" autocomplete="off" ${f.autofocus ? 'autofocus' : ''}></label>`).join('')}
        <button type="submit" hidden></button>
      </form>
      <div class="modal-actions">
        ${extra ? `<button class="btn ${extra.danger ? 'danger' : ''}" data-v="x">${esc(extra.label)}</button>` : ''}
        <button class="btn" data-v="0">Cancel</button>
        <button class="btn primary" data-v="1">${esc(ok)}</button>
      </div>`;
    const form = dlg.querySelector('form');
    const values = () => Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value]));
    form.onsubmit = (e) => { e.preventDefault(); finish(values()); };
    dlg.querySelector('[data-v="0"]').onclick = () => finish(null);
    dlg.querySelector('[data-v="1"]').onclick = () => finish(values());
    if (extra) dlg.querySelector('[data-v="x"]').onclick = () => finish(extra.value);
  });
}
