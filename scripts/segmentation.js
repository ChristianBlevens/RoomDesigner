/**
 * Furniture Segmentation Tool
 *
 * Upload -> create objects -> tap points per object -> segment -> review -> export
 * Stateless: nothing persisted. Closing the tab loses all state.
 */

import { exportSegments } from './segmentation-export.js';
import { getToken } from './auth.js';

// --- Auth gate ---

function getBasePath() {
  const path = window.location.pathname;
  const parts = path.split('/').filter(Boolean);
  if (parts.length > 1) {
    return '/' + parts.slice(0, -1).join('/');
  }
  return '';
}

if (!getToken()) {
  window.location.href = getBasePath() + '/';
}

// --- State ---

let sourceImage = null;       // HTMLImageElement
let sourceImageBytes = null;  // ArrayBuffer of original file
let objects = [];             // [{id, name, points: [{x, y}]}]
let selectedObjectId = -1;    // which object receives new points
let nextObjectId = 0;         // auto-increment ID
let masks = [];               // response from server (1 mask per object)
let rejected = new Set();     // mask IDs the user rejected
let draggingPoint = null;     // {objectId, pointIdx} of point being dragged
let didDrag = false;          // distinguish drag from click
let highlightedMaskId = -1;   // mask ID hovered in results panel
let selectedMaskId = -1;      // mask ID selected for editing
let editMode = null;          // 'paint' | 'erase' | null
let brushSize = 20;           // brush radius in image-space pixels
let isDrawing = false;        // whether a paint/erase stroke is active
let lastDrawPos = null;       // last stroke position for interpolation
let currentStroke = null;     // stroke being recorded: {points: [{x,y}], radius, mode}
let pendingThumbnailId = 0;   // timer for deferred thumbnail update

// --- DOM refs ---

const uploadSection = document.getElementById('seg-upload');
const workspace = document.getElementById('seg-workspace');
const dropZone = document.getElementById('seg-drop-zone');
const fileInput = document.getElementById('seg-file-input');
const canvas = document.getElementById('seg-canvas');
const ctx = canvas.getContext('2d');
const processing = document.getElementById('seg-processing');
const objectPanel = document.getElementById('seg-object-panel');
const objectList = document.getElementById('seg-object-list');
const objectCount = document.getElementById('seg-object-count');
const resultPanel = document.getElementById('seg-results');
const resultList = document.getElementById('seg-result-list');
const resultCount = document.getElementById('seg-result-count');
const pointCount = document.getElementById('seg-point-count');

const btnUploadNew = document.getElementById('seg-btn-upload-new');
const btnUndoPoint = document.getElementById('seg-btn-undo-point');
const btnSegment = document.getElementById('seg-btn-segment');
const btnExport = document.getElementById('seg-btn-export');
const btnReset = document.getElementById('seg-btn-reset');
const btnAddObject = document.getElementById('seg-btn-add-object');
const editControls = document.getElementById('seg-edit-controls');
const btnUndoEdit = document.getElementById('seg-btn-undo-edit');
const btnPaint = document.getElementById('seg-btn-paint');
const btnErase = document.getElementById('seg-btn-erase');
const brushSlider = document.getElementById('seg-brush-size');

// --- Constants ---

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

// --- API base path ---

