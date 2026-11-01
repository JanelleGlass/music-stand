// Vertical PDF viewer: continuous scrolling, or one page at a time.
//
// A document is a list of segments ({ fileId, from, to }), so the same viewer
// can later show a page range of a hymnal or a setlist that spans files.
// Pages are laid out up front from stored page sizes; only pages near the
// screen get a canvas, because iOS limits total canvas memory.
//
// One page at a time ("paged") keeps the same vertical strip, but every page
// gets a slot one screen tall and is sized to fit in it (js/paging.js). The
// music can't be scrolled freely then: a turn moves one slot, and a finger
// drag follows the music and settles on a page when it lets go.
import { openPdf, isCancel } from './pdfdoc.js';
import { getFile, getFileBlob, getPosition, savePosition, getSettings } from './data.js';
import { Ink } from './ink.js';
import { fitPage, pageAt, settlePage, sideSwipe } from './paging.js';

const GAP = 10;                 // px between pages
const PAD = 8;                  // px above the first and below the last page
const MAX_DPR = 2;
const MAX_PIXELS = 10_000_000;  // per canvas
const MAX_RENDERED = 7;
const DRAG_START_PX = 10;       // one page at a time: a touch that moves this far is a swipe, not a tap
const VELOCITY_MS = 100;        // a let-go's speed is measured over this last stretch of the drag
export const ZOOMS = [0.5, 0.6, 0.7, 0.8, 0.9, 1];

