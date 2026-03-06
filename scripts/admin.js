// Admin panel main module

import { getToken, logout, isAdmin } from './auth.js';
import { loadRoom, loadFurniture, disposeViewer } from './admin-viewer.js';

const BASE_PATH = window.location.pathname.replace(/\/admin\.html$/i, '').replace(/\/+$/, '');
const API_BASE = `${BASE_PATH}/api/admin`;

let currentTab = 'orgs';
let orgList = []; // cached for filter dropdown

// ============ Auth Gate ============

function checkAuth() {
  if (!getToken() || !isAdmin()) {
    window.location.href = `${BASE_PATH}/`;
    return false;
  }
  return true;
}

// ============ API Helpers ============

async function adminFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  headers['Authorization'] = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (response.status === 401 || response.status === 403) {
    logout();
    return null;
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: 'Request failed' }));
    throw new Error(err.detail || `HTTP ${response.status}`);
  }
  return response.json();
}

function apiGet(path) { return adminFetch(path); }
function apiPut(path, body) { return adminFetch(path, { method: 'PUT', body: JSON.stringify(body) }); }
function apiDelete(path) { return adminFetch(path, { method: 'DELETE' }); }
function apiPost(path, body) {
  const opts = { method: 'POST' };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    opts.body = JSON.stringify(body);
  }
  return adminFetch(path, opts);
}

// ============ Toast ============