function getApiBase() {
  const path = window.location.pathname;
  const parts = path.split('/').filter(Boolean);
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
      resetState();
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

// --- State management ---

function resetState() {
  objects = [];
  selectedObjectId = -1;
  nextObjectId = 0;
  masks = [];
  rejected.clear();
  draggingPoint = null;
  didDrag = false;
  highlightedMaskId = -1;
  selectedMaskId = -1;
  editMode = null;
  isDrawing = false;
  lastDrawPos = null;
  currentStroke = null;
}

function hasResults() {
  return masks.length > 0;
}

function getSelectedObject() {
  return objects.find(o => o.id === selectedObjectId) || null;
}

function getObjectColor(obj) {
  const idx = objects.indexOf(obj);
  return MASK_COLORS[idx % MASK_COLORS.length];
}

function getObjectColorById(id) {
  const obj = objects.find(o => o.id === id);
  if (!obj) return MASK_COLORS[0];
  return getObjectColor(obj);
}

function totalPoints() {
  return objects.reduce((sum, o) => sum + o.points.length, 0);
}

function getSelectedMask() {
  return masks.find(m => m.id === selectedMaskId) || null;
}

function selectMask(id) {
  selectedMaskId = id;
  renderResults();
  drawCanvas();
}

// --- Mask canvas management ---

/**
 * Create a mutable mask canvas (white-on-transparent) from the decoded image.
 * Stores original state for undo replay and initializes stroke history.
 */
function initMaskCanvas(mask) {
  if (!mask._decodedImage || !sourceImage) return;
  const w = sourceImage.naturalWidth;
  const h = sourceImage.naturalHeight;

  // Draw decoded mask at full resolution
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tmpCtx = tmp.getContext('2d', { willReadFrequently: true });
  tmpCtx.drawImage(mask._decodedImage, 0, 0, w, h);

  // Convert white-on-black to white-on-transparent
  const data = tmpCtx.getImageData(0, 0, w, h);
  for (let i = 0; i < data.data.length; i += 4) {
    if (data.data[i] > 128) {
      data.data[i] = 255;
      data.data[i + 1] = 255;
      data.data[i + 2] = 255;
      data.data[i + 3] = 255;
    } else {
      data.data[i] = 0;
      data.data[i + 1] = 0;
      data.data[i + 2] = 0;
      data.data[i + 3] = 0;
    }
  }

  // Store original pixel data for undo replay
  mask._originalData = new ImageData(
    new Uint8ClampedArray(data.data),
    w, h
  );

  // Create the editable mask canvas
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cCtx = c.getContext('2d');
  cCtx.putImageData(data, 0, 0);
  mask._maskCanvas = c;

  // Stroke history for undo (per-mask, persists across selection changes)
  mask._strokes = [];
}

/** Paint or erase a circle on the mask canvas. */
function applyBrush(mask, cx, cy, radius, mode) {
  if (!mask._maskCanvas) return;
  const mCtx = mask._maskCanvas.getContext('2d');
  mCtx.beginPath();
  mCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  if (mode === 'paint') {
    mCtx.fillStyle = '#ffffff';
    mCtx.fill();
  } else {
    mCtx.save();
    mCtx.globalCompositeOperation = 'destination-out';
    mCtx.fillStyle = '#000000';
    mCtx.fill();
    mCtx.restore();
  }
}

/** Interpolate between two points for smooth strokes. */
function strokeLine(mask, x0, y0, x1, y1, radius, mode) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = Math.max(1, radius * 0.3);
  const steps = Math.ceil(dist / step);
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    applyBrush(mask, x0 + dx * t, y0 + dy * t, radius, mode);
  }
}

/** Replay all strokes from original mask state. */
function replayStrokes(mask) {
  if (!mask._maskCanvas || !mask._originalData) return;
  const mCtx = mask._maskCanvas.getContext('2d');
  mCtx.putImageData(mask._originalData, 0, 0);
  for (const stroke of mask._strokes) {
    for (let i = 0; i < stroke.points.length; i++) {
      if (i === 0) {
        applyBrush(mask, stroke.points[0].x, stroke.points[0].y, stroke.radius, stroke.mode);
      } else {
        strokeLine(mask,
          stroke.points[i - 1].x, stroke.points[i - 1].y,
          stroke.points[i].x, stroke.points[i].y,
          stroke.radius, stroke.mode);
      }
    }
  }
}

/** Undo the last stroke on the selected mask. */
function undoLastStroke() {
  const mask = getSelectedMask();
  if (!mask || !mask._strokes || mask._strokes.length === 0) return;
  mask._strokes.pop();
  replayStrokes(mask);
  drawCanvas();
  deferThumbnailUpdate(mask);
  updateToolbarState();
}

/** Schedule a deferred thumbnail update (doesn't block painting). */
function deferThumbnailUpdate(mask) {
  clearTimeout(pendingThumbnailId);
  pendingThumbnailId = setTimeout(() => {
    refreshThumbnail(mask);
  }, 100);
}

/** Regenerate a single mask's thumbnail and update its card image. */
function refreshThumbnail(mask) {
  const thumbUrl = generateThumbnail(mask);
  const card = resultList.querySelector(`[data-mask-id="${mask.id}"]`);
  if (card) {
    const img = card.querySelector('.seg-card-thumb');
    if (img) img.src = thumbUrl;
  }
}

// --- State transitions ---

function showWorkspace() {
  uploadSection.classList.add('hidden');
  workspace.classList.remove('hidden');
  resultPanel.classList.add('hidden');
  objectPanel.classList.remove('hidden');
  renderObjectList();
}

