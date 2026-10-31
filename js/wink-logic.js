// Wink detection from per-eye "closedness" scores (0 = open, 1 = closed),
// e.g. MediaPipe's eyeBlinkLeft / eyeBlinkRight blendshapes. No DOM here, so
// it can be unit-tested with synthetic data.
//
// A wink = one eye closed while the other stays clearly more open, held for
// holdMs. A normal blink closes both eyes, so it never qualifies. After a
// wink fires, both eyes must open again before the next one can register,
// so holding a wink doesn't repeat.
//
// Each eye's resting level is tracked and subtracted, which absorbs natural
// asymmetry and the lowered lids you get when looking down at music.

const GRACE_MS = 90;      // a dropped frame or flicker inside a hold is forgiven
const COOLDOWN_MS = 250;  // minimum gap between two winks
const BASELINE_TAU = 3000;
const BASELINE_MAX = 0.45;

export function thresholds(sensitivity) {
  const s = Math.max(1, Math.min(10, sensitivity));
  const close = 0.8 - (s - 1) * 0.055;   // 1 → 0.80 … 5 → 0.58 … 10 → 0.305
  const gap = close * 0.55;              // how much more closed than the other eye
  return { close, gap, reopen: close * 0.6 };
}

export class WinkLogic {
  constructor({ sensitivity = 5, holdMs = 200 } = {}) {
    this.configure({ sensitivity, holdMs });
    this.baseL = null;
    this.baseR = null;
    this.reset();
  }

  configure({ sensitivity, holdMs }) {
    if (sensitivity != null) this.t = thresholds(sensitivity);
    if (holdMs != null) this.holdMs = holdMs;
  }

  reset() {
    this.state = 'idle';   // idle | holding | fired | blocked
    this.eye = null;
    this.since = 0;
    this.lastOk = 0;
    this.firedAt = -Infinity;
    this.lastT = null;
  }

  noFace(t) {
    this.reset();
    this.lastT = t;
    return { event: null, progress: 0, state: this.state };
  }

  #norm(v, base) {
    return Math.max(0, Math.min(1, (v - base) / Math.max(0.35, 1 - base)));
  }

  // rawL / rawR: closedness of the person's left / right eye. t: ms.
  update(rawL, rawR, t) {
    const dt = this.lastT == null ? 33 : Math.max(0, t - this.lastT);
    this.lastT = t;
    if (this.baseL == null) {
      this.baseL = Math.min(rawL, BASELINE_MAX);
      this.baseR = Math.min(rawR, BASELINE_MAX);
    }
    const l = this.#norm(rawL, this.baseL);
    const r = this.#norm(rawR, this.baseR);
    const { close, gap, reopen } = this.t;

    const leftWink = l >= close && l - r >= gap;
    const rightWink = r >= close && r - l >= gap;
    const candidate = leftWink ? 'left' : rightWink ? 'right' : null;
    // Both eyes closed by a similar amount = a blink (a squinting open eye
    // during a real wink still leaves a clear gap, so it stays a candidate).
    const bothClosed = !candidate && l >= close && r >= close;
    const bothOpen = l < reopen && r < reopen;

    let event = null;
    switch (this.state) {
      case 'idle':
        if (candidate) {
          this.state = 'holding';
          this.eye = candidate;
          this.since = t;
          this.lastOk = t;
        }
        break;
      case 'holding':
        if (bothClosed) {
          this.state = 'blocked'; // that was a blink
        } else if (candidate === this.eye) {
          this.lastOk = t;
          if (t - this.since >= this.holdMs && t - this.firedAt >= COOLDOWN_MS) {
            event = this.eye;
            this.state = 'fired';
            this.firedAt = t;
          }
        } else if (candidate) {
          this.eye = candidate;
          this.since = t;
          this.lastOk = t;
        } else if (t - this.lastOk > GRACE_MS) {
          this.state = 'idle';
        }
        break;
      case 'fired':
      case 'blocked':
        if (bothOpen) this.state = 'idle';
        break;
    }

    // Slowly follow each eye's resting level while nothing is going on.
    if (this.state === 'idle' && rawL < BASELINE_MAX && rawR < BASELINE_MAX) {
      const a = 1 - Math.exp(-dt / BASELINE_TAU);
      this.baseL += (rawL - this.baseL) * a;
      this.baseR += (rawR - this.baseR) * a;
    }

    let progress = 0;
    if (this.state === 'holding') progress = Math.min(1, (t - this.since) / this.holdMs);
    else if (this.state === 'fired') progress = 1;
    return { event, progress, state: this.state, eye: this.eye, l, r };
  }
}
