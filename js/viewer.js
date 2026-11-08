// Vertical PDF viewer: continuous scrolling, or one page at a time.
//
// A document is a list of segments ({ fileId, from, to }), so the same viewer
// can later show a page range of a hymnal or a setlist that spans files.
// Pages are laid out up front from stored page sizes; only pages near the
// screen get a canvas, because iOS limits total canvas memory.
//
// One page at a time ("paged") keeps the same vertical strip, but every page
// gets a slot one screen tall and is sized to fit in it (js/paging.js). The
// music can't be scrolled freely then: a turn jumps one slot, and copies of
// the pages turn over it like a book's (js/flip.js). A sideways drag turns
// the page under the finger.
import { openPdf, isCancel } from './pdfdoc.js';
import { getFile, getFileBlob, getPosition, savePosition, getSettings, libraryEdited, checkDamaged } from './data.js';
import { Ink } from './ink.js';
import { Marks } from './marks.js';
import { fitPage, pageAt, swipeTurn, flipProgress, flipCompletes } from './paging.js';
import { Flip } from './flip.js';
import { fractionOf, scrollFor } from './scrub.js';
import { shownBox, pageToShown, isPlain, normView, turnAbout } from './page-view.js';
import { loadViews } from './views-store.js';
import { placeLayer } from './ink-draw.js';

const GAP = 10;                 // px between pages
const PAD = 8;                  // px above the first and below the last page
const MAX_DPR = 2;
const MAX_PIXELS = 10_000_000;  // per canvas
const MAX_RENDERED = 7;
const DRAG_START_PX = 10;       // one page at a time: a touch that moves this far is a swipe, not a tap
const VELOCITY_MS = 100;        // a let-go's speed is measured over this last stretch of the drag
const FLIP_REST_MS = 450;       // a page let go mid-turn takes up to this long to finish (or fall back)
export const ZOOMS = [0.5, 0.6, 0.7, 0.8, 0.9, 1];

function freeCanvas(c) {
  // Shrinking a canvas is what actually releases its memory on iOS.
  c.width = 0;
  c.height = 0;
}