function showToast(message, duration = 3000) {
  const toast = document.getElementById('admin-toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

// ============ Confirm Dialog ============

function confirm(message) {
  return new Promise(resolve => {
    const el = document.getElementById('admin-confirm');
    document.getElementById('admin-confirm-message').textContent = message;
    el.classList.remove('hidden');

    const ok = document.getElementById('admin-confirm-ok');
    const cancel = document.getElementById('admin-confirm-cancel');

    function cleanup() {
      el.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

// ============ Tab Switching ============

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.getElementById('admin-search').value = '';
  hideDetail();
  updateExtraFilters();
  loadTabData();
}

function updateExtraFilters() {
  const container = document.getElementById('admin-extra-filters');
  container.innerHTML = '';

  if (currentTab === 'houses') {
    const startInput = document.createElement('input');
    startInput.type = 'date';
    startInput.className = 'admin-filter';
    startInput.id = 'admin-filter-start';
    startInput.title = 'Start date from';
    startInput.addEventListener('change', () => loadTabData());
    container.appendChild(startInput);

    const endInput = document.createElement('input');
    endInput.type = 'date';
    endInput.className = 'admin-filter';
    endInput.id = 'admin-filter-end';
    endInput.title = 'End date to';
    endInput.addEventListener('change', () => loadTabData());
    container.appendChild(endInput);
  }

  if (currentTab === 'furniture') {
    const select = document.createElement('select');
    select.className = 'admin-filter';
    select.innerHTML = `
      <option value="">Has Model?</option>
      <option value="true">Has Model</option>
      <option value="false">No Model</option>
    `;
    select.addEventListener('change', () => loadTabData());
    select.id = 'admin-filter-model';
    container.appendChild(select);
  }

  if (currentTab === 'meshy') {
    const select = document.createElement('select');
    select.className = 'admin-filter';
    select.innerHTML = `
      <option value="">All Status</option>
      <option value="pending">Pending</option>
      <option value="creating">Creating</option>
      <option value="polling">Polling</option>
      <option value="downloading">Downloading</option>
      <option value="completed">Completed</option>
      <option value="failed">Failed</option>
    `;
    select.addEventListener('change', () => loadTabData());
    select.id = 'admin-filter-status';
    container.appendChild(select);
  }
}

// ============ Table Rendering ============

const TAB_COLUMNS = {
  orgs: ['Username', 'Houses', 'Furniture', 'Created'],
  houses: ['Name', 'Org', 'Dates', 'Rooms', 'Created'],
  rooms: ['Name', 'House', 'Org', 'Status', 'Furniture'],
  furniture: ['Name', 'Org', 'Category', 'Qty', 'Image', 'Model'],
  meshy: ['Furniture', 'Org', 'Status', 'Progress', 'Retries', 'Created'],
};

function renderTable(columns, rows) {
  const thead = document.getElementById('admin-thead');
  const tbody = document.getElementById('admin-tbody');
  const empty = document.getElementById('admin-empty');

  thead.innerHTML = '<tr>' + columns.map(c => `<th>${c}</th>`).join('') + '<th>Actions</th></tr>';

  if (rows.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = rows.map(row => `
    <tr data-id="${row.id}">
      ${row.cells.map(c => `<td>${c}</td>`).join('')}
      <td class="admin-actions">${row.actions}</td>
    </tr>
  `).join('');
}

function badge(text, type = '') {
  return `<span class="admin-badge ${type}">${text}</span>`;
}

function actionBtn(label, cls, onclick) {
  return `<button class="admin-action-btn ${cls}" onclick="${onclick}">${label}</button>`;
}

// ============ Tab Data Loading ============

async function loadTabData() {
  const q = document.getElementById('admin-search').value.trim();
  const orgFilter = document.getElementById('admin-filter-org').value;

  let params = new URLSearchParams();
  if (q) params.set('q', q);
  if (orgFilter) params.set('org_id', orgFilter);

  try {
    if (currentTab === 'orgs') {
      const data = await apiGet(`/orgs?${params}`);
      renderTable(TAB_COLUMNS.orgs, data.map(o => ({
        id: o.id,
        cells: [o.username, o.houseCount, o.furnitureCount, o.createdAt?.split('T')[0] || ''],
        actions: actionBtn('View', 'btn-secondary', `window._adminDetail('org','${o.id}')`)
          + actionBtn('Delete', 'btn-danger', `window._adminDeleteOrg('${o.id}','${o.username}')`)
      })));
    }

    else if (currentTab === 'houses') {
      const startFilter = document.getElementById('admin-filter-start');
      const endFilter = document.getElementById('admin-filter-end');
      if (startFilter && startFilter.value) params.set('start_after', startFilter.value);
      if (endFilter && endFilter.value) params.set('end_before', endFilter.value);

      const data = await apiGet(`/houses?${params}`);
      renderTable(TAB_COLUMNS.houses, data.map(h => ({
        id: h.id,
        cells: [h.name, h.orgUsername, `${h.startDate || ''} - ${h.endDate || ''}`, h.roomCount, h.createdAt?.split('T')[0] || ''],
        actions: actionBtn('View', 'btn-secondary', `window._adminDetail('house','${h.id}')`)
          + actionBtn('Delete', 'btn-danger', `window._adminDeleteHouse('${h.id}','${h.name}')`)
      })));
    }

    else if (currentTab === 'rooms') {
      const data = await apiGet(`/rooms?${params}`);
      renderTable(TAB_COLUMNS.rooms, data.map(r => ({
        id: r.id,
        cells: [
          r.name, r.houseName, r.orgUsername,
          badge(r.status, r.status === 'ready' ? 'success' : 'warning'),
          r.furnitureCount
        ],
        actions: actionBtn('View', 'btn-secondary', `window._adminDetail('room','${r.id}')`)
          + actionBtn('Delete', 'btn-danger', `window._adminDeleteRoom('${r.id}','${r.name}')`)
      })));
    }

    else if (currentTab === 'furniture') {
      const modelFilter = document.getElementById('admin-filter-model');
      if (modelFilter && modelFilter.value) params.set('has_model', modelFilter.value);

      const data = await apiGet(`/furniture?${params}`);
      renderTable(TAB_COLUMNS.furniture, data.map(f => ({
        id: f.id,
        cells: [
          f.name, f.orgUsername, f.category || '-', f.quantity,
          f.hasImage ? badge('Yes', 'success') : badge('No', 'warning'),
          f.hasModel ? badge('Yes', 'success') : badge('No', 'warning'),
        ],
        actions: actionBtn('View', 'btn-secondary', `window._adminDetail('furniture','${f.id}')`)
          + actionBtn('Delete', 'btn-danger', `window._adminDeleteFurniture('${f.id}','${f.name}')`)
      })));
    }

    else if (currentTab === 'meshy') {
      const statusFilter = document.getElementById('admin-filter-status');
      if (statusFilter && statusFilter.value) params.set('status', statusFilter.value);

      const data = await apiGet(`/meshy-tasks?${params}`);
      renderTable(TAB_COLUMNS.meshy, data.map(t => ({
        id: t.id,
        cells: [
          t.furnitureName, t.orgUsername,
          badge(t.status, t.status === 'completed' ? 'success' : t.status === 'failed' ? 'danger' : ''),
          `${t.progress}%`, t.retryCount,
          t.createdAt?.split('T')[0] || ''
        ],
        actions: actionBtn('Delete', 'btn-danger', `window._adminDeleteTask('${t.id}')`)
      })));
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 5000);
  }
}

// ============ Detail Panel ============

function showDetail(title, html) {
  document.getElementById('admin-detail-title').textContent = title;
  document.getElementById('admin-detail-content').innerHTML = html;
  document.getElementById('admin-detail').classList.remove('hidden');
}

function hideDetail() {
  document.getElementById('admin-detail').classList.add('hidden');
}

async function showOrgDetail(orgId) {
  const houses = await apiGet(`/houses?org_id=${orgId}`);
  const furniture = await apiGet(`/furniture?org_id=${orgId}`);

  const org = orgList.find(o => o.id === orgId);
  const name = org ? org.username : orgId;

  showDetail(`Org: ${name}`, `
    <div class="detail-section">
      <h3>ID</h3>
      <p class="detail-mono">${orgId}</p>
    </div>
    <div class="detail-section">
      <h3>Houses (${houses.length})</h3>
      ${houses.map(h => `
        <div class="detail-item" onclick="window._adminDetail('house','${h.id}')">
          <span>${h.name}</span>
          <span class="detail-sub">${h.roomCount} rooms</span>
        </div>
      `).join('') || '<p class="detail-sub">No houses</p>'}
    </div>
    <div class="detail-section">
      <h3>Furniture (${furniture.length})</h3>
      <p class="detail-sub">${furniture.filter(f => f.hasModel).length} with models, ${furniture.filter(f => f.hasImage).length} with images</p>
    </div>
  `);
}

async function showHouseDetail(houseId) {
  const data = await apiGet(`/houses/${houseId}`);

  showDetail(`House: ${data.name}`, `
    <div class="detail-section">
      <h3>ID</h3>
      <p class="detail-mono">${data.id}</p>
    </div>
    <form id="detail-edit-house" class="detail-form">
      <div class="form-group">
        <label>Name</label>
        <input type="text" name="name" value="${data.name}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Start Date</label>
          <input type="date" name="startDate" value="${data.startDate || ''}">
        </div>
        <div class="form-group">
          <label>End Date</label>
          <input type="date" name="endDate" value="${data.endDate || ''}">
        </div>
      </div>
      <button type="submit" class="btn-primary">Save Changes</button>
    </form>
    <div class="detail-section">
      <h3>Rooms (${data.rooms.length})</h3>
      ${data.rooms.map(r => `
        <div class="detail-item" onclick="window._adminDetail('room','${r.id}')">
          ${r.backgroundUrl ? `<img src="${r.backgroundUrl}" class="detail-thumb">` : ''}
          <div>
            <span>${r.name}</span>
            <span class="detail-sub">${r.status}${r.errorMessage ? ' - ' + r.errorMessage : ''}</span>
          </div>
        </div>
      `).join('') || '<p class="detail-sub">No rooms</p>'}
    </div>
  `);

  document.getElementById('detail-edit-house').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    await apiPut(`/houses/${houseId}`, Object.fromEntries(form));
    showToast('House updated');
    loadTabData();
  });
}

async function showRoomDetail(roomId) {
  const data = await apiGet(`/rooms/${roomId}`);

  showDetail(`Room: ${data.name}`, `
    <div class="detail-section">
      <h3>ID</h3>
      <p class="detail-mono">${data.id}</p>
      <p class="detail-sub">House: ${data.houseName} | Status: ${data.status}</p>
      ${data.errorMessage ? `<p class="detail-error">${data.errorMessage}</p>` : ''}
    </div>

    <div class="detail-section">
      <h3>Background Image</h3>
      ${data.backgroundUrl
        ? `<img src="${data.backgroundUrl}" class="detail-preview-img">`
        : '<p class="detail-sub">No background image</p>'}
      <div class="detail-actions">
        <label class="btn-secondary detail-upload-btn">
          Re-upload Background
          <input type="file" accept="image/*" id="detail-reupload-bg" hidden>
        </label>
      </div>
    </div>

    <div class="detail-section">
      <h3>Room Mesh</h3>
      <div class="detail-actions">
        ${data.mogeData ? `
          <button class="btn-secondary" id="detail-view-mesh">View Mesh + Photo</button>
          <button class="btn-primary" id="detail-regen-mesh">Regenerate Mesh</button>
        ` : `
          <p class="detail-sub">No mesh data</p>
          ${data.backgroundUrl ? `<button class="btn-primary" id="detail-regen-mesh">Generate Mesh</button>` : ''}
        `}
      </div>
    </div>

    <div class="detail-section">
      <h3>Placed Furniture (${data.placedFurniture.length})</h3>
      ${data.placedFurniture.length > 0 ? `
        <div class="detail-furniture-list">
          ${data.placedFurniture.map(f => `
            <div class="detail-item">
              <span>Entry: ${f.entryId || 'unknown'}</span>
              <span class="detail-sub">Pos: [${(f.position || []).map(v => v.toFixed(2)).join(', ')}]</span>
            </div>
          `).join('')}
        </div>
      ` : '<p class="detail-sub">No furniture placed</p>'}
    </div>

    <div class="detail-section">
      <h3>Settings</h3>
      <p class="detail-sub">Scale: ${data.roomScale}</p>
      ${data.lightingSettings ? `<p class="detail-sub">Lighting: intensity ${data.lightingSettings.intensity}, temp ${data.lightingSettings.temperature}K</p>` : ''}
    </div>
  `);

  // Wire up mesh viewer button
  const viewMeshBtn = document.getElementById('detail-view-mesh');
  if (viewMeshBtn && data.mogeData) {
    viewMeshBtn.addEventListener('click', () => {
      openViewer('Room Mesh: ' + data.name, () => {
        const canvas = document.getElementById('admin-viewer-canvas');
        loadRoom(canvas, data.meshUrl, data.backgroundUrl, data.mogeData);
      });
    });
  }

  // Wire up regenerate mesh button
  const regenBtn = document.getElementById('detail-regen-mesh');
  if (regenBtn) {
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true;
      regenBtn.textContent = 'Processing...';
      try {
        await apiPost(`/rooms/${roomId}/regenerate-mesh`);
        showToast('Mesh regenerated');
        showRoomDetail(roomId);
      } catch (err) {
        showToast(`Error: ${err.message}`, 5000);
        regenBtn.disabled = false;
        regenBtn.textContent = 'Regenerate Mesh';
      }
    });
  }

  // Wire up background re-upload
  const bgInput = document.getElementById('detail-reupload-bg');
  if (bgInput) {
    bgInput.addEventListener('change', async () => {
      if (!bgInput.files.length) return;
      const form = new FormData();
      form.append('file', bgInput.files[0]);
      try {
        await apiPost(`/rooms/${roomId}/reupload-background`, form);
        showToast('Background uploaded');
        showRoomDetail(roomId);
      } catch (err) {
        showToast(`Error: ${err.message}`, 5000);
      }
    });
  }
}

async function showFurnitureDetail(furnitureId) {
  const data = await apiGet(`/furniture/${furnitureId}`);

  showDetail(`Furniture: ${data.name}`, `
    <div class="detail-section">
      <h3>ID</h3>
      <p class="detail-mono">${data.id}</p>
      <p class="detail-sub">Org: ${data.orgId}</p>
    </div>

    <form id="detail-edit-furniture" class="detail-form">
      <div class="form-group">
        <label>Name</label>
        <input type="text" name="name" value="${data.name}">
      </div>
      <div class="form-group">
        <label>Category</label>
        <input type="text" name="category" value="${data.category || ''}">
      </div>
      <div class="form-group">
        <label>Quantity</label>
        <input type="number" name="quantity" value="${data.quantity}" min="0">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>X (m)</label>
          <input type="number" name="dimensionX" value="${data.dimensionX || ''}" step="0.01">
        </div>
        <div class="form-group">
          <label>Y (m)</label>
          <input type="number" name="dimensionY" value="${data.dimensionY || ''}" step="0.01">
        </div>
        <div class="form-group">
          <label>Z (m)</label>
          <input type="number" name="dimensionZ" value="${data.dimensionZ || ''}" step="0.01">
        </div>
      </div>
      <button type="submit" class="btn-primary">Save Changes</button>
    </form>

    <div class="detail-section">
      <h3>Image</h3>
      ${data.imageUrl
        ? `<img src="${data.imageUrl}" class="detail-preview-img">`
        : '<p class="detail-sub">No image</p>'}
      <div class="detail-actions">
        <label class="btn-secondary detail-upload-btn">
          Re-upload Image
          <input type="file" accept="image/*" id="detail-reupload-image" hidden>
        </label>
        ${data.imageUrl ? `<button class="btn-danger" id="detail-delete-image">Delete Image</button>` : ''}
      </div>
    </div>

    <div class="detail-section">
      <h3>3D Model</h3>
      ${data.modelUrl
        ? `<button class="btn-secondary" id="detail-view-model">View 3D Model</button>`
        : '<p class="detail-sub">No model</p>'}
      <div class="detail-actions">
        <label class="btn-secondary detail-upload-btn">
          Re-upload Model (.glb)
          <input type="file" accept=".glb" id="detail-reupload-model" hidden>
        </label>
        ${data.imageUrl ? `<button class="btn-primary" id="detail-regen-model">Regenerate 3D Model</button>` : ''}
        ${data.modelUrl ? `<button class="btn-danger" id="detail-delete-model">Delete Model</button>` : ''}
      </div>
    </div>

    ${data.preview3dUrl ? `
      <div class="detail-section">
        <h3>3D Preview</h3>
        <img src="${data.preview3dUrl}" class="detail-preview-img">
      </div>
    ` : ''}
  `);

  // Save form
  document.getElementById('detail-edit-furniture').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const body = {};
    for (const [key, value] of form) {
      if (key === 'quantity') body[key] = parseInt(value) || 1;
      else if (key.startsWith('dimension')) body[key] = value ? parseFloat(value) : null;
      else body[key] = value || null;
    }
    await apiPut(`/furniture/${furnitureId}`, body);
    showToast('Furniture updated');
    loadTabData();
  });

  // View model
  const viewBtn = document.getElementById('detail-view-model');
  if (viewBtn && data.modelUrl) {
    viewBtn.addEventListener('click', () => {
      openViewer('Model: ' + data.name, () => {
        const canvas = document.getElementById('admin-viewer-canvas');
        loadFurniture(canvas, data.modelUrl);
      });
    });
  }

  // Re-upload image
  const imgInput = document.getElementById('detail-reupload-image');
  if (imgInput) {
    imgInput.addEventListener('change', async () => {
      if (!imgInput.files.length) return;
      const form = new FormData();
      form.append('file', imgInput.files[0]);
      await apiPost(`/furniture/${furnitureId}/reupload-image`, form);
      showToast('Image uploaded');
      showFurnitureDetail(furnitureId);
    });
  }

  // Re-upload model
  const modelInput = document.getElementById('detail-reupload-model');
  if (modelInput) {
    modelInput.addEventListener('change', async () => {
      if (!modelInput.files.length) return;
      const form = new FormData();
      form.append('file', modelInput.files[0]);
      await apiPost(`/furniture/${furnitureId}/reupload-model`, form);
      showToast('Model uploaded');
      showFurnitureDetail(furnitureId);
    });
  }

  // Delete image
  const delImgBtn = document.getElementById('detail-delete-image');
  if (delImgBtn) {
    delImgBtn.addEventListener('click', async () => {
      if (await confirm('Delete this image?')) {
        await apiDelete(`/furniture/${furnitureId}/image`);
        showToast('Image deleted');
        showFurnitureDetail(furnitureId);
      }
    });
  }

  // Delete model
  const delModelBtn = document.getElementById('detail-delete-model');
  if (delModelBtn) {
    delModelBtn.addEventListener('click', async () => {
      if (await confirm('Delete this 3D model?')) {
        await apiDelete(`/furniture/${furnitureId}/model`);
        showToast('Model deleted');
        showFurnitureDetail(furnitureId);
      }
    });
  }

  // Regenerate model
  const regenBtn = document.getElementById('detail-regen-model');
  if (regenBtn) {
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true;
      regenBtn.textContent = 'Starting...';
      try {
        const result = await apiPost(`/furniture/${furnitureId}/regenerate-model`);
        showToast(`Meshy task started: ${result.taskId}`);
      } catch (err) {
        showToast(`Error: ${err.message}`, 5000);
      }
      regenBtn.disabled = false;
      regenBtn.textContent = 'Regenerate 3D Model';
    });
  }
}

