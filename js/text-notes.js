// Typed notes on the music: text boxes, each either open (its text shows on
// the page) or collapsed to a small marker. They are index marks of kind
// 'note' (js/notes-merge.js), kept by js/marks.js, so they sync and go into
// backups with the page's other marks; their changes join the markings' undo
// history (js/notes-store.js).
//
// Each page with notes gets a layer over its canvas, sized, cropped and
// turned like the markings layers (js/ink-draw.js placeLayer), so a note
// stays on its music at every zoom and in both ways of turning pages. A note
// is turned back by the turn the page had when it was written, so it reads
// upright that way.
//
// Reading, a tap on a note opens or collapses it. With the Text tool, a tap
// on the page makes a note there, a tap on a note changes it, and a note can
// be dragged; the one being written has a box to type in (Apple Pencil
// Scribble works there), a handle to move it and one to set its width.
import { getSettings, updateSettings, onSettings } from './data.js';
import { PAGE_W, PENS, inkColor, placeLayer } from './ink-draw.js';
import { shownToPage } from './page-view.js';
import { newMarkId } from './marks.js';

const NEW_W = 0.26; // a new note's width, of the page's
const MIN_W = 0.05;
const DRAG_PX = 6; // a touch on a note that moves this far drags it
const SAVE_MS = 400; // typing is saved this long after it stops
const COLOR_NAMES = ['Black', 'Red', 'Blue', 'Green', 'Orange'];
const SIZE_NAMES = ['Small', 'Medium', 'Large'];

const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/><path d="M8.5 8.5h7M8.5 12h4"/></svg>';

const night = () => !!getSettings().nightMode;
// The parts of a note that matter (not when it was changed).
const content = (m) => (m ? JSON.stringify({ ...m, at: 0 }) : '');