// Sets how page p is shown (null: as it is in the PDF).
function applyView(p, view) {
  const v = normView(view);
  p.view = isPlain(v) ? null : v;
  const box = shownBox(p.view, p.pw, p.ph);
  p.w = box.w;
  p.h = box.h;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export class Viewer extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.scroller = root.querySelector('.scroller');
    this.pagesEl = root.querySelector('.pages');
    this.guide = root.querySelector('.guide');
    this.flipLayer = root.querySelector('.flip');
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
    this.drag = null; // two fingers moving the music (js/ink.js)
    this.queued = 0; // page turns waiting for the page turning now
    this.wheel = { acc: 0, locked: false, timer: 0 };
    this.busy = false;
    this.currentIndex = -1;
    this.lastUserScrollAt = 0;
    this.scrollRaf = 0;
    this.saveTimer = 0;
    this.guideTimer = 0;
    this.ink = new Ink(this);
    this.marks = new Marks(this);
    this.inputBlocked = false; // tap areas are being drawn (js/index-ui.js)

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
        // pw × ph: the page in the PDF; w × h: the part shown, turned (js/page-view.js).
        pages.push({ fileId: seg.fileId, num: n, pw: size[0], ph: size[1], w: size[0], h: size[1], view: null, inkBox: null, top: 0, slot: 0, cssW: 0, cssH: 0, el: null, canvas: null, ink: null, links: null, task: null, renderedGen: -1, failed: false });
      }
    }
    const pos = await getPosition(key);
    const views = await loadViews(segments.map((s) => s.fileId));
    if (gen !== this.openGen) return;
    for (const p of pages) applyView(p, views.get(`${p.fileId}:${p.num}`));
    await this.ink.open(pages);
    await this.marks.open(pages);
    if (gen !== this.openGen) return;

    this.key = key;
    this.pages = pages;
    this.zoom = pos && pos.zoom ? pos.zoom : 1;
    this.zoomAt = (pos && pos.zoomAt) || 0; // when the zoom was set (synced: js/sync-data.js)
    this.savedZoomAt = this.zoomAt;
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
    this.dispatchEvent(new Event('opened'));
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

  // Page adjustments changed: views is Map index → view. The music stays on
  // the page that's showing.
  setViews(views) {
    if (!this.pages.length || !views.size) return;
    this.ink.commit();
    this.finishAnimation();
    const idx = Math.max(0, this.currentIndex);
    for (const [i, v] of views) {
      const p = this.pages[i];
      if (!p) continue;
      applyView(p, v);
      this.#release(p); // drawn the old way
      p.failed = false;
      p.el.classList.remove('failed');
    }
    this.#layout();
    this.goToIndex(idx);
    this.#updateVisible();
  }

  // The whole of page index, turned rot (and straightened tilt degrees),
  // drawn to fit maxW × maxH CSS px (for adjusting it). Resolves to a canvas
  // whose pixels are scale × that.
  async paperImage(index, rot, maxW, maxH, scale = 1, tilt = 0) {
    const p = this.pages[index];
    const doc = await this.#doc(p.fileId);
    const page = await doc.getPage(p.num);
    const turned = rot % 180 ? [p.ph, p.pw] : [p.pw, p.ph];
    const k = Math.min(maxW / turned[0], maxH / turned[1]) * scale;
    const vp = page.getViewport({ scale: k, rotation: (page.rotate + rot) % 360 });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(vp.width));
    c.height = Math.max(1, Math.floor(vp.height));
    const ctx = c.getContext('2d', { alpha: false, willReadFrequently: scale < 1 });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    const transform = tilt ? turnAbout(tilt, c.width / 2, c.height / 2) : null;
    await page.render({ canvasContext: ctx, viewport: vp, transform }).promise;
    page.cleanup();
    return c;
  }

  close() {
    this.#savePositionNow();
    this.cancelAnimation();
    this.ink.close();
    this.marks.close();
    this.openGen++;
    for (const p of this.pages) {
      this.#release(p);
      this.marks.hide(p);
    }
    this.pages = [];
    this.want = [];
    this.drag = null;
    this.currentIndex = -1;
    this.pagesEl.querySelectorAll('.page').forEach((el) => el.remove());
    for (const d of this.docs.values()) d.then((doc) => doc.destroy()).catch(() => {});
    this.docs.clear();
    this.busy = false;
    this.drewSome = false;
  }

  // ---- Page turning ----

  // dir: +1 forward, -1 back. Returns false at the start/end of the music.
  turn(dir) {
    if (!this.pages.length) return false;
    const s = getSettings();
    if (this.paged) {
      // Turns that come while a page is turning wait for it, so two quick
      // winks turn two pages one after the other.
      const a = this.anim;
      const waits = !!(a && a.flip && !a.held);
      const at = waits ? pageAt(a.to, this.slot, this.pages.length) + this.queued : pageAt(this.scroller.scrollTop, this.slot, this.pages.length);
      if (at + dir < 0 || at + dir >= this.pages.length) {
        this.dispatchEvent(new CustomEvent('edge', { detail: { dir } }));
        return false;
      }
      if (waits) this.queued += dir;
      else this.#flipTurn(dir, s.scrollDuration);
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
    this.goTo(index, 0);
  }

  // Goes to y (0 to 1) of the way down page index; one page at a time, to
  // the page.
  goTo(index, y = 0) {
    if (!this.pages.length) return;
    this.cancelAnimation();
    this.scroller.scrollTop = this.#scrollFor(index, y);
  }

  #scrollFor(index, y) {
    const p = this.pages[Math.max(0, Math.min(this.pages.length - 1, index))];
    if (!p) return 0;
    if (this.paged) return p.slot;
    const max = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
    return Math.max(0, Math.min(max, Math.round(p.top + (y || 0) * p.cssH - PAD)));
  }

  // Where the scroll bar is (0 to 1) when page index shows from y down.
  fractionAt(index, y = 0) {
    const sc = this.scroller;
    return fractionOf(this.#scrollFor(index, y), sc.scrollHeight - sc.clientHeight);
  }

  // The page at the top of the screen, and how far down it the screen starts
  // (0 to 1; 0 one page at a time).
  // Measured below the margin goTo leaves, so going to a place and asking
  // where the screen is gives the same place back.
  topPlace() {
    if (!this.pages.length) return [0, 0];
    if (this.paged) return [this.#topPosition()[0], 0];
    const y = this.scroller.scrollTop + PAD;
    const index = this.#indexAt(y);
    const p = this.pages[index];
    // In the gap below a page: the next one starts the screen.
    if (y >= p.top + p.cssH - 1 && index < this.pages.length - 1) return [index + 1, 0];
    const frac = (y - p.top) / p.cssH;
    return [index, frac < 0.005 ? 0 : Math.max(0, Math.min(1, frac))];
  }

  // Stops a running page turn where it is (a page turning like a book's
  // lands on its page).
  cancelAnimation() {
    this.#stopAnimation(false);
  }

  // Jumps to where a running page turn was going.
  finishAnimation() {
    this.#stopAnimation(true);
  }

  #stopAnimation(finish) {
    const a = this.anim;
    this.queued = 0;
    if (!a) return;
    this.anim = null;
    cancelAnimationFrame(a.raf);
    if (a.flip) a.flip.remove();
    if (finish || a.flip) this.scroller.scrollTop = a.to;
    this.#afterAnimation();
  }

  // The page in the middle of the screen.
  indexAtCenter() {
    return this.#indexAt(this.scroller.scrollTop + this.scroller.clientHeight / 2);
  }

  // How far through the music the screen is, 0 to 1 (the scroll bar).
  get fraction() {
    const sc = this.scroller;
    return fractionOf(sc.scrollTop, sc.scrollHeight - sc.clientHeight);
  }

  // Jumps to fraction f of the way through the music (the scroll bar). One
  // page at a time, it lands on a page.
  jumpTo(f) {
    if (!this.pages.length) return;
    this.finishAnimation();
    const sc = this.scroller;
    sc.scrollTop = scrollFor(f, sc.scrollHeight - sc.clientHeight, this.paged ? this.slot : 0);
  }

  // The page being read: the one showing one page at a time; scrolling, the
  // one a third of the way down the screen.
  pageShowing() {
    if (!this.pages.length) return -1;
    const top = this.scroller.scrollTop;
    return this.paged ? pageAt(top, this.slot, this.pages.length) : this.#indexAt(top + this.scroller.clientHeight * 0.33);
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
    if (this.anim && this.anim.flip) this.#stopAnimation(true);
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

  // ---- Turning like a book (one page at a time) ----

  // Turns a page over duration ms (0 jumps).
  #flipTurn(dir, duration) {
    if (!duration) {
      this.finishAnimation();
      const next = pageAt(this.scroller.scrollTop, this.slot, this.pages.length) + dir;
      this.scroller.scrollTop = Math.max(0, Math.min(this.pages.length - 1, next)) * this.slot;
      this.#afterAnimation();
      return;
    }
    const a = this.#startFlip(dir);
    if (a) a.flip.play(1, duration, ease, () => this.#endFlip(a));
  }

  // Lays the copies over the music and moves the music to the new page
  // underneath. Null at the start or end of the music.
  #startFlip(dir) {
    this.finishAnimation();
    const from = this.scroller.scrollTop;
    const i = pageAt(from, this.slot, this.pages.length);
    const j = i + dir;
    if (j < 0 || j >= this.pages.length) return null;
    const showing = this.pages[i];
    const next = this.pages[j];
    const flip = dir > 0
      ? new Flip(this.flipLayer, dir, this.#copy(showing, from))
      : new Flip(this.flipLayer, dir, this.#copy(next, next.slot), this.#copy(showing, from));
    const a = { to: j * this.slot, from, flip, raf: 0, held: false, width: (dir > 0 ? showing : next).cssW };
    this.anim = a;
    this.dispatchEvent(new Event('animstart'));
    this.scroller.scrollTop = a.to;
    return a;
  }

  #endFlip(a) {
    if (this.anim !== a) return;
    this.anim = null;
    a.flip.remove();
    this.scroller.scrollTop = a.to; // a page let go falls back to where it was
    const q = this.queued;
    this.queued = 0;
    this.#afterAnimation();
    if (!q) return;
    // The turns that waited, one after another.
    const dir = Math.sign(q);
    const duration = getSettings().scrollDuration;
    if (!duration) {
      for (let k = 0; k < Math.abs(q); k++) this.#flipTurn(dir, 0);
      return;
    }
    this.#flipTurn(dir, duration);
    if (this.anim) this.queued = q - dir;
  }

  // A copy of page p as it is now, where it shows when the music is
  // scrolled to scrollTop.
  #copy(p, scrollTop) {
    const el = p.el.cloneNode(true);
    el.removeAttribute('data-index');
    const c = el.querySelector('canvas.pdf');
    if (c && p.canvas) c.getContext('2d', { alpha: false }).drawImage(p.canvas, 0, 0);
    return { el, box: { left: parseFloat(p.el.style.left) || 0, top: p.top - scrollTop, width: p.cssW, height: p.cssH } };
  }

  // ---- Moving the music by hand ----
  //
  // The two-finger scroll while a finger writes (js/ink.js). Scrolling, the
  // music follows the fingers; one page at a time, a swipe up or down turns
  // a page when they let go.

  dragStart(y) {
    if (!this.paged) this.cancelAnimation();
    this.drag = { y0: y, lastY: y };
  }

  dragMove(y) {
    const d = this.drag;
    if (!d) return;
    if (!this.paged) this.scroller.scrollTop -= y - d.lastY;
    d.lastY = y;
  }

  dragEnd() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const dir = this.paged ? swipeTurn(d.lastY - d.y0) : 0;
    if (dir) this.dispatchEvent(new CustomEvent('swipe', { detail: { dir } }));
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
    this.zoomAt = Date.now();
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
    this.dispatchEvent(new Event('layout'));
  }

  #place(p, left) {
    const s = p.el.style;
    s.top = p.top + 'px';
    s.left = left + 'px';
    s.width = p.cssW + 'px';
    s.height = p.cssH + 'px';
    // Markings are drawn on the whole page, cropped and turned as the page is.
    const k = p.cssW / p.w;
    if (p.view) {
      const m = pageToShown(p.view, p.pw, p.ph);
      p.inkBox = { width: p.pw * k, height: p.ph * k, transform: `matrix(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${m[4] * k}, ${m[5] * k})` };
    } else {
      p.inkBox = { width: p.cssW, height: p.cssH, transform: '' };
    }
    for (const svg of p.el.querySelectorAll('svg.ink')) placeLayer(svg, p);
    this.marks.place(p);
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
      if (keep) {
        this.ink.show(p);
        this.marks.show(p);
      } else {
        if (p.ink) this.ink.hide(p);
        if (p.links) this.marks.hide(p);
      }
    }

    const cur = this.pageShowing();
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
      // The score opened without trouble (js/app.js stops watching for a crash).
      if (gen === this.openGen && !this.drewSome) {
        this.drewSome = true;
        this.dispatchEvent(new CustomEvent('drawn'));
      }
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
        try {
          const blob = await getFileBlob(fileId);
          if (!blob) throw new Error('The PDF data for this file is missing.');
          return await openPdf(await blob.arrayBuffer());
        } catch (e) {
          // The PDF stored here may be damaged: Google Drive sync can fetch it again.
          if (await checkDamaged(fileId).catch(() => false)) this.dispatchEvent(new CustomEvent('damaged', { detail: fileId }));
          throw e;
        }
      })();
      // A PDF that wouldn't open stays failed until the score is opened
      // again: reading a big PDF for every page it tried to draw used enough
      // memory for iPadOS to close the app.
      d.catch(() => {});
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
    // Only the part shown is drawn, turned as it shows.
    const box = shownBox(p.view, p.pw, p.ph);
    const rot = p.view ? p.view.rot : 0;
    const vp = page.getViewport({ scale, rotation: (page.rotate + rot) % 360, offsetX: -box.x * scale, offsetY: -box.y * scale });

    const c = document.createElement('canvas');
    c.className = 'pdf';
    c.width = Math.max(1, Math.floor(box.w * scale));
    c.height = Math.max(1, Math.floor(box.h * scale));
    try {
      // Straightened: turned about the middle of the page, where it is drawn.
      let transform = null;
      if (p.view && p.view.tilt) {
        const flat = pageToShown({ rot, crop: p.view.crop }, p.pw, p.ph);
        const cx = (flat[0] * p.pw / 2 + flat[2] * p.ph / 2 + flat[4]) * scale;
        const cy = (flat[1] * p.pw / 2 + flat[3] * p.ph / 2 + flat[5]) * scale;
        transform = turnAbout(p.view.tilt, cx, cy);
      }
      p.task = page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp, transform });
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

  // Taps, and one page at a time also swipes: sideways the page turns under
  // the finger like a book's; up and down, a swipe turns a page. (Scrolling,
  // the browser scrolls.)
  #setupPointer() {
    const sc = this.scroller;
    let g = null; // the touch being followed
    sc.addEventListener('pointerdown', (e) => {
      // The Pencil writes notes, and so does a finger while the notes toolbar
      // says so; a hand resting while the Pencil writes doesn't move the music.
      if (!e.isPrimary || this.inputBlocked || (e.pointerType === 'pen' && this.ink.pencilWrites) || this.ink.takesFingers || (e.pointerType === 'mouse' && this.ink.toolbarOpen) || this.ink.penDown) {
        g = null;
        return;
      }
      // A touch that just stops a flick isn't a tap.
      const now = performance.now();
      g = { id: e.pointerId, x: e.clientX, y: e.clientY, t: now, tap: now - this.lastUserScrollAt >= 120, axis: null, flip: null, samples: [{ x: e.clientX, t: now }] };
    });
    sc.addEventListener('pointermove', (e) => {
      if (!g || g.id !== e.pointerId || !this.paged) return;
      if (this.ink.busy || this.ink.penDown) {
        if (g.flip) this.#letGo(g.flip, 0, true);
        g = null;
        return;
      }
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      const now = performance.now();
      g.samples.push({ x: e.clientX, t: now });
      while (g.samples.length > 2 && now - g.samples[0].t > VELOCITY_MS) g.samples.shift();
      if (!g.axis) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        g.tap = false;
        try { sc.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        if (g.axis === 'x') {
          g.flip = this.#startFlip(dx < 0 ? 1 : -1);
          if (g.flip) g.flip.held = true;
        }
      }
      if (g.flip && this.anim === g.flip) g.flip.flip.set(flipProgress(g.flip.flip.dir, dx, g.flip.width));
    });
    sc.addEventListener('pointerup', (e) => {
      const t = g;
      g = null;
      if (!t || t.id !== e.pointerId) return;
      if (t.flip) {
        const now = performance.now();
        const recent = t.samples.filter((s) => now - s.t <= VELOCITY_MS);
        let vx = 0;
        if (recent.length >= 2 && recent[recent.length - 1].t > recent[0].t) vx = (recent[recent.length - 1].x - recent[0].x) / (recent[recent.length - 1].t - recent[0].t);
        this.#letGo(t.flip, t.flip.flip.dir > 0 ? -vx : vx, false);
        return;
      }
      if (t.axis) {
        // Up or down, or sideways at the start or end of the music.
        const dir = this.paged ? swipeTurn(t.axis === 'x' ? e.clientX - t.x : e.clientY - t.y) : 0;
        if (dir) this.dispatchEvent(new CustomEvent('swipe', { detail: { dir } }));
        return;
      }
      if (!t.tap || performance.now() - t.t > 400 || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) return;
      const r = sc.getBoundingClientRect();
      this.dispatchEvent(new CustomEvent('tap', { detail: { fy: (e.clientY - r.top) / r.height, x: e.clientX, y: e.clientY } }));
    });
    sc.addEventListener('pointercancel', (e) => {
      if (g && g.id === e.pointerId && g.flip) this.#letGo(g.flip, 0, true);
      g = null;
    });
  }

  // A page turning under the finger is let go, moving at v px/ms the way it
  // turns: it finishes turning, or falls back (always, if cancelled).
  #letGo(a, v, cancelled) {
    if (this.anim !== a) return;
    a.held = false;
    const p = a.flip.p;
    const done = !cancelled && flipCompletes(p, v);
    if (!done) a.to = a.from;
    const ms = Math.round(Math.max(120, FLIP_REST_MS * (done ? 1 - p : p)));
    a.flip.play(done ? 1 : 0, ms, easeOut, () => this.#endFlip(a));
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
    const zoomChanged = this.zoomAt !== this.savedZoomAt;
    this.savedZoomAt = this.zoomAt;
    savePosition({ id: this.key, page, frac: Math.round(frac * 10000) / 10000, zoom: this.zoom, zoomAt: this.zoomAt })
      .then(() => { if (zoomChanged) libraryEdited(); }) // sync sends the new zoom on
      .catch(() => {});
  }

  flushPosition() {
    this.#savePositionNow();
    this.ink.flush();
  }
}
