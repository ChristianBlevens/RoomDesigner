/**
 * Furniture Segmentation Tool
 *
 * Upload -> tap items -> segment -> review -> export
 * Stateless: nothing persisted. Closing the tab loses all state.
 */

import { exportSegments } from './segmentation-export.js';

// --- State ---

let sourceImage = null;       // HTMLImageElement
let sourceImageBytes = null;  // ArrayBuffer of original file
let points = [];              // [{x, y}] in original image coordinates
let masks = [];               // response from server
let rejected = new Set();     // mask IDs the user rejected

// --- DOM refs ---

const uploadSection = document.getElementById('seg-upload');
const workspace = document.getElementById('seg-workspace');
const dropZone = document.getElementById('seg-drop-zone');
const fileInput = document.getElementById('seg-file-input');
const canvas = document.getElementById('seg-canvas');
const ctx = canvas.getContext('2d');
const processing = document.getElementById('seg-processing');
const results = document.getElementById('seg-results');
const resultList = document.getElementById('seg-result-list');
const resultCount = document.getElementById('seg-result-count');
const pointCount = document.getElementById('seg-point-count');

const btnUploadNew = document.getElementById('seg-btn-upload-new');
const btnUndoPoint = document.getElementById('seg-btn-undo-point');
const btnClearPoints = document.getElementById('seg-btn-clear-points');
const btnSegment = document.getElementById('seg-btn-segment');
const btnExport = document.getElementById('seg-btn-export');

// --- API base path (same detection pattern as RoomDesigner) ---

function getApiBase() {
  const path = window.location.pathname;
  const parts = path.split('/').filter(Boolean);
  // If served under /room/segmentation.html, API is at /room/api/segmentation
  if (parts.length > 1) {
    return '/' + parts.slice(0, -1).join('/') + '/api/segmentation';
  }
  return '/api/segmentation';
}

const API_BASE = getApiBase();

// --- Upload handling ---

function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    sourceImageBytes = e.target.result;
    const img = new Image();
    img.onload = () => {
      sourceImage = img;
      points = [];
      masks = [];
      rejected.clear();
      showWorkspace();
      drawCanvas();
    };
    img.src = URL.createObjectURL(file);
  };
  reader.readAsArrayBuffer(file);
}

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

// --- State transitions ---

function showWorkspace() {
  uploadSection.classList.add('hidden');
  workspace.classList.remove('hidden');
  results.classList.add('hidden');
}

function showUpload() {
  workspace.classList.add('hidden');
  uploadSection.classList.remove('hidden');
  sourceImage = null;
  sourceImageBytes = null;
  points = [];
  masks = [];
  rejected.clear();
  fileInput.value = '';
}

// --- Canvas rendering ---

const MASK_COLORS = [
  [26, 159, 255],   // blue
  [46, 204, 113],   // green
  [231, 76, 60],    // red
  [241, 196, 15],   // yellow
  [155, 89, 182],   // purple
  [230, 126, 34],   // orange
  [26, 188, 156],   // teal
  [236, 100, 165],  // pink
  [52, 152, 219],   // light blue
  [211, 84, 0],     // dark orange
];

function drawCanvas() {
  if (!sourceImage) return;

  canvas.width = sourceImage.naturalWidth;
  canvas.height = sourceImage.naturalHeight;

  // Draw source image
  ctx.drawImage(sourceImage, 0, 0);

  // Draw mask overlays with compositing
  if (masks.length > 0) {
    for (const mask of masks) {
      if (rejected.has(mask.id)) continue;

      const color = MASK_COLORS[mask.id % MASK_COLORS.length];
      const maskImg = mask._decodedImage;
      if (!maskImg) continue;

      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const offCtx = off.getContext('2d');

      offCtx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
      const maskData = offCtx.getImageData(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < maskData.data.length; i += 4) {
        if (maskData.data[i] > 128) {
          maskData.data[i] = color[0];
          maskData.data[i + 1] = color[1];
          maskData.data[i + 2] = color[2];
          maskData.data[i + 3] = 80;
        } else {
          maskData.data[i + 3] = 0;
        }
      }
      offCtx.putImageData(maskData, 0, 0);

      ctx.drawImage(off, 0, 0);
    }
  }

  // Draw point markers on top
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const r = Math.max(8, Math.min(canvas.width, canvas.height) * 0.008);

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = '#1a9fff';
    ctx.fill();

    ctx.font = `bold ${Math.round(r * 1.4)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(i + 1), pt.x, pt.y - r * 2);
  }

  updateToolbarState();
}

// --- Point placement ---

canvas.addEventListener('click', (e) => {
  if (!sourceImage) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const x = Math.round((e.clientX - rect.left) * scaleX);
  const y = Math.round((e.clientY - rect.top) * scaleY);

  points.push({ x, y });
  drawCanvas();
});

// --- Toolbar ---

function updateToolbarState() {
  pointCount.textContent = `${points.length} point${points.length !== 1 ? 's' : ''} placed`;
  btnUndoPoint.disabled = points.length === 0;
  btnClearPoints.disabled = points.length === 0;
}

btnUploadNew.addEventListener('click', showUpload);

btnUndoPoint.addEventListener('click', () => {
  points.pop();
  drawCanvas();
});

btnClearPoints.addEventListener('click', () => {
  points = [];
  masks = [];
  rejected.clear();
  results.classList.add('hidden');
  drawCanvas();
});

// --- Segmentation API call ---

btnSegment.addEventListener('click', async () => {
  if (!sourceImageBytes) return;

  processing.classList.remove('hidden');
  btnSegment.disabled = true;

  try {
    const imageB64 = arrayBufferToBase64(sourceImageBytes);

    const payload = { image: imageB64 };
    if (points.length > 0) {
      payload.points = points;
    }

    const response = await fetch(`${API_BASE}/segment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `Server error ${response.status}`);
    }

    const data = await response.json();
    masks = data.masks || [];
    rejected.clear();

    // Decode mask PNGs into Image elements for canvas rendering
    await Promise.all(masks.map(async (mask) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `data:image/png;base64,${mask.mask}`;
      });
      mask._decodedImage = img;
    }));

    drawCanvas();
    renderResults();
  } catch (err) {
    alert(`Segmentation failed: ${err.message}`);
  } finally {
    processing.classList.add('hidden');
    btnSegment.disabled = false;
  }
});

