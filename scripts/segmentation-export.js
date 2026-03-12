/**
 * Segmentation export: apply masks to source image, produce transparent PNGs, bundle as ZIP.
 * Optionally fix selected segments via Gemini AI before export.
 */

// --- API base path (mirrors segmentation.js) ---

function getApiBase() {
  const path = window.location.pathname;
  const parts = path.split('/').filter(Boolean);
  if (parts.length > 1) {
    return '/' + parts.slice(0, -1).join('/') + '/api/segmentation';
  }
  return '/api/segmentation';
}

const API_BASE = getApiBase();

// --- Fix modal state ---

let fixModal = null;
let fixGrid = null;
let fixStatus = null;
let fixExportBtn = null;
let fixCancelBtn = null;
let fixSelectedIds = new Set();
let fixResolve = null;

function initFixModal() {
  fixModal = document.getElementById('seg-fix-modal');
  fixGrid = document.getElementById('seg-fix-grid');
  fixStatus = document.getElementById('seg-fix-status');
  fixExportBtn = document.getElementById('seg-fix-export');
  fixCancelBtn = document.getElementById('seg-fix-cancel');

  fixCancelBtn.addEventListener('click', () => {
    fixModal.classList.add('hidden');
    if (fixResolve) fixResolve(null);
    fixResolve = null;
  });

  fixExportBtn.addEventListener('click', () => {
    fixModal.classList.add('hidden');
    if (fixResolve) fixResolve(fixSelectedIds);
    fixResolve = null;
  });
}

/**
 * Show fix modal and return a Promise that resolves to:
 * - Set of segment indices to fix (may be empty = fix none), or
 * - null if cancelled
 */
function showFixModal(segments) {
  if (!fixModal) initFixModal();
  fixSelectedIds = new Set();
  fixGrid.innerHTML = '';
  fixStatus.textContent = '';
  fixExportBtn.disabled = false;
  fixExportBtn.textContent = 'Export';

  segments.forEach((seg, idx) => {
    const card = document.createElement('div');
    card.className = 'seg-fix-card';
    card.dataset.idx = idx;

    card.innerHTML = `
      <img class="seg-fix-card-thumb" src="${seg.thumbDataUrl}" alt="${seg.name}">
      <div class="seg-fix-card-name" title="${seg.name}">${seg.name}</div>
      <div class="seg-fix-card-status" data-idx="${idx}"></div>
    `;

    card.addEventListener('click', () => {
      if (fixExportBtn.disabled) return;
      if (fixSelectedIds.has(idx)) {
        fixSelectedIds.delete(idx);
        card.classList.remove('selected');
      } else {
        fixSelectedIds.add(idx);
        card.classList.add('selected');
      }
      updateFixCount();
    });

    fixGrid.appendChild(card);
  });

  updateFixCount();
  fixModal.classList.remove('hidden');

  return new Promise((resolve) => {
    fixResolve = resolve;
  });
}

function updateFixCount() {
  const n = fixSelectedIds.size;
  fixStatus.textContent = n > 0 ? `${n} selected for AI repair` : '';
}

/**
 * Export accepted segments as transparent PNGs in a ZIP.
 * Shows fix modal first so user can select segments for AI repair.
 *
 * @param {HTMLImageElement} sourceImage - Original uploaded image
 * @param {Array<{name: string, mask: object, maskCanvas: HTMLCanvasElement|null}>} segments
 */
