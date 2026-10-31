// Continuous vertical PDF viewer.
//
// A document is a list of segments ({ fileId, from, to }), so the same viewer
// can later show a page range of a hymnal or a setlist that spans files.
// Pages are laid out up front from stored page sizes; only pages near the
// screen get a canvas, because iOS limits total canvas memory.
import { openPdf, isCancel } from './pdfdoc.js';
import { getFile, getFileBlob, getPosition, savePosition, getSettings } from './data.js';

const GAP = 10;                 // px between pages
const PAD = 8;                  // px above the first and below the last page
const MAX_DPR = 2;
const MAX_PIXELS = 10_000_000;  // per canvas
const MAX_RENDERED = 7;
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
    this.busy = false;
    this.currentIndex = -1;
    this.lastUserScrollAt = 0;
    this.scrollRaf = 0;
    this.saveTimer = 0;
    this.guideTimer = 0;

    this.scroller.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    // Dragging the page takes over from a running page-turn animation.
    this.scroller.addEventListener('touchmove', () => this.cancelAnimation(), { passive: true });
    this.scroller.addEventListener('wheel', () => this.cancelAnimation(), { passive: true });
    new ResizeObserver(() => this.#onResize()).observe(this.scroller);
    this.#setupTaps();
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
        pages.push({ fileId: seg.fileId, num: n, w: size[0], h: size[1], top: 0, cssW: 0, cssH: 0, el: null, canvas: null, task: null, renderedGen: -1, failed: false });
      }
    }
    const pos = await getPosition(key);
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

  close() {
    this.#savePositionNow();
    this.cancelAnimation();
    this.openGen++;
    for (const p of this.pages) this.#release(p);
    this.pages = [];
    this.want = [];
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
    this.scroller.scrollTop = Math.max(0, p.top - PAD);
  }

  cancelAnimation() {
    if (!this.anim) return;
    cancelAnimationFrame(this.anim.raf);
    this.anim = null;
    this.#afterAnimation();
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

  setZoom(z) {
    if (!this.pages.length || z === this.zoom) return;
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

  #layout() {
    const W = this.scroller.clientWidth;
    if (!W) return;
    this.layoutWidth = W;
    const pageW = Math.round(W * Math.min(1, this.zoom));
    const left = Math.round((W - pageW) / 2);
    let y = PAD;
    for (const p of this.pages) {
      p.cssW = pageW;
      p.cssH = Math.round((pageW * p.h) / p.w);
      p.top = y;
      const s = p.el.style;
      s.top = y + 'px';
      s.left = left + 'px';
      s.width = pageW + 'px';
      s.height = p.cssH + 'px';
      y += p.cssH + GAP;
    }
    this.pagesEl.style.height = y - GAP + PAD + 'px';
    this.layoutGen++;
  }

  #indexAt(y) {
    const pages = this.pages;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pages[mid].top <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  #topPosition() {
    const y = this.scroller.scrollTop;
    const idx = this.#indexAt(y);
    const p = this.pages[idx];
    return [idx, p ? (y - p.top) / p.cssH : 0];
  }

  #restore(idx, frac) {
    const p = this.pages[Math.max(0, Math.min(this.pages.length - 1, idx | 0))];
    if (!p) return;
    this.scroller.scrollTop = Math.round(p.top + (frac || 0) * p.cssH);
  }

  #onResize() {
    if (!this.pages.length) return;
    if (this.scroller.clientWidth !== this.layoutWidth) {
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
      if ((p.canvas || p.task) && !this.#inKeep(p)) this.#release(p);
    }

    const cur = this.#indexAt(top + vh * 0.33);
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
    // Don't start new renders mid-animation; the look-ahead pages are usually ready.
    if (this.busy || this.anim) return;
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

  // ---- Taps ----

  #setupTaps() {
    let tap = null;
    this.scroller.addEventListener('pointerdown', (e) => {
      // Pencil is reserved for annotations; ignore taps that just stop a flick.
      if (!e.isPrimary || e.pointerType === 'pen' || performance.now() - this.lastUserScrollAt < 120) {
        tap = null;
        return;
      }
      tap = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    });
    this.scroller.addEventListener('pointerup', (e) => {
      const t = tap;
      tap = null;
      if (!t || t.id !== e.pointerId) return;
      if (performance.now() - t.t > 400 || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) return;
      const r = this.scroller.getBoundingClientRect();
      this.dispatchEvent(new CustomEvent('tap', { detail: { fy: (e.clientY - r.top) / r.height } }));
    });
    this.scroller.addEventListener('pointercancel', () => { tap = null; });
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
  }
}