export class TextNotes {
  constructor(viewer) {
    this.viewer = viewer;
    this.marks = viewer.marks;
    this.ink = viewer.ink;
    this.ink.store.applyNote = (op) => this.#apply(op);
    this.editing = null; // the note being written: { id, fileId, num, page, before, mark, el, ta, timer }
    this.drag = null;
    this.bar = document.getElementById('tnote-bar');
    this.marks.addEventListener('change', () => this.#redrawAll());
    this.ink.addEventListener('state', () => this.#onToolState());
    onSettings((s, patch) => { if ('nightMode' in patch) this.#redrawAll(); });
    this.#setupInput();
    if (this.bar) this.#setupBar();
  }

  // ---- Lifecycle (called by the viewer) ----

  close() {
    this.commit();
    this.drag = null;
  }

  // A page came near the screen (show) or left it (hide).
  show(p) {
    if (!p.texts && this.marks.notes(p).length) this.#draw(p);
  }

  hide(p) {
    if (!p.texts) return;
    if (this.editing && this.editing.page === p) this.commit();
    p.texts.remove();
    p.texts = null;
  }

  // The page was laid out again.
  place(p) {
    if (!p.texts) return;
    placeLayer(p.texts, p);
    const width = p.inkBox ? p.inkBox.width : p.cssW;
    p.texts.style.setProperty('--u', `${width / PAGE_W}px`);
  }

  // Saves what is being typed now (the app is going to the background).
  saveNow() {
    if (this.editing) this.#save();
  }

  // ---- Reading ----

  // A tap on the music at (x, y) on the screen. Reading, a tap on a note
  // opens or collapses it; with the Text tool, a tap on the page makes a
  // note (or first finishes the one being written). Returns whether the tap
  // was taken.
  tapAt(x, y) {
    if (x == null || !this.viewer.isOpen) return false;
    const under = document.elementFromPoint(x, y);
    const el = under && under.closest ? under.closest('.tnote') : null;
    if (this.ink.texting) {
      if (el) this.edit(el.dataset.id);
      else if (this.editing) this.commit();
      else if (this.ink.hidden) this.#hint('Markings are hidden. Tap ⋯, then Show markings.');
      else this.#create(x, y);
      return true;
    }
    if (!el || this.ink.hidden || !this.viewer.pagesEl.contains(el)) return false;
    this.toggle(el.dataset.id);
    return true;
  }

  toggle(id) {
    const found = this.marks.get(id);
    if (!found || found.mark.kind !== 'note') return;
    this.marks.put(found.fileId, found.num, { ...found.mark, open: !found.mark.open });
  }

  // How many notes the score has, and how many are open.
  counts() {
    const all = this.marks.allNotes();
    return { all: all.length, open: all.filter((n) => n.mark.open).length };
  }

  // Opens (true) or collapses every note of the score.
  setAllOpen(open) {
    this.commit();
    const now = Date.now();
    const list = this.marks.allNotes().filter((n) => n.mark.open !== open);
    if (list.length) this.marks.putMany(list.map((n) => ({ fileId: n.fileId, num: n.num, mark: { ...n.mark, open, at: Math.max(now, n.mark.at + 1) } })));
    return list.length;
  }

  // What the notes on a page say (searched with the words on the pages).
  textOf(p) {
    return this.marks.notes(p).map((n) => n.text).filter((t) => t.trim()).join('\n');
  }

  // ---- Writing ----

  #create(x, y) {
    const at = this.#pointAt(x, y);
    if (!at) return;
    const p = at.page;
    const s = getSettings();
    const r = p.view ? p.view.rot : 0;
    const w = NEW_W;
    // Upright on an unturned page, it starts where tapped but stays on the page.
    const fx = r === 0 ? Math.max(0, Math.min(1 - w, at.fx)) : at.fx;
    const mark = { id: newMarkId(), kind: 'note', x: fx, y: at.fy, w, r, text: '', color: PENS.colors[s.textColor] || PENS.colors[0], size: s.textSize ?? 1, open: true };
    this.commit();
    this.marks.put(p.fileId, p.num, mark);
    this.edit(mark.id, { fresh: true });
  }

  // Starts writing in a note (fresh: just made, so undo takes it away).
  edit(id, { fresh = false } = {}) {
    if (this.editing && this.editing.id === id) {
      this.editing.ta.focus({ preventScroll: true });
      return;
    }
    this.commit();
    const found = this.marks.get(id);
    if (!found || found.mark.kind !== 'note') return;
    const page = this.viewer.pages.find((p) => p.fileId === found.fileId && p.num === found.num);
    if (!page || !page.el) return;
    this.editing = { id, fileId: found.fileId, num: found.num, page, before: fresh ? null : found.mark, mark: { ...found.mark, open: true }, el: null, ta: null, timer: 0 };
    if (!found.mark.open) this.marks.put(found.fileId, found.num, this.editing.mark);
    this.#draw(page);
    const ed = this.editing;
    if (!ed || !ed.ta) return;
    this.viewer.root.classList.add('note-editing');
    this.#renderBar();
    ed.ta.focus({ preventScroll: true });
    if (!fresh) ed.ta.setSelectionRange(ed.ta.value.length, ed.ta.value.length);
  }

  // Finishes the note being written: one change to undo. A note left empty
  // goes.
  commit() {
    const ed = this.editing;
    if (!ed) return;
    clearTimeout(ed.timer);
    this.editing = null;
    this.viewer.root.classList.remove('note-editing');
    if (this.bar) this.bar.hidden = true;
    if (document.activeElement === ed.ta) ed.ta.blur();
    const after = { ...ed.mark, text: ed.ta ? ed.ta.value : ed.mark.text };
    if (!after.text.trim()) {
      this.marks.remove(ed.id);
      if (ed.before) this.ink.store.recordNote(ed.fileId, ed.num, ed.before, null);
    } else {
      const now = this.marks.get(ed.id);
      if (!now || content(now.mark) !== content(after)) this.marks.put(ed.fileId, ed.num, after);
      const saved = this.marks.get(ed.id);
      if (saved && content(saved.mark) !== content(ed.before)) this.ink.store.recordNote(ed.fileId, ed.num, ed.before, saved.mark);
    }
    if (ed.page.texts) this.#draw(ed.page);
  }

  // Deletes the note being written.
  #deleteEditing() {
    const ed = this.editing;
    if (!ed) return;
    ed.ta.value = '';
    this.commit();
  }

  // Keeps what has been typed (as the note goes along; undo takes the whole
  // writing back at once).
  #save() {
    const ed = this.editing;
    if (!ed) return;
    clearTimeout(ed.timer);
    ed.mark = { ...ed.mark, text: ed.ta.value };
    const now = this.marks.get(ed.id);
    if (!now || content(now.mark) !== content(ed.mark)) this.marks.put(ed.fileId, ed.num, ed.mark);
  }

  // Undo and redo (js/notes-store.js).
  #apply(op) {
    if (this.editing && this.editing.id === (op.after || op.before).id) this.commit();
    if (op.after) this.marks.put(op.fileId, op.num, op.after);
    else this.marks.remove(op.before.id);
  }