function freeCanvas(c) {
  // Shrinking a canvas is what actually releases its memory on iOS.
  c.width = 0;
  c.height = 0;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Viewer extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.scroller = root.querySelector('.scroller');
    this.pagesEl = root.querySelector('.pages');
    this.guide = root.querySelector('.guide');
    this.pages = [];
    this.docs = new Map();
    this.want = [];
    this.anim = null;
    this.zoom = 1;
    this.openGen = 0;
    this.layoutGen = 0;
    this.layoutWidth = 0;
    this.layoutHeight = 0;
    this.paged = false; // one page at a time
    this.slot = 0; // px per page slot when paged
    this.drag = null; // the music being moved by hand
    this.wheel = { acc: 0, locked: false, timer: 0 };
    this.busy = false;
    this.currentIndex = -1;
    this.lastUserScrollAt = 0;
    this.scrollRaf = 0;
    this.saveTimer = 0;
    this.guideTimer = 0;
    this.ink = new Ink(this);

    this.scroller.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    // Dragging the page takes over from a running page-turn animation (the
    // Pencil writes instead). One page at a time, a swipe does that itself.
    this.scroller.addEventListener('touchmove', (e) => {
      if (this.paged) return;
      if (!(this.ink.pencilWrites && [...e.touches].some((t) => t.touchType === 'stylus'))) this.cancelAnimation();
    }, { passive: true });
    this.scroller.addEventListener('wheel', (e) => this.#onWheel(e), { passive: true });
    new ResizeObserver(() => this.#onResize()).observe(this.scroller);
    this.#setupPointer();
  }

  get isOpen() {
    return this.pages.length > 0;
  }

  async open({ key, segments }) {
    this.close();
    const gen = ++this.openGen;
    const pages = [];
    for (const seg of segments) {
      const meta = await getFile(seg.fileId);
      if (!meta) throw new Error('This file is no longer in the library.');
      const from = Math.max(1, seg.from || 1);
      const to = Math.min(meta.pageCount, seg.to || meta.pageCount);
      for (let n = from; n <= to; n++) {
        const size = (meta.pageSizes && (meta.pageSizes[n - 1] || meta.pageSizes[0])) || [612, 792];
        pages.push({ fileId: seg.fileId, num: n, w: size[0], h: size[1], top: 0, slot: 0, cssW: 0, cssH: 0, el: null, canvas: null, ink: null, task: null, renderedGen: -1, failed: false });
      }
    }
    const pos = await getPosition(key);
    if (gen !== this.openGen) return;
    await this.ink.open(pages);
    if (gen !== this.openGen) return;

    this.key = key;
    this.pages = pages;
    this.zoom = pos && pos.zoom ? pos.zoom : 1;
    const frag = document.createDocumentFragment();
    pages.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.index = i;
      el.innerHTML = `<span class="pnum">${p.num}</span>`;
      p.el = el;
      frag.appendChild(el);
    });
    this.pagesEl.appendChild(frag);
    this.#layout();
    if (pos) this.#restore(pos.page, pos.frac);
    else this.scroller.scrollTop = 0;
    this.#updateVisible();
  }

  // Switches between one page at a time (true) and scrolling, staying on the
  // page that's showing.
  setPaged(on) {
    on = !!on;
    if (on === this.paged) return;
    this.ink.commit();
    this.finishAnimation();
    this.drag = null;
    const idx = this.currentIndex;
    this.paged = on;
    this.root.classList.toggle('paged', on);
    this.guide.classList.remove('show');
    if (!this.pages.length) return;
    this.#layout();
    this.goToIndex(Math.max(0, idx));
    this.#updateVisible();
    this.#savePositionSoon();
  }

  close() {
    this.#savePositionNow();
    this.cancelAnimation();
    this.ink.close();
    this.openGen++;
    for (const p of this.pages) this.#release(p);
    this.pages = [];
    this.want = [];
    this.drag = null;
    this.currentIndex = -1;
    this.pagesEl.querySelectorAll('.page').forEach((el) => el.remove());
    for (const d of this.docs.values()) d.then((doc) => doc.destroy()).catch(() => {});
    this.docs.clear();
    this.busy = false;
  }

  // ---- Page turning ----

  // dir: +1 forward, -1 back. Returns false at the start/end of the music.
  turn(dir) {
    if (!this.pages.length) return false;
    const s = getSettings();
    if (this.paged) {
      this.drag = null;
      const from = this.anim ? this.anim.to : this.scroller.scrollTop;
      const next = pageAt(from, this.slot, this.pages.length) + dir;
      if (next < 0 || next >= this.pages.length) {
        this.dispatchEvent(new CustomEvent('edge', { detail: { dir } }));
        return false;
      }
      this.#animateTo(next * this.slot, s.scrollDuration);
      return true;
    }
    const vh = this.scroller.clientHeight;
    const max = this.scroller.scrollHeight - vh;
    const from = this.anim ? this.anim.to : this.scroller.scrollTop;
    const to = Math.max(0, Math.min(max, from + dir * Math.round((vh * s.scrollAmount) / 100)));
    if (Math.abs(to - from) < 2) {
      this.dispatchEvent(new CustomEvent('edge', { detail: { dir } }));
      return false;
    }
    if (s.readingGuide) this.#showGuide(dir > 0 ? from + vh : from);
    this.#animateTo(to, s.scrollDuration);
    return true;
  }

  goToIndex(index) {
    const p = this.pages[Math.max(0, Math.min(this.pages.length - 1, index))];
    if (!p) return;
    this.cancelAnimation();
    this.scroller.scrollTop = this.paged ? p.slot : Math.max(0, p.top - PAD);
  }

  cancelAnimation() {
    if (!this.anim) return;
    cancelAnimationFrame(this.anim.raf);
    this.anim = null;
    this.#afterAnimation();
  }

  // Jumps to where a running page turn was going.
  finishAnimation() {
    if (!this.anim) return;
    const to = this.anim.to;
    cancelAnimationFrame(this.anim.raf);
    this.anim = null;
    this.scroller.scrollTop = to;
    this.#afterAnimation();
  }

  // The page in the middle of the screen.
  indexAtCenter() {
    return this.#indexAt(this.scroller.scrollTop + this.scroller.clientHeight / 2);
  }

  // Whether some of page index is on the screen.
  isOnScreen(index) {
    const p = this.pages[index];
    if (!p) return false;
    const top = this.scroller.scrollTop;
    return p.top + p.cssH > top && p.top < top + this.scroller.clientHeight;
  }

  // Draws what is waiting to be drawn (after a stroke, which holds it up).
  refresh() {
    this.#updateVisible();
  }

  #animateTo(to, duration) {
    if (this.anim) cancelAnimationFrame(this.anim.raf);
    if (!duration) {
      this.anim = null;
      this.scroller.scrollTop = to;
      this.#afterAnimation();
      return;
    }
    const start = this.scroller.scrollTop;
    const t0 = performance.now();
    const anim = { to, raf: 0 };
    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      this.scroller.scrollTop = start + (to - start) * ease(t);
      if (t < 1) anim.raf = requestAnimationFrame(step);
      else if (this.anim === anim) {
        this.anim = null;
        this.#afterAnimation();
      }
    };
    const wasAnimating = !!this.anim;
    this.anim = anim;
    if (!wasAnimating) this.dispatchEvent(new Event('animstart'));
    anim.raf = requestAnimationFrame(step);
  }

  // ---- Moving the music by hand ----
  //
  // Used for a swipe one page at a time, and for the two-finger scroll while a
  // finger writes (js/ink.js). Scrolling, the music just follows; one page at
  // a time it can go as far as the next or previous page, and settles on a
  // page when the fingers let go.

  dragStart(y) {
    this.cancelAnimation();
    const top = this.scroller.scrollTop;
    this.drag = { top0: top, lastY: y, base: pageAt(top, this.slot, this.pages.length), samples: [{ y, t: performance.now() }] };
  }

  dragMove(y) {
    const d = this.drag;
    if (!d) return;
    const dy = y - d.lastY;
    d.lastY = y;
    const now = performance.now();
    d.samples.push({ y, t: now });
    while (d.samples.length > 2 && now - d.samples[0].t > VELOCITY_MS) d.samples.shift();
    if (!this.paged) {
      this.scroller.scrollTop -= dy;
      return;
    }
    const lo = Math.max(0, (d.base - 1) * this.slot);
    const hi = Math.min((this.pages.length - 1) * this.slot, (d.base + 1) * this.slot);
    this.scroller.scrollTop = Math.max(lo, Math.min(hi, this.scroller.scrollTop - dy));
  }

  dragEnd() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (!this.paged) return;
    const now = performance.now();
    const recent = d.samples.filter((s) => now - s.t <= VELOCITY_MS);
    let velocity = 0;
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      if (b.t > a.t) velocity = -(b.y - a.y) / (b.t - a.t); // finger up = music forward
    }
    const target = settlePage({ base: d.base, count: this.pages.length, moved: this.scroller.scrollTop - d.top0, slot: this.slot, velocity });
    const to = target * this.slot;
    const dist = Math.abs(to - this.scroller.scrollTop);
    // Already moving with the finger, so it glides the rest of the way (also
    // when page turns jump).
    this.#animateTo(to, dist < 1 ? 0 : Math.round(Math.min(320, 140 + (180 * dist) / this.slot)));
  }

  // A mouse wheel or trackpad, one page at a time: one page per push, however
  // long the trackpad keeps gliding.
  #onWheel(e) {
    if (!this.paged) {
      this.cancelAnimation();
      return;
    }
    if (e.ctrlKey || !this.pages.length) return; // pinch
    const w = this.wheel;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.acc = 0;
      w.locked = false;
    }, 200);
    if (w.locked) return;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.slot : 1;
    w.acc += (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * k;
    if (Math.abs(w.acc) >= 40) {
      w.locked = true;
      this.dispatchEvent(new CustomEvent('swipe', { detail: { dir: Math.sign(w.acc) } }));
    }
  }

  #afterAnimation() {
    this.dispatchEvent(new Event('animend'));
    this.#updateVisible();
  }

  get animating() {
    return !!this.anim;
  }

  #showGuide(contentY) {
    const g = this.guide;
    g.style.top = Math.round(contentY) + 'px';
    g.classList.remove('show');
    void g.offsetWidth; // restart the CSS transition
    g.classList.add('show');
    clearTimeout(this.guideTimer);
    this.guideTimer = setTimeout(() => g.classList.remove('show'), 1600);
  }

  // ---- Zoom ----

  // Zoom is for scrolling; one page at a time, pages fit the screen.
  setZoom(z) {
    if (!this.pages.length || z === this.zoom || this.paged) return;
    this.ink.commit();
    const [idx, frac] = this.#topPosition();
    this.zoom = z;
    this.#layout();
    this.#restore(idx, frac);
    this.#updateVisible();
    this.#savePositionSoon();
    this.dispatchEvent(new Event('zoom'));
  }

  zoomStep(dir) {
    let i = ZOOMS.findIndex((z) => z >= this.zoom - 0.001);
    if (i < 0) i = ZOOMS.length - 1;
    i = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
    this.setZoom(ZOOMS[i]);
  }

  // ---- Layout ----

  // Each page gets p.top (where it's drawn) and p.slot (where its share of the
  // strip starts: the same when scrolling, the top of its screen when paged).
  #layout() {
    const W = this.scroller.clientWidth;
    const H = this.scroller.clientHeight;
    if (!W || (this.paged && !H)) return;
    this.layoutWidth = W;
    this.layoutHeight = H;
    if (this.paged) {
      this.slot = H;
      this.pages.forEach((p, i) => {
        const { cssW, cssH } = fitPage(p.w, p.h, W, H - 2 * PAD);
        p.cssW = cssW;
        p.cssH = cssH;
        p.slot = i * H;
        p.top = p.slot + Math.round((H - cssH) / 2);
        this.#place(p, Math.round((W - cssW) / 2));
      });
      this.pagesEl.style.height = this.pages.length * H + 'px';
    } else {
      const pageW = Math.round(W * Math.min(1, this.zoom));
      const left = Math.round((W - pageW) / 2);
      let y = PAD;
      for (const p of this.pages) {
        p.cssW = pageW;
        p.cssH = Math.round((pageW * p.h) / p.w);
        p.top = p.slot = y;
        this.#place(p, left);
        y += p.cssH + GAP;
      }
      this.pagesEl.style.height = y - GAP + PAD + 'px';
    }
    this.layoutGen++;
  }

  #place(p, left) {
    const s = p.el.style;
    s.top = p.top + 'px';
    s.left = left + 'px';
    s.width = p.cssW + 'px';
    s.height = p.cssH + 'px';
  }

  #indexAt(y) {
    const pages = this.pages;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pages[mid].slot <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  #topPosition() {
    const y = this.scroller.scrollTop;
    if (this.paged) return [pageAt(y, this.slot, this.pages.length), 0];
    const idx = this.#indexAt(y);
    const p = this.pages[idx];
    return [idx, p ? (y - p.top) / p.cssH : 0];
  }

  #restore(idx, frac) {
    const p = this.pages[Math.max(0, Math.min(this.pages.length - 1, idx | 0))];
    if (!p) return;
    this.scroller.scrollTop = this.paged ? p.slot : Math.round(p.top + (frac || 0) * p.cssH);
  }

  #onResize() {
    if (!this.pages.length) return;
    // One page at a time, the pages also fit the screen's height.
    if (this.scroller.clientWidth !== this.layoutWidth || (this.paged && this.scroller.clientHeight !== this.layoutHeight)) {
      this.ink.commit();
      const [idx, frac] = this.#topPosition();
      this.cancelAnimation();
      this.#layout();
      this.#restore(idx, frac);
    }
    this.#updateVisible();
  }

  #onScroll() {
    if (!this.anim) this.lastUserScrollAt = performance.now();
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.#updateVisible();
      this.#savePositionSoon();
    });
  }

  // ---- Rendering ----

  #updateVisible() {
    if (!this.pages.length) return;
    const top = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight;
    const keepFrom = top - vh * 1.5;
    const keepTo = top + vh * 3.5;
    const wantFrom = top - vh * 0.5;
    const wantTo = top + vh * 2.2;

    const visible = [];
    const ahead = [];
    const behind = [];
    const first = this.#indexAt(Math.max(0, keepFrom));
    for (let i = first; i < this.pages.length; i++) {
      const p = this.pages[i];
      if (p.top > keepTo) break;
      const bottom = p.top + p.cssH;
      if (bottom < wantFrom || p.top > wantTo) continue;
      if (bottom >= top && p.top <= top + vh) visible.push(p);
      else if (p.top > top) ahead.push(p);
      else behind.push(p);
    }
    this.want = [...visible, ...ahead, ...behind.reverse()];
    this.keepFrom = keepFrom;
    this.keepTo = keepTo;

    for (const p of this.pages) {
      const keep = this.#inKeep(p);
      if ((p.canvas || p.task) && !keep) this.#release(p);
      if (keep) this.ink.show(p);
      else if (p.ink) this.ink.hide(p);
    }

    const cur = this.paged ? pageAt(top, this.slot, this.pages.length) : this.#indexAt(top + vh * 0.33);
    if (cur !== this.currentIndex) {
      this.currentIndex = cur;
      const p = this.pages[cur];
      this.dispatchEvent(new CustomEvent('page', { detail: { index: cur, count: this.pages.length, num: p.num, fileId: p.fileId } }));
    }
    this.#pump();
  }

  #inKeep(p) {
    return p.top + p.cssH >= this.keepFrom && p.top <= this.keepTo;
  }

  async #pump() {
    // Don't start new renders mid-animation or mid-stroke; the look-ahead
    // pages are usually ready.
    if (this.busy || this.anim || this.ink.drawing) return;
    const next = this.want.find((p) => p.renderedGen !== this.layoutGen && !p.failed);
    if (!next) return;
    this.busy = true;
    const gen = this.openGen;
    try {
      await this.#render(next);
    } catch (e) {
      if (!isCancel(e) && gen === this.openGen) {
        console.warn('Render failed', e);
        next.failed = true;
        next.el.classList.add('failed');
        this.dispatchEvent(new CustomEvent('error', { detail: e }));
      }
    } finally {
      if (gen === this.openGen) this.busy = false;
    }
    if (gen === this.openGen) this.#pump();
  }

  #doc(fileId) {
    let d = this.docs.get(fileId);
    if (!d) {
      d = (async () => {
        const blob = await getFileBlob(fileId);
        if (!blob) throw new Error('The PDF data for this file is missing.');
        return openPdf(await blob.arrayBuffer());
      })();
      d.catch(() => this.docs.delete(fileId));
      this.docs.set(fileId, d);
    }
    return d;
  }

  async #render(p) {
    const gen = this.openGen;
    const layoutGen = this.layoutGen;
    const doc = await this.#doc(p.fileId);
    if (gen !== this.openGen) return;
    const page = await doc.getPage(p.num);
    if (gen !== this.openGen) return;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    let scale = (p.cssW / p.w) * dpr;
    const px = p.w * scale * (p.h * scale);
    if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
    const vp = page.getViewport({ scale });

    const c = document.createElement('canvas');
    c.className = 'pdf';
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    try {
      p.task = page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp });
      await p.task.promise;
    } catch (e) {
      freeCanvas(c);
      throw e;
    } finally {
      p.task = null;
    }
    page.cleanup();
    if (gen !== this.openGen || !this.#inKeep(p)) {
      freeCanvas(c);
      return;
    }
    if (p.canvas) {
      p.el.replaceChild(c, p.canvas);
      freeCanvas(p.canvas);
    } else {
      p.el.appendChild(c);
    }
    p.canvas = c;
    p.renderedGen = layoutGen; // if layout changed meanwhile, it gets re-rendered
    p.el.classList.add('ready');
    this.#enforceLimit();
  }

  #release(p) {
    if (p.task) {
      p.task.cancel();
      p.task = null;
    }
    if (p.canvas) {
      freeCanvas(p.canvas);
      p.canvas.remove();
      p.canvas = null;
    }
    p.renderedGen = -1;
    p.el && p.el.classList.remove('ready');
  }

  #enforceLimit() {
    const rendered = this.pages.filter((p) => p.canvas);
    if (rendered.length <= MAX_RENDERED) return;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    rendered.sort((a, b) => Math.abs(b.top + b.cssH / 2 - mid) - Math.abs(a.top + a.cssH / 2 - mid));
    for (const p of rendered.slice(0, rendered.length - MAX_RENDERED)) this.#release(p);
  }

  // ---- Taps and swipes ----

  // Taps, and one page at a time also swipes: up and down the music follows
  // the finger; sideways it turns like a book. (Scrolling, the browser
  // scrolls.)
  #setupPointer() {
    const sc = this.scroller;
    let g = null; // the touch being followed
    sc.addEventListener('pointerdown', (e) => {
      // The Pencil writes notes, and so does a finger while the notes toolbar
      // says so; a hand resting while the Pencil writes doesn't move the music.
      if (!e.isPrimary || (e.pointerType === 'pen' && this.ink.pencilWrites) || this.ink.takesFingers || (e.pointerType === 'mouse' && this.ink.toolbarOpen) || this.ink.penDown) {
        g = null;
        return;
      }
      // A touch that just stops a flick isn't a tap.
      g = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), tap: performance.now() - this.lastUserScrollAt >= 120, axis: null };
    });
    sc.addEventListener('pointermove', (e) => {
      if (!g || g.id !== e.pointerId || !this.paged) return;
      if (this.ink.busy || this.ink.penDown) {
        if (g.axis === 'y') this.dragEnd();
        g = null;
        return;
      }
      if (!g.axis) {
        const dx = e.clientX - g.x;
        const dy = e.clientY - g.y;
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        g.tap = false;
        try { sc.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        if (g.axis === 'y') this.dragStart(e.clientY);
        return;
      }
      if (g.axis === 'y') this.dragMove(e.clientY);
    });
    sc.addEventListener('pointerup', (e) => {
      const t = g;
      g = null;
      if (!t || t.id !== e.pointerId) return;
      if (t.axis === 'y') {
        this.dragEnd();
        return;
      }
      if (t.axis === 'x') {
        const dir = this.paged ? sideSwipe(e.clientX - t.x) : 0;
        if (dir) this.dispatchEvent(new CustomEvent('swipe', { detail: { dir } }));
        return;
      }
      if (!t.tap || performance.now() - t.t > 400 || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) return;
      const r = sc.getBoundingClientRect();
      this.dispatchEvent(new CustomEvent('tap', { detail: { fy: (e.clientY - r.top) / r.height } }));
    });
    sc.addEventListener('pointercancel', (e) => {
      if (g && g.id === e.pointerId && g.axis === 'y') this.dragEnd();
      g = null;
    });
  }

  // ---- Position ----

  #savePositionSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.#savePositionNow(), 600);
  }

  #savePositionNow() {
    clearTimeout(this.saveTimer);
    if (!this.pages.length || !this.key) return;
    const [page, frac] = this.#topPosition();
    savePosition({ id: this.key, page, frac: Math.round(frac * 10000) / 10000, zoom: this.zoom }).catch(() => {});
  }

  flushPosition() {
    this.#savePositionNow();
    this.ink.flush();
  }
}
