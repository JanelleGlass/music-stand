// Front camera + MediaPipe Face Landmarker → wink events.
//
// Events:
//   status  { state: 'off'|'loading'|'running'|'noface'|'error', message }
//   frame   { face, rawL, rawR, l, r, progress, state, eye }   (every analysed frame)
//   wink    { eye: 'left'|'right' }                             (person's own left/right)
import { WinkLogic } from './wink-logic.js';

const VISION_URL = new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href;
const WASM_BASE = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_URL = new URL('../vendor/models/face_landmarker.task', import.meta.url).href;

let landmarkerPromise = null;

function createLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, FaceLandmarker } = await import(VISION_URL);
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      // The first detection compiles shaders and can take a moment, so do it
      // now (while "Starting camera…" shows) rather than on the first real frame.
      const warm = document.createElement('canvas');
      warm.width = warm.height = 64;
      warm.getContext('2d').fillRect(0, 0, 64, 64);
      let lastError;
      for (const delegate of ['GPU', 'CPU']) {
        let lm;
        try {
          lm = await FaceLandmarker.createFromOptions(fileset, options(delegate));
          lm.detectForVideo(warm, performance.now());
          return lm;
        } catch (e) {
          console.warn(`Face tracking (${delegate}) unavailable`, e);
          if (lm) lm.close();
          lastError = e;
        }
      }
      throw lastError;
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

function cameraErrorMessage(e) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'Camera access needs the app to be opened over HTTPS.';
  }
  switch (e && e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access for this site (iPad Settings › Apps › Safari › Camera, or the aA menu › Website Settings) and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No front camera was found.';
    case 'NotReadableError':
      return 'The camera is in use by another app.';
    default:
      return (e && e.message) || 'Could not start the camera.';
  }
}

export class WinkCamera extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    // iOS only plays camera video inline (and without a tap) when muted + playsinline.
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    this.logic = new WinkLogic();
    this.owners = new Set();
    this.stream = null;
    this.landmarker = null;
    this.running = false;
    this.paused = false;
    this.fps = 20;
    this.swap = false;
    this.state = 'off';
    this.message = '';
    this.raf = 0;
    this.lastRun = 0;
    this.lastVideoTime = -1;
    this.errors = 0;
    this.startToken = 0;
    this.idx = null;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.#stopStream();
      else if (this.owners.size) this.#start();
    });
  }

  configure({ sensitivity, holdMs, fps, swap }) {
    this.logic.configure({ sensitivity, holdMs });
    if (fps) this.fps = fps;
    if (swap != null) this.swap = swap;
  }

  // Several parts of the UI can need the camera (viewer, settings test).
  // It runs while at least one owner holds it.
  acquire(owner) {
    this.owners.add(owner);
    this.#start();
  }

  release(owner) {
    this.owners.delete(owner);
    if (!this.owners.size) this.#stop();
  }

  retry() {
    if (this.owners.size) {
      this.#stop(true);
      this.#start();
    }
  }

  #setStatus(state, message = '') {
    if (state === this.state && message === this.message) return;
    this.state = state;
    this.message = message;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, message } }));
  }

  async #start() {
    if (this.running || this.starting) return;
    this.starting = true;
    const token = ++this.startToken;
    this.#setStatus('loading', 'Starting camera…');
    try {
      const camera = !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia
        ? Promise.reject(new Error('nomedia'))
        : navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
          });
      // allSettled, so a stream that arrives after a model failure still gets stopped.
      const [lm, cam] = await Promise.allSettled([createLandmarker(), camera]);
      const stream = cam.status === 'fulfilled' ? cam.value : null;
      const abandon = token !== this.startToken || !this.owners.size || document.hidden;
      if (abandon || lm.status === 'rejected' || !stream) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        if (abandon) return;
        if (!stream) throw Object.assign(new Error(cameraErrorMessage(cam.reason)), { friendly: true });
        throw Object.assign(new Error(`Face tracking failed to load: ${lm.reason && lm.reason.message || lm.reason}`), { friendly: true });
      }
      const landmarker = lm.value;
      this.landmarker = landmarker;
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      this.running = true;
      this.errors = 0;
      this.logic.reset();
      this.#setStatus('noface', 'Looking for your face…');
      this.raf = requestAnimationFrame(this.#tick);
    } catch (e) {
      if (token !== this.startToken) return;
      console.warn('Wink camera failed', e);
      this.#setStatus('error', e.friendly ? e.message : `Could not start wink control: ${e.message || e}`);
      this.#stopStream();
    } finally {
      if (token === this.startToken) this.starting = false;
    }
  }

  #stopStream() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  #stop(keepStatus = false) {
    this.startToken++;
    this.starting = false;
    this.#stopStream();
    if (!keepStatus) this.#setStatus('off');
  }

  #tick = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.#tick);
    const v = this.video;
    const now = performance.now();
    // WebKit may pause an off-screen muted video; nudge it back.
    if (v.paused && now - this.lastRun > 1000) {
      this.lastRun = now;
      v.play().catch(() => {});
      return;
    }
    if (this.paused || v.readyState < 2 || now - this.lastRun < 1000 / this.fps - 4) return;
    if (v.currentTime === this.lastVideoTime) return;
    this.lastRun = now;
    this.lastVideoTime = v.currentTime;

    let result;
    try {
      result = this.landmarker.detectForVideo(v, now);
      this.errors = 0;
    } catch (e) {
      if (++this.errors > 10) {
        this.#setStatus('error', `Face tracking stopped: ${e.message || e}`);
        this.#stopStream();
      }
      return;
    }

    const cats = result.faceBlendshapes && result.faceBlendshapes[0] && result.faceBlendshapes[0].categories;
    if (!cats) {
      const out = this.logic.noFace(now);
      this.#setStatus('noface', 'No face in view');
      this.#emitFrame({ face: false, ...out });
      return;
    }
    if (!this.idx) {
      this.idx = {
        l: cats.findIndex((c) => c.categoryName === 'eyeBlinkLeft'),
        r: cats.findIndex((c) => c.categoryName === 'eyeBlinkRight'),
      };
    }
    let rawL = cats[this.idx.l].score;
    let rawR = cats[this.idx.r].score;
    if (this.swap) [rawL, rawR] = [rawR, rawL];
    this.#setStatus('running', 'Watching for winks');
    const out = this.logic.update(rawL, rawR, now);
    this.#emitFrame({ face: true, rawL, rawR, ...out });
    if (out.event) this.dispatchEvent(new CustomEvent('wink', { detail: { eye: out.event } }));
  };

  #emitFrame(detail) {
    this.dispatchEvent(new CustomEvent('frame', { detail }));
  }
}