  #hint(text) {
    this.ink.dispatchEvent(new CustomEvent('hint', { detail: text }));
  }

  #onToolState() {
    const on = this.ink.texting && !this.ink.hidden;
    this.viewer.root.classList.toggle('texting', on);
    if (!on && this.editing) this.commit();
  }

  // ---- Drawing ----

  #redrawAll() {
    for (const p of this.viewer.pages) {
      if (p.texts || (this.viewer.isKept(p) && this.marks.notes(p).length)) this.#draw(p);
    }
  }

  #draw(p) {
    const notes = this.marks.notes(p);
    const ed = this.editing && this.editing.page === p ? this.editing : null;
    if (!notes.length && !ed) {
      this.hide(p);
      return;
    }
    if (!p.el) return;
    if (!p.texts) {
      const layer = document.createElement('div');
      layer.className = 'tnotes';
      p.el.appendChild(layer);
      p.texts = layer;
      this.place(p);
    }
    // The note being written stays as it is (taking it out would put the
    // keyboard away).
    const keep = ed && ed.el && ed.el.parentNode === p.texts ? ed.el : null;
    for (const c of [...p.texts.children]) if (c !== keep) c.remove();
    for (const n of notes) {
      if (keep && n.id === ed.id) continue;
      p.texts.appendChild(ed && n.id === ed.id ? this.#editorEl(ed) : this.#noteEl(n));
    }
    if (ed && !ed.el) p.texts.appendChild(this.#editorEl(ed));
  }

  #styleNote(el, n) {
    el.className = `tnote s${n.size} ${n.open ? 'open' : 'shut'}`;
    el.dataset.id = n.id;
    el.style.left = `${n.x * 100}%`;
    el.style.top = `${n.y * 100}%`;
    el.style.width = n.open ? `${n.w * 100}%` : '';
    el.style.color = inkColor({ tool: 'pen', color: n.color }, night());
    el.style.transform = n.r ? `rotate(${-n.r}deg)` : '';
  }

  #noteEl(n) {
    const el = document.createElement('div');
    this.#styleNote(el, n);
    if (n.open) {
      el.textContent = n.text;
    } else {
      el.innerHTML = NOTE_ICON;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `Note: ${n.text.slice(0, 80)}`);
    }
    return el;
  }

  #editorEl(ed) {
    const el = document.createElement('div');
    this.#styleNote(el, ed.mark);
    el.classList.add('editing');
    const ta = document.createElement('textarea');
    ta.className = 'tnote-text';
    ta.rows = 1;
    ta.value = ed.mark.text;
    ta.setAttribute('aria-label', 'Note');
    ta.setAttribute('enterkeyhint', 'enter');
    ta.addEventListener('input', () => {
      this.#fit(ta);
      clearTimeout(ed.timer);
      ed.timer = setTimeout(() => this.#save(), SAVE_MS);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.commit();
      }
    });
    const grip = document.createElement('span');
    grip.className = 'tnote-grip';
    grip.dataset.drag = 'move';
    grip.setAttribute('aria-label', 'Move note');
    const width = document.createElement('span');
    width.className = 'tnote-width';
    width.dataset.drag = 'width';
    width.setAttribute('aria-label', 'Note width');
    el.append(ta, grip, width);
    ed.el = el;
    ed.ta = ta;
    requestAnimationFrame(() => this.#fit(ta));
    return el;
  }

  // The writing box grows with its text.
  #fit(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }

  // ---- Where things are ----

  // The page under a point on the screen, and the point as fractions of
  // the page in the PDF (fx, fy; not kept on the page).
  #pointAt(clientX, clientY) {
    const under = document.elementFromPoint(clientX, clientY);
    const el = under && under.closest && under.closest('.page');
    if (!el || !this.viewer.pagesEl.contains(el)) return null;
    const page = this.viewer.pages[+el.dataset.index];
    return page ? { page, ...this.#onPage(page, clientX, clientY) } : null;
  }

  #onPage(page, clientX, clientY) {
    const r = page.el.getBoundingClientRect();
    const k = page.w / r.width;
    const [u, v] = shownToPage(page.view, page.pw, page.ph, (clientX - r.left) * k, (clientY - r.top) * k);
    return { fx: u / page.pw, fy: v / page.ph };
  }

  // ---- Moving and sizing (Text tool) ----

  #setupInput() {
    const root = this.viewer.pagesEl;
    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    // A finger or the Pencil makes the browser's mouse events after it lifts,
    // and those would take the keyboard from a note just made by the tap.
    // (Scrolling still works: that is touch-action's.)
    this.viewer.scroller.addEventListener('pointerdown', (e) => {
      if (this.ink.texting && e.pointerType !== 'mouse' && !(e.target.closest && e.target.closest('textarea'))) e.preventDefault();
    });
    // If the browser didn't let the tap itself bring the keyboard up, the
    // click that follows it can.
    this.viewer.scroller.addEventListener('click', () => {
      const ed = this.editing;
      if (ed && ed.ta && document.activeElement !== ed.ta) ed.ta.focus({ preventScroll: true });
    });
    root.addEventListener('pointerdown', (e) => {
      if (!this.ink.texting || this.drag) return;
      const el = e.target.closest && e.target.closest('.tnote');
      if (!el) return;
      // The page doesn't scroll, turn or take it as a tap.
      e.stopPropagation();
      if (e.target.closest('textarea')) return; // placing the caret
      e.preventDefault();
      const found = this.marks.get(el.dataset.id);
      const ed = this.editing && this.editing.id === el.dataset.id ? this.editing : null;
      const mark = ed ? ed.mark : found && found.mark;
      const page = found && this.viewer.pages.find((p) => p.fileId === found.fileId && p.num === found.num);
      if (!mark || !page) return;
      const kind = ed ? e.target.dataset.drag : 'move';
      if (!kind) return;
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      const view = page.view || {};
      const angle = (((view.rot || 0) + (view.tilt || 0) - mark.r) * Math.PI) / 180;
      this.drag = { id: e.pointerId, el, kind, page, mark, ed, x0: e.clientX, y0: e.clientY, at0: this.#onPage(page, e.clientX, e.clientY), angle, moved: false, next: mark };
    });
    root.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      e.stopPropagation();
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_PX) return;
      d.moved = true;
      if (d.kind === 'move') {
        const at = this.#onPage(d.page, e.clientX, e.clientY);
        d.next = { ...d.mark, x: clamp01(d.mark.x + at.fx - d.at0.fx), y: clamp01(d.mark.y + at.fy - d.at0.fy) };
        d.el.style.left = `${d.next.x * 100}%`;
        d.el.style.top = `${d.next.y * 100}%`;
      } else {
        const along = (e.clientX - d.x0) * Math.cos(d.angle) + (e.clientY - d.y0) * Math.sin(d.angle);
        const width = d.page.inkBox ? d.page.inkBox.width : d.page.cssW;
        d.next = { ...d.mark, w: Math.max(MIN_W, Math.min(1, d.mark.w + along / width)) };
        d.el.style.width = `${d.next.w * 100}%`;
        if (d.ed) this.#fit(d.ed.ta);
      }
    });
    const end = (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      e.stopPropagation();
      this.drag = null;
      const page = d.page;
      if (!d.moved) {
        if (e.type === 'pointerup' && !d.ed) this.edit(d.mark.id);
        return;
      }
      if (d.ed) {
        // Part of the writing: undone with it.
        d.ed.mark = { ...d.next, text: d.ed.ta.value };
        this.#save();
        return;
      }
      if (e.type !== 'pointerup') {
        this.#draw(page);
        return;
      }
      this.marks.put(page.fileId, page.num, d.next);
      const saved = this.marks.get(d.mark.id);
      if (saved) this.ink.store.recordNote(page.fileId, page.num, d.mark, saved.mark);
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
  }

  // ---- The bar over the note being written ----

  #renderBar() {
    const ed = this.editing;
    if (!ed || !this.bar) return;
    const m = ed.mark;
    const nightMode = night();
    this.bar.innerHTML =
      PENS.colors.map((c, i) => `<button class="swatch" role="radio" data-color="${i}" aria-checked="${m.color === c}" aria-label="${COLOR_NAMES[i]}"><i style="background:${nightMode ? PENS.night[i] : c}"></i></button>`).join('') +
      '<span class="sep"></span>' +
      SIZE_NAMES.map((name, i) => `<button class="size-btn text-size" role="radio" data-size="${i}" aria-checked="${m.size === i}" aria-label="${name} text"><b style="font-size:${13 + i * 5}px">A</b></button>`).join('') +
      '<span class="sep"></span>' +
      '<button class="btn small" data-act="collapse">Collapse</button>' +
      '<button class="btn small danger" data-act="delete">Delete</button>' +
      '<button class="btn small primary" data-act="done">Done</button>';
    this.bar.hidden = false;
    this.bar.style.left = `${Math.max(12, (window.innerWidth - this.bar.offsetWidth) / 2)}px`;
  }

  #setupBar() {
    // The bar's buttons leave the keyboard up.
    this.bar.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    this.bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      const ed = this.editing;
      if (!b || !ed) return;
      const d = b.dataset;
      if (d.color != null) {
        ed.mark = { ...ed.mark, color: PENS.colors[+d.color] };
        updateSettings({ textColor: +d.color });
      } else if (d.size != null) {
        ed.mark = { ...ed.mark, size: +d.size };
        updateSettings({ textSize: +d.size });
      } else if (d.act === 'collapse') {
        ed.mark = { ...ed.mark, open: false };
        this.commit();
        return;
      } else if (d.act === 'delete') {
        this.#deleteEditing();
        return;
      } else if (d.act === 'done') {
        this.commit();
        return;
      }
      ed.mark = { ...ed.mark, text: ed.ta.value };
      this.#styleNote(ed.el, ed.mark);
      ed.el.classList.add('editing');
      this.#fit(ed.ta);
      this.#save();
      this.#renderBar();
    });
  }
}