// ============ 3D Viewer Modal ============

function openViewer(title, loadFn) {
  document.getElementById('admin-viewer-title').textContent = title;
  document.getElementById('admin-viewer-modal').classList.remove('hidden');
  loadFn();
}

function closeViewer() {
  disposeViewer();
  document.getElementById('admin-viewer-modal').classList.add('hidden');
}

// ============ Global Action Handlers ============

window._adminDetail = async (type, id) => {
  try {
    if (type === 'org') await showOrgDetail(id);
    else if (type === 'house') await showHouseDetail(id);
    else if (type === 'room') await showRoomDetail(id);
    else if (type === 'furniture') await showFurnitureDetail(id);
  } catch (err) {
    showToast(`Error: ${err.message}`, 5000);
  }
};

window._adminDeleteOrg = async (id, name) => {
  if (await confirm(`Delete org "${name}" and ALL their data? This cannot be undone.`)) {
    await apiDelete(`/orgs/${id}`);
    showToast('Org deleted');
    hideDetail();
    loadTabData();
  }
};

window._adminDeleteHouse = async (id, name) => {
  if (await confirm(`Delete house "${name}" and all its rooms?`)) {
    await apiDelete(`/houses/${id}`);
    showToast('House deleted');
    hideDetail();
    loadTabData();
  }
};