// --- Results panel ---

function renderResults() {
  if (masks.length === 0) {
    results.classList.add('hidden');
    return;
  }

  results.classList.remove('hidden');
  resultCount.textContent = String(masks.length);
  resultList.innerHTML = '';

  for (const mask of masks) {
    const card = document.createElement('div');
    card.className = `seg-card${rejected.has(mask.id) ? ' rejected' : ''}`;
    card.dataset.maskId = mask.id;

    const thumbUrl = generateThumbnail(mask);

    card.innerHTML = `
      <img class="seg-card-thumb" src="${thumbUrl}" alt="Segment ${mask.id + 1}">
      <div class="seg-card-info">
        <input class="seg-card-name" type="text" value="item_${mask.id + 1}" spellcheck="false">
        <div class="seg-card-score">Score: ${mask.score.toFixed(2)}</div>
      </div>
      <div class="seg-card-actions">
        <button class="seg-card-btn reject" title="${rejected.has(mask.id) ? 'Restore' : 'Reject'}">
          ${rejected.has(mask.id) ? '\u21a9' : '\u2715'}
        </button>
      </div>
    `;

    card.addEventListener('mouseenter', () => {
      card.classList.add('highlighted');
    });
    card.addEventListener('mouseleave', () => {
      card.classList.remove('highlighted');
    });

    card.querySelector('.seg-card-btn.reject').addEventListener('click', () => {
      if (rejected.has(mask.id)) {
        rejected.delete(mask.id);
      } else {
        rejected.add(mask.id);
      }
      drawCanvas();
      renderResults();
    });

    mask._nameInput = card.querySelector('.seg-card-name');

    resultList.appendChild(card);
  }
}

function generateThumbnail(mask) {
  if (!mask._decodedImage || !sourceImage) return '';

  const bbox = mask.bbox; // [x, y, w, h]
  const pad = 10;
  const x = Math.max(0, bbox[0] - pad);
  const y = Math.max(0, bbox[1] - pad);
  const w = Math.min(sourceImage.naturalWidth - x, bbox[2] + pad * 2);
  const h = Math.min(sourceImage.naturalHeight - y, bbox[3] + pad * 2);

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const offCtx = off.getContext('2d');

  offCtx.drawImage(sourceImage, x, y, w, h, 0, 0, w, h);

  const maskOff = document.createElement('canvas');
  maskOff.width = sourceImage.naturalWidth;
  maskOff.height = sourceImage.naturalHeight;
  const maskCtx = maskOff.getContext('2d');
  maskCtx.drawImage(mask._decodedImage, 0, 0, sourceImage.naturalWidth, sourceImage.naturalHeight);
  const maskData = maskCtx.getImageData(x, y, w, h);

  const imgData = offCtx.getImageData(0, 0, w, h);
  for (let i = 0; i < maskData.data.length; i += 4) {
    if (maskData.data[i] < 128) {
      imgData.data[i + 3] = 0;
    }
  }
  offCtx.putImageData(imgData, 0, 0);

  return off.toDataURL('image/png');
}

// --- Export ---

btnExport.addEventListener('click', () => {
  const accepted = masks.filter((m) => !rejected.has(m.id));
  if (accepted.length === 0) {
    alert('No segments to export. Accept at least one segment.');
    return;
  }

  const segments = accepted.map((mask) => ({
    name: mask._nameInput ? mask._nameInput.value.trim() || `item_${mask.id + 1}` : `item_${mask.id + 1}`,
    mask,
  }));

  exportSegments(sourceImage, segments);
});

// --- Utilities ---

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