export async function exportSegments(sourceImage, segments) {
  const segmentsWithThumbs = segments.map((seg) => ({
    ...seg,
    thumbDataUrl: generateThumbDataUrl(sourceImage, seg.mask, seg.maskCanvas),
  }));

  const selectedForFix = await showFixModal(segmentsWithThumbs);
  if (selectedForFix === null) return;

  fixModal.classList.remove('hidden');
  fixExportBtn.disabled = true;
  fixExportBtn.textContent = 'Processing...';

  const zip = new JSZip();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let pngBlob = await maskToTransparentPNG(sourceImage, seg.mask, seg.maskCanvas);

    if (selectedForFix.has(i)) {
      const statusEl = fixGrid.querySelector(`[data-idx="${i}"]`);
      if (statusEl) {
        statusEl.textContent = 'Fixing...';
        statusEl.className = 'seg-fix-card-status fixing';
      }

      try {
        const base64 = await blobToBase64(pngBlob);
        const response = await fetch(`${API_BASE}/fix-segment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: base64 }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ detail: 'Unknown error' }));
          throw new Error(err.detail || 'Fix failed');
        }

        const data = await response.json();
        pngBlob = base64ToBlob(data.image_base64, 'image/png');

        if (statusEl) {
          statusEl.textContent = 'Fixed';
          statusEl.className = 'seg-fix-card-status done';
        }
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = `Error: ${err.message}`;
          statusEl.className = 'seg-fix-card-status error';
        }
      }
    }

    zip.file(`${sanitizeFilename(seg.name)}.png`, pngBlob);
  }

  fixModal.classList.add('hidden');

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `segments_${Date.now()}.zip`);
}

/**
 * Apply a binary mask to the source image, crop to bbox, return transparent PNG blob.
 */
async function maskToTransparentPNG(sourceImage, mask, editedMaskCanvas) {
  const maskSrc = editedMaskCanvas || mask._decodedImage;

  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = sourceImage.naturalWidth;
  fullCanvas.height = sourceImage.naturalHeight;
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
  fullCtx.drawImage(maskSrc, 0, 0, sourceImage.naturalWidth, sourceImage.naturalHeight);
  const fullData = fullCtx.getImageData(0, 0, sourceImage.naturalWidth, sourceImage.naturalHeight);

  let minX = sourceImage.naturalWidth, minY = sourceImage.naturalHeight, maxX = 0, maxY = 0;
  const sw = sourceImage.naturalWidth;
  for (let py = 0; py < sourceImage.naturalHeight; py++) {
    for (let px = 0; px < sw; px++) {
      if (fullData.data[(py * sw + px) * 4 + 3] > 128) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }

  if (maxX < minX) {
    const empty = document.createElement('canvas');
    empty.width = 1;
    empty.height = 1;
    return new Promise((resolve) => empty.toBlob(resolve, 'image/png'));
  }

  const pad = 10;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const w = Math.min(sourceImage.naturalWidth - x, (maxX - minX + 1) + pad * 2);
  const h = Math.min(sourceImage.naturalHeight - y, (maxY - minY + 1) + pad * 2);

  const maskData = fullCtx.getImageData(x, y, w, h);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  outCtx.drawImage(sourceImage, x, y, w, h, 0, 0, w, h);

  const imgData = outCtx.getImageData(0, 0, w, h);
  for (let i = 0; i < maskData.data.length; i += 4) {
    if (maskData.data[i + 3] < 128) {
      imgData.data[i + 3] = 0;
    }
  }
  outCtx.putImageData(imgData, 0, 0);

  return new Promise((resolve) => {
    outCanvas.toBlob(resolve, 'image/png');
  });
}

/**
 * Generate a thumbnail data URL for a segment.
 */
function generateThumbDataUrl(sourceImage, mask, editedMaskCanvas) {
  const maskSrc = editedMaskCanvas || mask._decodedImage;
  if (!maskSrc || !sourceImage) return '';

  const w = sourceImage.naturalWidth;
  const h = sourceImage.naturalHeight;

  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = w;
  fullCanvas.height = h;
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
  fullCtx.drawImage(maskSrc, 0, 0, w, h);
  const fullData = fullCtx.getImageData(0, 0, w, h);

  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (fullData.data[(py * w + px) * 4 + 3] > 128) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }

  if (maxX < minX) return '';

  const pad = 10;
  const cx = Math.max(0, minX - pad);
  const cy = Math.max(0, minY - pad);
  const cw = Math.min(w - cx, (maxX - minX + 1) + pad * 2);
  const ch = Math.min(h - cy, (maxY - minY + 1) + pad * 2);

  const off = document.createElement('canvas');
  off.width = cw;
  off.height = ch;
  const offCtx = off.getContext('2d', { willReadFrequently: true });
  offCtx.drawImage(sourceImage, cx, cy, cw, ch, 0, 0, cw, ch);

  const maskData = fullCtx.getImageData(cx, cy, cw, ch);
  const imgData = offCtx.getImageData(0, 0, cw, ch);
  for (let i = 0; i < maskData.data.length; i += 4) {
    if (maskData.data[i + 3] < 128) {
      imgData.data[i + 3] = 0;
    }
  }
  offCtx.putImageData(imgData, 0, 0);

  return off.toDataURL('image/png');
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 100) || 'item';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}
