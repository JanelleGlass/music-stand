// A page turning like a book's, one page at a time.
//
// It's drawn over the music with copies of the pages. The viewer has already
// moved to the new page underneath, so when the turn ends (or is cut short)
// the copies just go and the real page is there.
//
// Forward, the page that was showing lifts from the right and turns over to
// the left, uncovering the next page. Back, the previous page turns back from
// the left over the one that was showing.
import { leafAngle } from './paging.js';

const SHADE = 0.35; // darkest the turning page gets, edge on to the light
const DIM = 0.14; // darkest the page under it gets

function div(cls) {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

function place(el, box) {
  const s = el.style;
  s.left = box.left + 'px';
  s.top = box.top + 'px';
  s.width = box.width + 'px';
  s.height = box.height + 'px';
}

export class Flip {
  // layer: the element over the music. leaf: copy of the turning page;
  // under: copy of the page it turns over (going back). Copies are
  // { el, box: { left, top, width, height } } in the layer's coordinates.
  constructor(layer, dir, leaf, under = null) {
    this.layer = layer;
    this.dir = dir;
    this.p = 0;
    this.raf = 0;
    this.onDone = null;

    this.dim = div('flip-dim');
    this.leaf = div('flip-leaf');
    place(this.leaf, leaf.box);
    const front = leaf.el;
    front.classList.add('flip-face');
    place(front, { left: 0, top: 0, width: leaf.box.width, height: leaf.box.height });
    const back = div('flip-face flip-back');
    this.shades = [div('flip-shade'), div('flip-shade')];
    front.appendChild(this.shades[0]);
    back.appendChild(this.shades[1]);
    this.leaf.append(front, back);
    this.faces = [front, back];

    const parts = [];
    if (under) {
      place(under.el, under.box);
      parts.push(under.el);
    }
    parts.push(this.dim, this.leaf);
    layer.replaceChildren(...parts);
    layer.hidden = false;
    this.set(0);
  }

  // p: how far the page has turned, 0 to 1.
  set(p) {
    this.p = p;
    const a = leafAngle(this.dir, p);
    this.leaf.style.transform = `rotateY(${a}deg)`;
    const s = Math.sin(Math.PI * Math.max(0, Math.min(1, p)));
    for (const el of this.shades) el.style.opacity = String(SHADE * s);
    this.dim.style.opacity = String(DIM * s);
    // Lying over to the left, the page fades, so it doesn't stay over the
    // stage when the page is narrower than the screen. (The faces fade, not
    // the leaf: opacity on the leaf would flatten it and show the front
    // through the back.)
    const over = -a / 180;
    const fade = String(over > 0.8 ? Math.max(0, (1 - over) / 0.2) : 1);
    for (const el of this.faces) el.style.opacity = fade;
  }

  // Turns to progress `to` over duration ms, then calls onDone (not if
  // removed first).
  play(to, duration, easing, onDone) {
    cancelAnimationFrame(this.raf);
    this.onDone = onDone;
    const from = this.p;
    const t0 = performance.now();
    const step = (now) => {
      const t = duration > 0 ? Math.min(1, (now - t0) / duration) : 1;
      this.set(from + (to - from) * easing(t));
      if (t < 1) {
        this.raf = requestAnimationFrame(step);
      } else {
        const done = this.onDone;
        this.onDone = null;
        if (done) done();
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  remove() {
    cancelAnimationFrame(this.raf);
    this.onDone = null;
    // Shrinking a canvas is what releases its memory on iOS.
    for (const c of this.layer.querySelectorAll('canvas')) {
      c.width = 0;
      c.height = 0;
    }
    this.layer.replaceChildren();
    this.layer.hidden = true;
  }
}