function showUpload() {
  workspace.classList.add('hidden');
  uploadSection.classList.remove('hidden');
  sourceImage = null;
  sourceImageBytes = null;
  resetState();
  fileInput.value = '';
}

// --- Object management ---

function addObject() {
  const id = nextObjectId++;
  const name = `Object ${objects.length + 1}`;
  objects.push({ id, name, points: [] });
  selectedObjectId = id;
  renderObjectList();
  drawCanvas();
}

function selectObject(id) {
  if (hasResults()) return;
  selectedObjectId = id;
  renderObjectList();
  drawCanvas();
}

function removeObject(id) {
  if (hasResults()) return;
  objects = objects.filter(o => o.id !== id);
  if (selectedObjectId === id) {
    selectedObjectId = objects.length > 0 ? objects[objects.length - 1].id : -1;
  }
  renderObjectList();
  drawCanvas();
}

// --- Object list panel ---

function renderObjectList() {
  objectCount.textContent = String(objects.length);
  objectList.innerHTML = '';

  for (const obj of objects) {
    const color = getObjectColor(obj);
    const isSelected = obj.id === selectedObjectId;
    const card = document.createElement('div');
    card.className = `seg-obj-card${isSelected ? ' selected' : ''}`;
    card.style.borderLeftWidth = '3px';
    card.style.borderLeftColor = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

    card.innerHTML = `
      <div class="seg-obj-info">
        <input class="seg-obj-name" type="text" value="${obj.name}" spellcheck="false">
        <div class="seg-obj-points">${obj.points.length} point${obj.points.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="seg-obj-actions">
        <button class="seg-card-btn remove" title="Remove object">\u2715</button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      selectObject(obj.id);
    });

    const nameInput = card.querySelector('.seg-obj-name');
    nameInput.addEventListener('input', () => {
      obj.name = nameInput.value;
    });
    nameInput.addEventListener('click', (e) => {
      e.stopPropagation();
      selectObject(obj.id);
    });

    card.querySelector('.seg-card-btn.remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeObject(obj.id);
    });

    objectList.appendChild(card);
  }

  updateToolbarState();
}

// --- Canvas rendering ---

/**
 * Draw a single mask overlay using canvas compositing (no getImageData).
 * maskSrc must be white-on-transparent.
 */
function drawMaskOverlay(maskSrc, color, alpha) {
  const off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
  const offCtx = off.getContext('2d');

  // Draw white-on-transparent mask
  offCtx.drawImage(maskSrc, 0, 0, canvas.width, canvas.height);

  // Replace white with desired color+alpha using source-in compositing
  offCtx.globalCompositeOperation = 'source-in';
  offCtx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${(alpha / 255).toFixed(3)})`;
  offCtx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.drawImage(off, 0, 0);
}

/**
 * Draw edge highlight for a mask (only called when not actively painting).
 * Uses getImageData but only for a single mask on hover/select — not per-frame during strokes.
 */
function drawMaskEdge(maskSrc, color) {
  const w = canvas.width;
  const h = canvas.height;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const offCtx = off.getContext('2d', { willReadFrequently: true });

  offCtx.drawImage(maskSrc, 0, 0, w, h);
  const maskData = offCtx.getImageData(0, 0, w, h);
  const edgeData = offCtx.createImageData(w, h);

  for (let py = 1; py < h - 1; py++) {
    for (let px = 1; px < w - 1; px++) {
      const idx = (py * w + px) * 4;
      if (maskData.data[idx + 3] > 128) {
        const up = ((py - 1) * w + px) * 4;
        const dn = ((py + 1) * w + px) * 4;
        const lt = (py * w + (px - 1)) * 4;
        const rt = (py * w + (px + 1)) * 4;
        if (maskData.data[up + 3] <= 128 || maskData.data[dn + 3] <= 128 ||
            maskData.data[lt + 3] <= 128 || maskData.data[rt + 3] <= 128) {
          edgeData.data[idx] = color[0];
          edgeData.data[idx + 1] = color[1];
          edgeData.data[idx + 2] = color[2];
          edgeData.data[idx + 3] = 255;
        }
      }
    }
  }

  offCtx.putImageData(edgeData, 0, 0);
  ctx.drawImage(off, 0, 0);
}

function drawCanvas() {
  if (!sourceImage) return;

  canvas.width = sourceImage.naturalWidth;
  canvas.height = sourceImage.naturalHeight;

  // Draw source image
  ctx.drawImage(sourceImage, 0, 0);

  // Draw mask overlays if we have results
  if (hasResults()) {
    for (const mask of masks) {
      if (rejected.has(mask.id)) continue;

      const color = MASK_COLORS[mask.id % MASK_COLORS.length];
      const isHighlighted = mask.id === highlightedMaskId;
      const isSelected = mask.id === selectedMaskId;
      const alpha = (isHighlighted || isSelected) ? 160 : 80;
      const maskSrc = mask._maskCanvas || mask._decodedImage;
      if (!maskSrc) continue;

      // Fast compositing overlay — no pixel loops
      drawMaskOverlay(maskSrc, color, alpha);

      // Edge highlight only when not actively painting (expensive)
      if ((isHighlighted || isSelected) && !isDrawing) {
        drawMaskEdge(maskSrc, color);
      }
    }
  }

  // Draw point markers (only before results)
  if (!hasResults()) {
    const r = Math.max(8, Math.min(canvas.width, canvas.height) * 0.008);

    for (const obj of objects) {
      const color = getObjectColor(obj);
      const isSelected = obj.id === selectedObjectId;
      const rgb = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

      for (const pt of obj.points) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth = isSelected ? 3 : 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = rgb;
        ctx.fill();
      }
    }
  }

  updateToolbarState();
}

