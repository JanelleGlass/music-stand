// Writing on the music: the markings layer of the open score. The Apple
// Pencil writes (fingers still scroll and turn pages); with the markings
// tools open, a mouse writes too, and so can a finger if chosen (then two
// fingers scroll).
//
// Pages with markings get svg layers over their canvas (js/ink-draw.js); the
// strokes are kept by js/notes-store.js. While a stroke is being drawn the
// viewer holds still: page turns wait and pages aren't redrawn.
import { getSettings, onSettings } from './data.js';
import { NotesStore, newStrokeId } from './notes-store.js';
import { shownToPage } from './page-view.js';
import { PAGE_W, PENS, HIGHLIGHTERS, makeLayers, removeLayers, liveLayer, strokeEl, drawAll, removeStrokeEl, pathData, strokesToErase, decimate, simplify } from './ink-draw.js';

const ERASER_REACH = 7; // page units around the eraser tip
const MIN_GAP = 0.75; // page units between captured points
const SIMPLIFY = 0.25; // page units a kept stroke may differ from what was drawn
const START_MOVE_PX = 4; // with the tools closed, a Pencil touch writes once it moves this far
const TAP_MS = 400;
const SETTLE_MS = 300; // page turns wait this long after a stroke

export class Ink extends EventTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.scroller = viewer.scroller;
    this.store = new NotesStore();
    this.store.onChange = (op) => this.#changed(op);
    this.store.onError = () => this.dispatchEvent(new CustomEvent('hint', { detail: 'Markings couldn’t be saved. Music Stand keeps trying; if this goes on, close and reopen the app.' }));
    this.pages = [];
    this.tool = getSettings().notesTool === 'hl' ? 'hl' : 'pen';
    this.toolbarOpen = false;
    this.fingerDraws = false;
    this.hidden = false;
    this.active = null; // the stroke being drawn
    this.twoFinger = false; // two fingers are scrolling (through viewer.drag*)
    this.raf = 0;
    this.settleUntil = 0;
    this.hiddenHintAt = 0;
    this.#setupInput();
    onSettings((s, patch) => { if ('nightMode' in patch) this.#redrawShown(); });
  }

  // ---- Lifecycle (called by the viewer) ----

  async open(pages) {
    this.pages = pages;
    await this.store.load(pages.map((p) => p.fileId));
  }

  close() {
    this.#endStroke(false);
    this.store.flush();
    this.pages = [];
  }

  flush() {
    return this.store.flush();
  }

  // A page came near the screen (show) or left it (hide).
  show(p) {
    if (!p.ink && this.store.hasNotes(p.fileId, p.num)) this.#layersFor(p);
  }

  hide(p) {
    if (!p.ink || (this.active && this.active.page === p)) return;
    removeLayers(p.ink);
    p.ink = null;
  }

  #layersFor(p) {
    if (!p.ink) {
      p.ink = makeLayers(p);
      drawAll(p.ink, this.store.strokes(p.fileId, p.num), night());
    }
    return p.ink;
  }

  #redrawShown() {
    for (const p of this.pages) if (p.ink) drawAll(p.ink, this.store.strokes(p.fileId, p.num), night());
  }

  // ---- State the viewer and the tools ask about ----

  // A stroke is being drawn, or just was: the page mustn't move. (A Pencil
  // resting on the glass isn't a stroke until it moves.)
  get busy() {
    return this.drawing || performance.now() < this.settleUntil;
  }

  get drawing() {
    return !!this.active && this.active.started;
  }

  // The Pencil is on the glass where it would write.
  get penDown() {
    return !!this.active && this.active.pointerType === 'pen';
  }

  // The Text tool is in use: a tap on the page makes a typed note
  // (js/text-notes.js) and nothing draws.
  get texting() {
    return this.toolbarOpen && this.tool === 'text';
  }

  // Finger taps write instead of turning pages.
  get takesFingers() {
    return this.toolbarOpen && this.fingerDraws && !this.texting && !this.hidden && !this.viewer.inputBlocked;
  }

  // A Pencil touch on a page would write (rather than scroll).
  get pencilWrites() {
    return !this.hidden && !this.texting && !this.viewer.inputBlocked && (getSettings().pencilDraws || this.toolbarOpen);
  }

  get canUndo() { return this.store.canUndo; }
  get canRedo() { return this.store.canRedo; }

  // ---- Tools ----

  setTool(tool) {
    this.tool = tool;
    this.dispatchEvent(new Event('state'));
  }

  // The pen or highlighter look in use.
  look() {
    const s = getSettings();
    if (this.tool === 'hl') return { tool: 'hl', color: HIGHLIGHTERS.colors[s.hlColor] || HIGHLIGHTERS.colors[0], w: HIGHLIGHTERS.width };
    return { tool: 'pen', color: PENS.colors[s.penColor] || PENS.colors[0], w: PENS.widths[s.penWidth] ?? PENS.widths[1] };
  }

  setToolbarOpen(open) {
    this.toolbarOpen = open;
    // The eraser and the Text tool belong to the tools: with them closed,
    // the Pencil writes.
    if (!open && (this.tool === 'eraser' || this.tool === 'text')) this.tool = getSettings().notesTool === 'hl' ? 'hl' : 'pen';
    if (!open) this.#endStroke(true);
    this.#applyTouchMode();
    this.dispatchEvent(new Event('state'));
  }

  setFingerDraws(on) {
    this.fingerDraws = on;
    this.#applyTouchMode();
    this.dispatchEvent(new Event('state'));
  }

  setHidden(hidden) {
    if (hidden) this.#endStroke(true);
    this.hidden = hidden;
    this.viewer.root.classList.toggle('notes-hidden', hidden);
    this.#applyTouchMode();
    this.dispatchEvent(new Event('state'));
  }

  // A typed note being written is finished first, so it can be undone too.
  undo() {
    this.viewer.texts.commit();
    this.#reveal(this.store.undo());
  }

  redo() {
    this.viewer.texts.commit();
    this.#reveal(this.store.redo());
  }

  // The page in the middle of the screen, which Clear page clears.
  centerPage() {
    return this.viewer.pages[this.viewer.indexAtCenter()] || null;
  }

  clearPage(p) {
    if (!p || !this.store.hasNotes(p.fileId, p.num)) return false;
    this.store.clear(p.fileId, p.num);
    return true;
  }

  hasNotes(p) {
    return !!p && this.store.hasNotes(p.fileId, p.num);
  }

  // Undo or redo on a page that's off the screen: go there, so it shows.
  #reveal(op) {
    if (!op) return;
    const i = this.pages.findIndex((p) => p.fileId === op.fileId && p.num === op.num);
    if (i >= 0 && !this.viewer.isOnScreen(i)) this.viewer.goToIndex(i);
  }

  #applyTouchMode() {
    this.scroller.classList.toggle('finger-ink', this.takesFingers);
  }

  #changed(op) {
    const p = this.pages.find((x) => x.fileId === op.fileId && x.num === op.num);
    if (p && op.type !== 'note') {
      const strokes = this.store.strokes(p.fileId, p.num);
      if (!p.ink && strokes.length) this.#layersFor(p);
      else if (p.ink && op.fresh) {
        for (const s of op.strokes) p.ink[s.tool === 'hl' ? 'hl' : 'pen'].appendChild(strokeEl(s, night()));
      } else if (p.ink) drawAll(p.ink, strokes, night());
    }
    this.dispatchEvent(new Event('state'));
  }

  // ---- Input ----

  #wants(e) {
    if (!this.pages.length) return false;
    if (e.pointerType === 'pen') return this.pencilWrites;
    if (e.pointerType === 'touch') return this.takesFingers && e.isPrimary && !this.twoFinger;
    if (e.pointerType === 'mouse') return this.toolbarOpen && !this.texting && !this.hidden && !this.viewer.inputBlocked && e.button === 0;
    return false;
  }

  #pageAt(e) {
    const el = e.target.closest && e.target.closest('.page');
    if (!el || !this.viewer.pagesEl.contains(el)) return null;
    return this.viewer.pages[+el.dataset.index] || null;
  }

  // Pointer position in the page's units, kept on the page. A cropped or
  // turned page (js/page-view.js) is followed back to the page in the PDF.
  #point(page, x, y) {
    const r = page.el.getBoundingClientRect();
    const k = page.w / r.width; // PDF units per CSS px
    const [u, v] = shownToPage(page.view, page.pw, page.ph, (x - r.left) * k, (y - r.top) * k);
    const s = PAGE_W / page.pw;
    return [
      Math.max(0, Math.min(PAGE_W, u * s)),
      Math.max(0, Math.min(PAGE_W * page.ph / page.pw, v * s)),
    ];
  }

  #setupInput() {
    const sc = this.scroller;

    // iPadOS scrolls under the Pencil unless its touches are cancelled. Only
    // when the Pencil will write, so otherwise it still scrolls. Finger
    // touches are left alone, except in finger mode, where one finger writes
    // and two scroll (the page can't scroll by itself then).
    sc.addEventListener('touchstart', (e) => {
      if (!this.pages.length) return;
      if ([...e.changedTouches].some((t) => t.touchType === 'stylus')) {
        if (this.pencilWrites) e.preventDefault();
        return;
      }
      // A hand landing while the Pencil writes doesn't scroll.
      if (this.active && this.active.pointerType === 'pen') {
        e.preventDefault();
        return;
      }
      if (!this.takesFingers) return;
      e.preventDefault();
      const fingers = [...e.touches].filter((t) => t.touchType !== 'stylus');
      if (fingers.length >= 2) {
        // A second finger: this is a scroll, so the first finger's mark goes.
        if (this.active && this.active.pointerType === 'touch') this.#endStroke(false);
        this.twoFinger = true;
        this.viewer.dragStart(avgY(fingers));
      }
    }, { passive: false });

    sc.addEventListener('touchmove', (e) => {
      const fingers = [...e.touches].filter((t) => t.touchType !== 'stylus');
      if (!this.twoFinger || fingers.length < 2) return;
      this.viewer.dragMove(avgY(fingers));
    }, { passive: true });

    // One page at a time, the music then settles on a page.
    const endTouches = (e) => {
      if (this.twoFinger && [...e.touches].filter((t) => t.touchType !== 'stylus').length < 2) {
        this.twoFinger = false;
        this.viewer.dragEnd();
      }
    };
    sc.addEventListener('touchend', endTouches);
    sc.addEventListener('touchcancel', endTouches);

    sc.addEventListener('pointerdown', (e) => this.#down(e));
    sc.addEventListener('pointermove', (e) => this.#move(e));
    sc.addEventListener('pointerup', (e) => {
      if (this.active && e.pointerId === this.active.pointerId) this.#up(e);
    });
    // The system took the touch over: keep what was drawn.
    sc.addEventListener('pointercancel', (e) => {
      if (this.active && e.pointerId === this.active.pointerId) this.#endStroke(true);
    });
  }

  #down(e) {
    if (this.active) return;
    // The Pencil would write, but the markings are hidden.
    if (e.pointerType === 'pen' && this.hidden && (getSettings().pencilDraws || this.toolbarOpen)) {
      if (performance.now() - this.hiddenHintAt > 4000) {
        this.hiddenHintAt = performance.now();
        const how = this.toolbarOpen ? 'Tap ⋯, then Show markings.' : 'Tap the pen button to show them.';
        this.dispatchEvent(new CustomEvent('hint', { detail: `Markings are hidden. ${how}` }));
      }
      return;
    }
    if (!this.#wants(e) || !this.#pageAt(e)) return;
    e.preventDefault();
    try { this.scroller.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    // Writing during a page turn: finish the turn first, then see which page
    // is under the Pencil now.
    this.viewer.finishAnimation();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const el = under && under.closest('.page');
    const page = el && this.viewer.pagesEl.contains(el) ? this.viewer.pages[+el.dataset.index] : null;
    if (!page) return;
    const [x, y] = this.#point(page, e.clientX, e.clientY);
    const a = {
      page,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      downX: e.clientX,
      downY: e.clientY,
      downAt: performance.now(),
      scrollTop: this.scroller.scrollTop,
      layoutGen: this.viewer.layoutGen,
      pts: [x, y],
      last: [x, y],
      erase: this.tool === 'eraser',
      ids: new Set(),
      look: null,
      live: null,
      el: null,
      // With the tools closed, a Pencil touch that doesn't move is a tap.
      started: false,
      frozen: false,
      // A touch that just stops the music gliding isn't a tap.
      afterScroll: performance.now() - this.viewer.lastUserScrollAt < 120,
    };
    this.active = a;
    if (!(e.pointerType === 'pen' && !this.toolbarOpen)) this.#start(a);
    if (a.erase) this.#eraseTo(a, x, y);
  }

  #start(a) {
    a.started = true;
    this.dispatchEvent(new Event('inkstart'));
    if (a.erase) return;
    a.look = this.look();
    a.live = liveLayer(a.page);
    if (a.look.tool === 'hl') a.live.classList.add('is-hl');
    a.el = strokeEl({ ...a.look, pts: a.pts }, night());
    a.live.appendChild(a.el);
  }

  #move(e) {
    const a = this.active;
    if (!a || e.pointerId !== a.pointerId || a.frozen) return;
    // The page moved under the stroke (a scroll, a new layout): it ends here.
    if (Math.abs(this.scroller.scrollTop - a.scrollTop) > 2 || this.viewer.layoutGen !== a.layoutGen) {
      a.frozen = true;
      return;
    }
    if (!a.started) {
      if (Math.hypot(e.clientX - a.downX, e.clientY - a.downY) < START_MOVE_PX) return;
      this.#start(a);
    }
    // Coalesced events lack their own pointerId in some Safari versions, so
    // only their positions are used.
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of list.length ? list : [e]) {
      const [x, y] = this.#point(a.page, ev.clientX, ev.clientY);
      if (a.erase) this.#eraseTo(a, x, y);
      else decimate(a.pts, x, y, MIN_GAP);
    }
    if (!a.erase && !this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (this.active === a) a.el.setAttribute('d', pathData(a.pts.map((n) => Math.round(n * 10) / 10)));
      });
    }
  }

  #up(e) {
    const a = this.active;
    if (!a.started) {
      // A quick Pencil tap with the tools closed works like a finger tap.
      const tap = performance.now() - a.downAt < TAP_MS && !a.frozen && !a.afterScroll &&
        Math.hypot(e.clientX - a.downX, e.clientY - a.downY) <= 12;
      this.#endStroke(false);
      if (tap) {
        const r = this.scroller.getBoundingClientRect();
        this.viewer.dispatchEvent(new CustomEvent('tap', { detail: { fy: (e.clientY - r.top) / r.height, x: e.clientX, y: e.clientY } }));
      }
      return;
    }
    this.#endStroke(true);
  }

  #eraseTo(a, x, y) {
    const [x0, y0] = a.last;
    a.last = [x, y];
    const strokes = this.store.strokes(a.page.fileId, a.page.num).filter((s) => !a.ids.has(s.id));
    for (const s of strokesToErase(strokes, x0, y0, x, y, ERASER_REACH)) {
      a.ids.add(s.id);
      if (a.page.ink) removeStrokeEl(a.page.ink, s.id);
    }
  }

  // Ends the stroke being drawn, keeping it (keep) or not.
  #endStroke(keep) {
    const a = this.active;
    if (!a) return;
    this.active = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (a.live) a.live.remove();
    if (!a.started) return;
    this.settleUntil = performance.now() + SETTLE_MS;
    if (a.erase) {
      if (keep && a.ids.size) this.store.erase(a.page.fileId, a.page.num, [...a.ids]);
      else if (a.page.ink) drawAll(a.page.ink, this.store.strokes(a.page.fileId, a.page.num), night());
    } else if (keep && a.started) {
      this.store.add(a.page.fileId, a.page.num, { id: newStrokeId(), at: Date.now(), ...a.look, pts: simplify(a.pts, SIMPLIFY) });
    }
    this.viewer.refresh(); // pages wait to be drawn while a stroke is
    this.dispatchEvent(new Event('inkend'));
  }

  // The viewer is about to lay the pages out again (rotation, zoom).
  commit() {
    this.#endStroke(true);
  }
}

function night() {
  return !!getSettings().nightMode;
}

function avgY(touches) {
  let y = 0;
  for (const t of touches) y += t.clientY;
  return y / touches.length;
}
