// The Index panel of an open score: its hymns and sections, searched by
// number or by words of their titles; adding them where the music is, many
// at once, or titles from a pasted list. And drawing tap areas on a printed
// index page, each going to a hymn or a page. The marks are kept by
// js/marks.js; js/index-logic.js has the rules.
import { $, esc, icon, toast, openModal, confirmDialog, actionSheet } from './ui.js';
import { sortEntries, searchEntries, findHymn, nextNumber, entryAt, parseTitleList, hymnRun, boxBetween, compareNumbers, searchPages } from './index-logic.js';
import { readPage, savedTexts, saveText, release as releaseOcr } from './ocr.js';
import { libraryEdited } from './data.js';
import { pieceKey } from './links.js';

const MIN_BOX_PX = 14; // a drag smaller than this either way isn't a tap area
const RETURN_MS = 12000; // how long "Back" shows after following a tap area

// copyLink(place): copies a link to the open score at { piece } (js/app.js).
export function initIndexUi({ viewer, onOpenChange = () => {}, copyLink = () => {} }) {
  const marks = viewer.marks;
  const sheet = $('#index');
  const search = $('#ix-search');
  const list = $('#ix-list');
  const bar = $('#links-bar');
  let linking = null; // drawing tap areas: { draw, onDown, ... }
  let returnTo = null;
  let returnTimer = 0;
  let texts = null; // { key, byNum: Map page → text } of the open score
  let reading = null; // reading every page: { key, done, total, stop }

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
    loadTexts().then(() => { if (sheet.open) render(); });
  }

  // What the pages of the open score say, as read before.
  async function loadTexts() {
    const k = viewer.key;
    if (texts && texts.key === k) return texts;
    const byNum = new Map();
    for (const fileId of new Set(viewer.pages.map((p) => p.fileId))) {
      for (const [num, text] of await savedTexts(fileId)) byNum.set(`${fileId}:${num}`, text);
    }
    if (viewer.key !== k) return null;
    texts = { key: k, byNum };
    return texts;
  }

  const textOf = (p) => (texts && texts.key === viewer.key ? texts.byNum.get(`${p.fileId}:${p.num}`) : undefined);
  // What can be searched on each page: the words read on it, and its typed
  // notes (js/text-notes.js).
  const pageWords = () => viewer.pages
    .map((p, index) => ({ index, num: p.num, text: [textOf(p), viewer.texts.textOf(p)].filter(Boolean).join('\n') }))
    .filter((p) => p.text);

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
    renderReading();
    const read = pageWords();
    const pageHits = q ? searchPages(read, q) : [];
    const words = pageHits.length
      ? `<h3 class="ix-head">Words on the pages</h3>` + pageHits.slice(0, 200).map((h) => `<div class="ix-row words" data-index="${h.index}">
          <button type="button" class="ix-go"><span class="ix-title ix-snippet">${esc(h.snippet)}</span><span class="ix-page">p. ${h.num}</span></button>
        </div>`).join('')
      : '';
    if (q && !shown.length && words) {
      list.innerHTML = words;
      return;
    }
    if (q && !shown.length && read.length) {
      list.innerHTML = `<div class="ix-empty"><p>Nothing in the index, the typed notes or the pages read matches “${esc(q)}”.</p></div>`;
      return;
    }
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
        <button type="button" class="icon-btn ix-copy" aria-label="Copy link" title="Copy link">${icon('link')}</button>
        <button type="button" class="icon-btn ix-edit" aria-label="Change">${icon('pen')}</button>
      </div>`;
    }).join('') + words;
  }

  // How reading the pages is going, under the buttons.
  function renderReading() {
    const el = $('#ix-reading');
    const b = $('#ix-read-all');
    const n = viewer.pages.length;
    const done = texts && texts.key === viewer.key ? viewer.pages.filter((p) => textOf(p) !== undefined).length : 0;
    if (reading && reading.key === viewer.key) {
      el.hidden = false;
      el.textContent = reading.status || `Reading the pages: ${done} of ${n}. You can keep reading the music meanwhile.`;
      b.textContent = 'Stop reading';
    } else {
      el.hidden = !done;
      el.textContent = done ? (done >= n ? `All ${n} pages have been read: search finds the words on them.` : `${done} of ${n} pages have been read. Read all pages carries on where it stopped.`) : '';
      b.textContent = done && done < n ? 'Read the rest' : 'Read all pages';
      b.hidden = done >= n;
    }
  }
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = searchEntries(entries(), search.value)[0];
    if (first) {
      goToEntry(first);
      return;
    }
    const hit = searchPages(pageWords(), search.value)[0];
    if (hit) {
      close();
      search.blur();
      viewer.goTo(hit.index, 0);
    }
  });

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.ix-row');
    if (!row) return;
    if (row.classList.contains('words')) {
      close();
      search.blur();
      viewer.goTo(+row.dataset.index, 0);
      return;
    }
    const entry = entries().find((x) => x.id === row.dataset.id);
    if (!entry) return;
    if (e.target.closest('.ix-edit')) editEntry(entry);
    else if (e.target.closest('.ix-copy')) copyLink({ piece: pieceKey(entries(), entry) });
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
    const cur = viewer.pages[Math.max(0, viewer.pageShowing())].num;
    const value = await openModal((dlg, finish) => {
      dlg.innerHTML = `
        <form class="modal-body" method="dialog">
          <h2>Paste titles</h2>
          <p>One hymn a line, with its number first or last, as in the book’s index:<br>245 Amazing Grace<br>Abide with Me ...... 10</p>
          <textarea class="field ix-text" rows="9" autocapitalize="off" spellcheck="false"></textarea>
          <div class="ix-ocr">
            <span>Or read the printed index: pages</span>
            <input class="field" name="from" type="number" inputmode="numeric" min="1" max="${pageCount()}" value="${cur}">
            <span>to</span>
            <input class="field" name="to" type="number" inputmode="numeric" min="1" max="${pageCount()}" value="${cur}">
            <button type="button" class="btn small" data-read>Read pages</button>
          </div>
          <p class="ix-ocr-note" data-note>The list it finds goes in the box above. Check it, fix any misread numbers, then tap Set titles.</p>
        </form>
        <div class="modal-actions">
          <button class="btn" data-v="0">Cancel</button>
          <button class="btn primary" data-v="1">Set titles</button>
        </div>`;
      const ta = dlg.querySelector('textarea');
      const note = dlg.querySelector('[data-note]');
      const readBtn = dlg.querySelector('[data-read]');
      let busy = false;
      readBtn.onclick = async () => {
        if (busy) return;
        const a = clampPage(dlg.querySelector('[name=from]').value, cur);
        const b = Math.max(a, clampPage(dlg.querySelector('[name=to]').value, a));
        busy = true;
        readBtn.disabled = true;
        let found = 0;
        try {
          for (let num = a; num <= b; num++) {
            if (!dlg.open) return;
            note.textContent = `Reading page ${num}${b > a ? ` (${num - a + 1} of ${b - a + 1})` : ''}…`;
            const pg = viewer.pages[indexOfNum(num)];
            const text = await readPage(viewer, indexOfNum(num), { onLoading: (m) => loadingNote(note, m) });
            await saveText(pg.fileId, pg.num, text);
            if (texts && texts.key === viewer.key) texts.byNum.set(`${pg.fileId}:${pg.num}`, text);
            const lines = parseTitleList(text);
            found += lines.length;
            if (lines.length) ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + lines.map((l) => `${l.n} ${l.title}`).join('\n');
          }
          libraryEdited();
          note.textContent = found
            ? `Found ${found} hymn${found === 1 ? '' : 's'}. Check the list above (text recognition misreads some letters and numbers), then tap Set titles.`
            : 'No lines with a hymn number were found on those pages. Is it the index? A clearer scan, or cropping the page with Adjust pages, can help.';
        } catch (e) {
          console.warn(e);
          note.textContent = `Reading didn’t work: ${(e && e.message) || e}. Text recognition has to be downloaded once (about 11 MB) while online.`;
        } finally {
          busy = false;
          readBtn.disabled = false;
        }
      };
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

  // ---- Reading every page, so its words can be searched ----

  $('#ix-read-all').addEventListener('click', async () => {
    if (reading && reading.key === viewer.key) {
      reading.stop = true;
      reading.status = 'Stopping…';
      renderReading();
      return;
    }
    await loadTexts();
    readAll();
  });

  async function readAll() {
    const job = { key: viewer.key, stop: false, status: '' };
    reading = job;
    renderReading();
    const live = () => !job.stop && viewer.key === job.key && viewer.isOpen;
    let failed = null;
    let count = 0;
    try {
      for (let i = 0; i < viewer.pages.length && live(); i++) {
        const p = viewer.pages[i];
        if (textOf(p) !== undefined) continue;
        // Not while a page turns or the Pencil writes: they come first.
        while (live() && (viewer.animating || viewer.ink.busy)) await new Promise((r) => setTimeout(r, 300));
        if (!live()) break;
        const text = await readPage(viewer, i, {
          onLoading: (m) => {
            if (/load|initializ/i.test(m.status) && m.progress < 1) {
              job.status = `Getting text recognition ready (${Math.round((m.progress || 0) * 100)}%)… The first time, this downloads about 11 MB.`;
              if (sheet.open) renderReading();
            }
          },
        });
        if (viewer.key !== job.key) break;
        await saveText(p.fileId, p.num, text);
        texts.byNum.set(`${p.fileId}:${p.num}`, text);
        count++;
        if (count % 25 === 0) libraryEdited(); // Google Drive sync sends it on
        job.status = '';
        if (sheet.open) (search.value.trim() ? render() : renderReading());
      }
    } catch (e) {
      console.warn(e);
      failed = e;
    }
    if (reading === job) reading = null;
    releaseOcr();
    if (count) libraryEdited();
    if (viewer.key !== job.key) return;
    if (sheet.open) render();
    if (failed) toast(`Reading the pages stopped: ${(failed && failed.message) || failed}. It needs to download text recognition once while online.`, 5000);
    else if (!job.stop && count) toast('All pages have been read. Search the Index for any words on them.', 3200);
  }

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
    if (reading) reading.stop = true;
    texts = null;
    releaseOcr(true);
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
    entries,
  };
}

// Shows how getting text recognition ready is going.
function loadingNote(el, m) {
  if (/load|initializ/i.test(m.status) && m.progress < 1) el.textContent = `Getting text recognition ready (${Math.round((m.progress || 0) * 100)}%)… The first time, this downloads about 11 MB.`;
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