// --- Point placement and dragging ---

function canvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY),
  };
}

function hitTestPoint(cx, cy) {
  const hitRadius = Math.max(16, Math.min(canvas.width, canvas.height) * 0.015);
  for (let oi = objects.length - 1; oi >= 0; oi--) {
    const obj = objects[oi];
    for (let pi = obj.points.length - 1; pi >= 0; pi--) {
      const dx = obj.points[pi].x - cx;
      const dy = obj.points[pi].y - cy;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        return { objectId: obj.id, pointIdx: pi };
      }
    }
  }
  return null;
}

function canEditMask() {
  return hasResults() && selectedMaskId >= 0 && editMode && !rejected.has(selectedMaskId);
}

canvas.addEventListener('pointerdown', (e) => {
  if (!sourceImage) return;

  // Mask editing mode
  if (canEditMask()) {
    const mask = getSelectedMask();
    if (!mask) return;
    isDrawing = true;
    lastDrawPos = canvasCoords(e);
    currentStroke = { points: [{ ...lastDrawPos }], radius: brushSize, mode: editMode };
    canvas.setPointerCapture(e.pointerId);
    applyBrush(mask, lastDrawPos.x, lastDrawPos.y, brushSize, editMode);
    drawCanvas();
    e.preventDefault();
    return;
  }

  if (hasResults()) return;

  const { x, y } = canvasCoords(e);
  const hit = hitTestPoint(x, y);

  if (hit) {
    draggingPoint = hit;
    didDrag = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!sourceImage) return;

  // Mask editing stroke
  if (isDrawing && canEditMask()) {
    const mask = getSelectedMask();
    if (!mask) return;
    const pos = canvasCoords(e);
    strokeLine(mask, lastDrawPos.x, lastDrawPos.y, pos.x, pos.y, brushSize, editMode);
    currentStroke.points.push({ ...pos });
    lastDrawPos = pos;
    drawCanvas();
    e.preventDefault();
    return;
  }

  if (hasResults()) {
    canvas.style.cursor = canEditMask() ? 'crosshair' : 'default';
    return;
  }

  const { x, y } = canvasCoords(e);

  if (draggingPoint) {
    didDrag = true;
    const obj = objects.find(o => o.id === draggingPoint.objectId);
    if (obj) {
      obj.points[draggingPoint.pointIdx].x = Math.max(0, Math.min(canvas.width, x));
      obj.points[draggingPoint.pointIdx].y = Math.max(0, Math.min(canvas.height, y));
      drawCanvas();
    }
    e.preventDefault();
  } else {
    const hit = hitTestPoint(x, y);
    if (hit) {
      canvas.style.cursor = 'grab';
    } else if (selectedObjectId >= 0) {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = 'default';
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  // End mask editing stroke
  if (isDrawing) {
    canvas.releasePointerCapture(e.pointerId);
    isDrawing = false;
    lastDrawPos = null;
    // Save completed stroke to history
    const mask = getSelectedMask();
    if (mask && currentStroke) {
      mask._strokes.push(currentStroke);
      currentStroke = null;
      deferThumbnailUpdate(mask);
    }
    // Redraw with edge highlights now that stroke is done
    drawCanvas();
    e.preventDefault();
    return;
  }

  if (hasResults()) return;

  if (draggingPoint) {
    canvas.releasePointerCapture(e.pointerId);
    draggingPoint = null;
    canvas.style.cursor = 'crosshair';
    e.preventDefault();
    renderObjectList();
    return;
  }

  if (!didDrag && selectedObjectId >= 0) {
    const { x, y } = canvasCoords(e);
    if (!hitTestPoint(x, y)) {
      const obj = getSelectedObject();
      if (obj) {
        obj.points.push({ x, y });
        renderObjectList();
        drawCanvas();
      }
    }
  }
  didDrag = false;
});

// --- Toolbar ---

function updateToolbarState() {
  const tp = totalPoints();
  if (hasResults()) {
    pointCount.textContent = '';
    btnUndoPoint.classList.add('hidden');
    btnSegment.classList.add('hidden');
    btnReset.classList.remove('hidden');
    editControls.classList.remove('hidden');
    objectPanel.classList.add('hidden');
    resultPanel.classList.remove('hidden');
    // Update edit button states
    btnPaint.classList.toggle('active', editMode === 'paint');
    btnErase.classList.toggle('active', editMode === 'erase');
    // Undo edit enabled if selected mask has strokes
    const selMask = getSelectedMask();
    btnUndoEdit.disabled = !selMask || !selMask._strokes || selMask._strokes.length === 0;
  } else {
    if (selectedObjectId >= 0) {
      const obj = getSelectedObject();
      const objPts = obj ? obj.points.length : 0;
      pointCount.textContent = `${tp} point${tp !== 1 ? 's' : ''} (${objPts} on ${obj ? obj.name : '?'})`;
    } else {
      pointCount.textContent = objects.length > 0
        ? `${tp} point${tp !== 1 ? 's' : ''} — select an object to place`
        : 'Add an object to start';
    }
    btnUndoPoint.classList.remove('hidden');
    btnSegment.classList.remove('hidden');
    btnReset.classList.add('hidden');
    editControls.classList.add('hidden');
    objectPanel.classList.remove('hidden');
    resultPanel.classList.add('hidden');
    btnUndoPoint.disabled = !getSelectedObject() || getSelectedObject().points.length === 0;
    btnSegment.disabled = tp === 0;
  }
}

btnUploadNew.addEventListener('click', showUpload);

btnUndoPoint.addEventListener('click', () => {
  const obj = getSelectedObject();
  if (obj && obj.points.length > 0) {
    obj.points.pop();
    renderObjectList();
    drawCanvas();
  }
});

btnReset.addEventListener('click', () => {
  resetState();
  resultPanel.classList.add('hidden');
  objectPanel.classList.remove('hidden');
  renderObjectList();
  drawCanvas();
});

btnAddObject.addEventListener('click', () => {
  if (hasResults()) return;
  addObject();
});

btnUndoEdit.addEventListener('click', undoLastStroke);

btnPaint.addEventListener('click', () => {
  editMode = editMode === 'paint' ? null : 'paint';
  updateToolbarState();
  canvas.style.cursor = canEditMask() ? 'crosshair' : 'default';
});

btnErase.addEventListener('click', () => {
  editMode = editMode === 'erase' ? null : 'erase';
  updateToolbarState();
  canvas.style.cursor = canEditMask() ? 'crosshair' : 'default';
});

brushSlider.addEventListener('input', () => {
  brushSize = parseInt(brushSlider.value, 10);
});

// --- Segmentation API call ---

btnSegment.addEventListener('click', async () => {
  if (!sourceImageBytes || totalPoints() === 0) return;

  processing.classList.remove('hidden');
  btnSegment.disabled = true;

  try {
    const imageB64 = arrayBufferToBase64(sourceImageBytes);

    const pointGroups = objects
      .filter(o => o.points.length > 0)
      .map(o => ({
        id: o.id,
        name: o.name,
        points: o.points,
      }));

    const payload = {
      image: imageB64,
      point_groups: pointGroups,
    };

    const response = await fetch(`${API_BASE}/segment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.href = getBasePath() + '/';
        return;
      }
      throw new Error(err.detail || `Server error ${response.status}`);
    }

    const data = await response.json();
    masks = data.masks || [];
    rejected.clear();

    // Decode mask PNGs into Image elements and create editable mask canvases
    await Promise.all(masks.map(async (mask) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `data:image/png;base64,${mask.mask}`;
      });
      mask._decodedImage = img;
      initMaskCanvas(mask);
    }));

    selectedMaskId = -1;
    editMode = null;
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
    resultPanel.classList.add('hidden');
    return;
  }

  resultPanel.classList.remove('hidden');
  objectPanel.classList.add('hidden');
  resultCount.textContent = String(masks.length);
  resultList.innerHTML = '';

  for (const mask of masks) {
    const card = document.createElement('div');
    const isSelected = mask.id === selectedMaskId;
    const isRejected = rejected.has(mask.id);
    card.className = `seg-card${isRejected ? ' rejected' : ''}${isSelected ? ' selected' : ''}`;
    card.dataset.maskId = mask.id;

    const thumbUrl = generateThumbnail(mask);
    const color = MASK_COLORS[mask.id % MASK_COLORS.length];
    card.style.borderLeftWidth = '3px';
    card.style.borderLeftColor = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

    const defaultName = mask._currentName || mask.name || `item_${mask.id + 1}`;

    card.innerHTML = `
      <img class="seg-card-thumb" src="${thumbUrl}" alt="Object ${mask.id + 1}">
      <div class="seg-card-info">
        <input class="seg-card-name" type="text" value="${defaultName}" spellcheck="false">
        <div class="seg-card-score">Score: ${mask.score.toFixed(2)}</div>
      </div>
      <div class="seg-card-actions">
        <button class="seg-card-btn reject" title="${isRejected ? 'Restore' : 'Reject'}">
          ${isRejected ? '\u21a9' : '\u2715'}
        </button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      selectMask(mask.id === selectedMaskId ? -1 : mask.id);
    });

    card.addEventListener('mouseenter', () => {
      card.classList.add('highlighted');
      highlightedMaskId = mask.id;
      drawCanvas();
    });
    card.addEventListener('mouseleave', () => {
      card.classList.remove('highlighted');
      highlightedMaskId = -1;
      drawCanvas();
    });

    card.querySelector('.seg-card-btn.reject').addEventListener('click', () => {
      if (rejected.has(mask.id)) {
        rejected.delete(mask.id);
      } else {
        rejected.add(mask.id);
        if (selectedMaskId === mask.id) selectedMaskId = -1;
      }
      drawCanvas();
      renderResults();
    });

    const nameInput = card.querySelector('.seg-card-name');
    nameInput.addEventListener('input', () => {
      mask._currentName = nameInput.value;
    });
    nameInput.addEventListener('click', (e) => {
      e.stopPropagation();
      selectMask(mask.id);
    });
    mask._nameInput = nameInput;

    resultList.appendChild(card);
  }

  updateToolbarState();
}

function generateThumbnail(mask) {
  const maskSrc = mask._maskCanvas || mask._decodedImage;
  if (!maskSrc || !sourceImage) return '';

  const w = sourceImage.naturalWidth;
  const h = sourceImage.naturalHeight;

  // Read mask alpha to find tight bounds
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = w;
  fullCanvas.height = h;
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
  fullCtx.drawImage(maskSrc, 0, 0, w, h);
  const fullData = fullCtx.getImageData(0, 0, w, h);

  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // Check alpha channel for white-on-transparent masks
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
    maskCanvas: mask._maskCanvas || null,
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

// --- Feedback ---

function getAuthApiBase() {
  const path = window.location.pathname;
  const parts = path.split('/').filter(Boolean);
  if (parts.length > 1) {
    return '/' + parts.slice(0, -1).join('/') + '/api';
  }
  return '/api';
}

const feedbackBtn = document.getElementById('seg-feedback-btn');
const feedbackModal = document.getElementById('seg-feedback-modal');
const feedbackForm = document.getElementById('seg-feedback-form');
const feedbackCancel = document.getElementById('seg-feedback-cancel');

if (feedbackBtn) {
  feedbackBtn.addEventListener('click', () => {
    document.getElementById('seg-feedback-message').value = '';
    feedbackModal.classList.remove('hidden');
  });
}

if (feedbackCancel) {
  feedbackCancel.addEventListener('click', () => {
    feedbackModal.classList.add('hidden');
  });
}

if (feedbackForm) {
  feedbackForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('seg-feedback-message').value.trim();
    if (!msg) return;
    const btn = document.getElementById('seg-feedback-submit');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      await fetch(`${getAuthApiBase()}/feedback/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ message: msg }),
      });
      feedbackModal.classList.add('hidden');
      alert('Feedback sent!');
    } catch (err) {
      alert('Failed to send feedback');
    }
    btn.disabled = false;
    btn.textContent = 'Send';
  });
}
