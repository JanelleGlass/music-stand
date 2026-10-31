// PDF.js setup. Uses the vendored "legacy" build, which also runs on older iPads.
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

const base = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';

export { pdfjsLib };

// data: ArrayBuffer or Uint8Array. PDF.js transfers it to its worker, so the
// caller must not use the buffer afterwards.
export function openPdf(data) {
  return pdfjsLib.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    isEvalSupported: false,
    enableXfa: false,
  }).promise;
}

export function describePdfError(err) {
  if (err && err.name === 'PasswordException') return 'This PDF is password-protected. Remove the password and add it again.';
  if (err && err.name === 'InvalidPDFException') return 'This file is not a valid PDF.';
  return (err && err.message) || String(err);
}

export function isCancel(err) {
  return err && err.name === 'RenderingCancelledException';
}

// Page sizes in PDF points (1/72 in), rotation applied.
export async function readPageSizes(pdf, onProgress) {
  const sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push([Math.round(vp.width * 100) / 100, Math.round(vp.height * 100) / 100]);
    page.cleanup();
    if (onProgress && i % 20 === 0) onProgress(i, pdf.numPages);
  }
  return sizes;
}

export async function renderThumb(pdf, width = 360) {
  const page = await pdf.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp1.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
  page.cleanup();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  canvas.width = canvas.height = 0;
  return blob;
}