window._adminDeleteRoom = async (id, name) => {
  if (await confirm(`Delete room "${name}"?`)) {
    await apiDelete(`/rooms/${id}`);
    showToast('Room deleted');
    hideDetail();
    loadTabData();
  }
};

window._adminDeleteFurniture = async (id, name) => {
  if (await confirm(`Delete furniture "${name}" and all its files?`)) {
    await apiDelete(`/furniture/${id}`);
    showToast('Furniture deleted');
    hideDetail();
    loadTabData();
  }
};

window._adminDeleteTask = async (id) => {
  if (await confirm('Delete this Meshy task?')) {
    await apiDelete(`/meshy-tasks/${id}`);
    showToast('Task deleted');
    loadTabData();
  }
};

// ============ Org Filter Dropdown ============

async function loadOrgFilter() {
  try {
    orgList = await apiGet('/orgs');
    const select = document.getElementById('admin-filter-org');
    select.innerHTML = '<option value="">All Orgs</option>'
      + orgList.map(o => `<option value="${o.id}">${o.username}</option>`).join('');
  } catch (_) {
    // Non-critical
  }
}

// ============ Init ============

function init() {
  if (!checkAuth()) return;

  // Tab clicks
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Search (debounced)
  let searchTimeout;
  document.getElementById('admin-search').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadTabData, 300);
  });

  // Org filter
  document.getElementById('admin-filter-org').addEventListener('change', loadTabData);

  // Detail close
  document.getElementById('admin-detail-close').addEventListener('click', hideDetail);

  // Viewer close
  document.getElementById('admin-viewer-close').addEventListener('click', closeViewer);

  // Sign out
  document.getElementById('admin-signout-btn').addEventListener('click', logout);

  // Load initial data
  loadOrgFilter();
  updateExtraFilters();
  loadTabData();
}

init();
