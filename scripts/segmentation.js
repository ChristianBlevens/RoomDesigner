/**
 * Furniture Segmentation Tool
 *
 * Upload -> create objects -> tap points per object -> segment -> review -> export
 * Stateless: nothing persisted. Closing the tab loses all state.
 */

import { exportSegments } from './segmentation-export.js';

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

    // Select on click (but not on input or button)
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      selectObject(obj.id);
    });

    // Name editing
    const nameInput = card.querySelector('.seg-obj-name');
    nameInput.addEventListener('input', () => {
      obj.name = nameInput.value;
    });
    nameInput.addEventListener('click', (e) => {
      e.stopPropagation();
      selectObject(obj.id);
    });

    // Remove button
    card.querySelector('.seg-card-btn.remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeObject(obj.id);
    });

    objectList.appendChild(card);
  }

  updateToolbarState();
}

// --- Canvas rendering ---

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
      const alpha = isHighlighted ? 160 : 80;
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
          maskData.data[i + 3] = alpha;
        } else {
          maskData.data[i + 3] = 0;
        }
      }
      offCtx.putImageData(maskData, 0, 0);
      ctx.drawImage(off, 0, 0);

      if (isHighlighted) {
        const edgeData = offCtx.createImageData(canvas.width, canvas.height);
        const w = canvas.width;
        for (let py = 1; py < canvas.height - 1; py++) {
          for (let px = 1; px < w - 1; px++) {
            const idx = (py * w + px) * 4;
            if (maskData.data[idx] > 128) {
              const up = ((py - 1) * w + px) * 4;
              const dn = ((py + 1) * w + px) * 4;
              const lt = (py * w + (px - 1)) * 4;
              const rt = (py * w + (px + 1)) * 4;
              if (maskData.data[up] <= 128 || maskData.data[dn] <= 128 ||
                  maskData.data[lt] <= 128 || maskData.data[rt] <= 128) {
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
        // Outer ring
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth = isSelected ? 3 : 2;
        ctx.stroke();

        // Inner fill with object color
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
  // Check all objects' points, return {objectId, pointIdx} or null
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

canvas.addEventListener('pointerdown', (e) => {
  if (!sourceImage || hasResults()) return;

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

  if (hasResults()) {
    canvas.style.cursor = 'default';
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
  if (hasResults()) return;

  if (draggingPoint) {
    canvas.releasePointerCapture(e.pointerId);
    draggingPoint = null;
    canvas.style.cursor = 'crosshair';
    e.preventDefault();
    // Update point count in object list
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
    pointCount.textContent = `${masks.length} segment${masks.length !== 1 ? 's' : ''} found`;
    btnUndoPoint.classList.add('hidden');
    btnSegment.classList.add('hidden');
    btnReset.classList.remove('hidden');
    objectPanel.classList.add('hidden');
    resultPanel.classList.remove('hidden');
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

// --- Segmentation API call ---

btnSegment.addEventListener('click', async () => {
  if (!sourceImageBytes || totalPoints() === 0) return;

  processing.classList.remove('hidden');
  btnSegment.disabled = true;

  try {
    const imageB64 = arrayBufferToBase64(sourceImageBytes);

    // Send grouped points: each object's points as a group
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

    // Decode mask PNGs into Image elements
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
    resultPanel.classList.add('hidden');
    return;
  }

  resultPanel.classList.remove('hidden');
  objectPanel.classList.add('hidden');
  resultCount.textContent = String(masks.length);
  resultList.innerHTML = '';

  for (const mask of masks) {
    const card = document.createElement('div');
    card.className = `seg-card${rejected.has(mask.id) ? ' rejected' : ''}`;
    card.dataset.maskId = mask.id;

    const thumbUrl = generateThumbnail(mask);
    const color = MASK_COLORS[mask.id % MASK_COLORS.length];
    card.style.borderLeftWidth = '3px';
    card.style.borderLeftColor = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

    // Use object name if available
    const defaultName = mask.name || `item_${mask.id + 1}`;

    card.innerHTML = `
      <img class="seg-card-thumb" src="${thumbUrl}" alt="Segment ${mask.id + 1}">
      <div class="seg-card-info">
        <input class="seg-card-name" type="text" value="${defaultName}" spellcheck="false">
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
      }
      drawCanvas();
      renderResults();
    });

    mask._nameInput = card.querySelector('.seg-card-name');

    resultList.appendChild(card);
  }

  updateToolbarState();
}

function generateThumbnail(mask) {
  if (!mask._decodedImage || !sourceImage) return '';

  const bbox = mask.bbox;
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
