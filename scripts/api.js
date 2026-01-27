// API client for RoomDesigner server communication

import {
  getCached,
  setCached,
  invalidateFurnitureCache,
  invalidateHouseCache,
  invalidateRoomCache,
} from './cache.js';

// Detect base path from current URL (handles /room/ prefix when behind nginx proxy)
// /room/ -> /room/api, / -> /api
const BASE_PATH = window.location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/i, '');
const API_BASE = `${BASE_PATH}/api`;

// Adjust server-returned URLs for proxy prefix (e.g., /api/... -> /room/api/...)
export function adjustUrlForProxy(url) {
  if (!url) return url;
  return url.startsWith('/api') ? `${BASE_PATH}${url}` : url;
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    // Handle Pydantic validation errors (detail is an array)
    let message;
    if (Array.isArray(error.detail)) {
      message = error.detail.map(e => `${e.loc?.join('.')}: ${e.msg}`).join('; ');
    } else {
      message = error.detail || `HTTP ${response.status}`;
    }
    throw new Error(message);
  }

  return response;
}

async function fetchAsBlob(url) {
  const response = await fetch(adjustUrlForProxy(url));
  if (!response.ok) return null;
  return response.blob();
}

async function uploadFile(path, blob, filename = 'file') {
  const formData = new FormData();
  formData.append('file', blob, filename);

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }

  return response.json();
}

// ============ Houses ============

export async function getAllHouses(skipCache = false) {
  if (!skipCache) {
    const cached = getCached('houses');
    if (cached) return cached;
  }

  const response = await apiFetch('/houses/');
  const houses = await response.json();

  setCached('houses', houses);
  return houses;
}

export async function getHouse(id) {
  const response = await apiFetch(`/houses/${id}`);
  return response.json();
}

export async function saveHouse(house) {
  const payload = {
    id: house.id,
    name: house.name,
    start_date: house.startDate,
    end_date: house.endDate
  };

  if (house.id) {
    // Check if exists first
    try {
      await apiFetch(`/houses/${house.id}`);
      // Exists, update
      await apiFetch(`/houses/${house.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      invalidateHouseCache();
      return house.id;
    } catch (e) {
      // Doesn't exist, create
    }
  }

  const response = await apiFetch('/houses/', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const created = await response.json();
  invalidateHouseCache();
  return created.id;
}

export async function deleteHouse(id) {
  await apiFetch(`/houses/${id}`, { method: 'DELETE' });
  invalidateHouseCache();
}

// ============ Rooms ============

export async function getAllRooms() {
  const response = await apiFetch('/rooms/');
  const rooms = await response.json();
  return rooms.map(transformRoomResponse);
}

export async function getRoom(roomId) {
  const response = await apiFetch(`/rooms/${roomId}`);
  return response.json();
}

export async function loadRoom(roomId) {
  const response = await apiFetch(`/rooms/${roomId}`);
  const room = await response.json();
  return await transformRoomWithBlobs(room);
}

export async function getRoomsByHouseId(houseId, skipCache = false) {
  const cacheKey = `roomsByHouse:${houseId}`;

  if (!skipCache) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const response = await apiFetch(`/rooms/house/${houseId}`);
  const rooms = await response.json();
  const transformed = rooms.map(transformRoomResponse);

  setCached(cacheKey, transformed);
  return transformed;
}

export async function getOrphanRooms() {
  const response = await apiFetch('/rooms/orphans');
  const rooms = await response.json();
  return rooms.map(transformRoomResponse);
}

/**
 * Create a new room with image upload.
 * Synchronous: waits for mesh generation (30-60 seconds).
 * Returns the completed room or throws error.
 */
export async function createRoom(houseId, name, imageFile) {
  const formData = new FormData();
  formData.append('houseId', houseId);
  formData.append('name', name);
  formData.append('image', imageFile);

  const response = await fetch(`${API_BASE}/rooms/`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(error.detail || `Create room failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Update an existing room.
 */
export async function updateRoom(roomId, updates) {
  const response = await apiFetch(`/rooms/${roomId}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  });
  return response.json();
}

/**
 * Save room state (for existing rooms only).
 * Only sends fields that have actually changed.
 *
 * @param {Object} roomState - Current room state
 * @param {Object} previousState - Previous room state (for comparison, optional)
 * @returns {Promise<string>} Room ID
 */
export async function saveRoom(roomState, previousState = null) {
  if (!roomState.id) {
    throw new Error('Use createRoom() for new rooms');
  }

  // Build payload with only changed fields
  const payload = {};
  let hasChanges = false;

  // Name - always include if provided
  if (roomState.name !== undefined) {
    payload.name = roomState.name;
    hasChanges = true;
  }

  // Placed furniture - compare JSON if previousState provided
  if (roomState.placedFurniture !== undefined) {
    const currentJson = JSON.stringify(roomState.placedFurniture || []);
    const previousJson = previousState ? JSON.stringify(previousState.placedFurniture || []) : null;

    if (!previousState || currentJson !== previousJson) {
      payload.placedFurniture = roomState.placedFurniture || [];
      hasChanges = true;
    }
  }

  // Lighting settings - compare if previousState provided
  if (roomState.lightingSettings !== undefined) {
    const currentJson = JSON.stringify(roomState.lightingSettings || null);
    const previousJson = previousState ? JSON.stringify(previousState.lightingSettings || null) : null;

    if (!previousState || currentJson !== previousJson) {
      payload.lightingSettings = roomState.lightingSettings || null;
      hasChanges = true;
    }
  }

  // NOTE: mogeData intentionally NOT included - it never changes after creation

  // Skip request if nothing changed
  if (!hasChanges) {
    console.log('Room save skipped - no changes detected');
    return roomState.id;
  }

  await apiFetch(`/rooms/${roomState.id}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

  // Invalidate room cache
  invalidateRoomCache(roomState.houseId);

  return roomState.id;
}

export async function deleteRoom(roomId) {
  await apiFetch(`/rooms/${roomId}`, { method: 'DELETE' });
  invalidateRoomCache();
}

function transformRoomResponse(room) {
  return {
    id: room.id,
    houseId: room.houseId,
    name: room.name,
    status: room.status || 'ready',
    errorMessage: room.errorMessage,
    backgroundImageUrl: room.backgroundImageUrl,
    placedFurniture: room.placedFurniture || [],
    mogeData: room.mogeData,
    lightingSettings: room.lightingSettings
  };
}

async function transformRoomWithBlobs(room) {
  const result = transformRoomResponse(room);

  if (room.backgroundImageUrl) {
    result.backgroundImage = await fetchAsBlob(room.backgroundImageUrl);
  }

  return result;
}

// ============ Furniture ============

/**
 * Get all furniture entries.
 * By default returns metadata only (no blob downloads).
 * Use includeImages: true for thumbnail display.
 *
 * @param {Object} options
 * @param {boolean} options.includeImages - Whether to fetch image blobs (default: false)
 * @param {boolean} options.includePreview3d - Whether to fetch 3D preview blobs (default: false)
 * @param {boolean} options.skipCache - Force fresh fetch (default: false)
 * @returns {Promise<Array>} Array of furniture entries
 */
export async function getAllFurniture({ includeImages = false, includePreview3d = false, skipCache = false } = {}) {
  // Check cache for metadata
  if (!skipCache) {
    const cached = getCached('furnitureList');
    if (cached) {
      // If we need blobs and don't have them, fetch them
      if (includeImages || includePreview3d) {
        return await enrichFurnitureWithBlobs(cached, { includeImages, includePreview3d });
      }
      return cached;
    }
  }

  // Fetch metadata from server
  const response = await apiFetch('/furniture/');
  const entries = await response.json();

  // Transform and cache metadata (store original URLs for later blob fetching)
  const transformed = entries.map(entry => {
    const result = transformFurnitureResponse(entry);
    result._imageUrl = entry.imageUrl;
    result._preview3dUrl = entry.preview3dUrl;
    result._modelUrl = entry.modelUrl;
    return result;
  });
  setCached('furnitureList', transformed);

  // Also cache individual entries
  for (const entry of transformed) {
    setCached(`furnitureEntry:${entry.id}`, entry);
  }

  // Fetch blobs if requested
  if (includeImages || includePreview3d) {
    return await enrichFurnitureWithBlobs(transformed, { includeImages, includePreview3d });
  }

  return transformed;
}

/**
 * Enrich furniture entries with binary blobs.
 * Fetches in parallel with concurrency limit.
 */
async function enrichFurnitureWithBlobs(entries, { includeImages = false, includePreview3d = false }) {
  const CONCURRENT_FETCHES = 6;
  const results = entries.map(e => ({ ...e }));

  const fetchTasks = [];

  for (let i = 0; i < results.length; i++) {
    const entry = results[i];

    if (includeImages && entry._imageUrl && !entry.image) {
      fetchTasks.push({
        index: i,
        type: 'image',
        url: entry._imageUrl,
      });
    }

    if (includePreview3d && entry._preview3dUrl && !entry.preview3d) {
      fetchTasks.push({
        index: i,
        type: 'preview3d',
        url: entry._preview3dUrl,
      });
    }
  }

  // Process in batches
  for (let i = 0; i < fetchTasks.length; i += CONCURRENT_FETCHES) {
    const batch = fetchTasks.slice(i, i + CONCURRENT_FETCHES);
    const blobPromises = batch.map(async task => {
      const blob = await fetchAsBlob(task.url);
      return { ...task, blob };
    });

    const blobResults = await Promise.all(blobPromises);

    for (const result of blobResults) {
      if (result.blob) {
        results[result.index][result.type] = result.blob;
      }
    }
  }

  return results;
}

/**
 * Get a single furniture entry by ID.
 *
 * @param {string} id - Furniture entry ID
 * @param {Object} options
 * @param {boolean} options.includeImage - Fetch image blob (default: true for backwards compat)
 * @param {boolean} options.includePreview3d - Fetch 3D preview blob (default: true)
 * @param {boolean} options.includeModel - Fetch model blob (default: true)
 * @param {boolean} options.metadataOnly - Only fetch metadata, no blobs (default: false)
 * @param {boolean} options.skipCache - Force fresh fetch (default: false)
 * @returns {Promise<Object>} Furniture entry
 */
export async function getFurnitureEntry(id, {
  includeImage = true,
  includePreview3d = true,
  includeModel = true,
  metadataOnly = false,
  skipCache = false,
} = {}) {
  // Check cache for metadata
  const cacheKey = `furnitureEntry:${id}`;
  let entry = skipCache ? null : getCached(cacheKey);

  if (!entry) {
    // Fetch metadata from server
    const response = await apiFetch(`/furniture/${id}`);
    const data = await response.json();
    entry = transformFurnitureResponse(data);

    // Store raw URLs for blob fetching
    entry._imageUrl = data.imageUrl;
    entry._preview3dUrl = data.preview3dUrl;
    entry._modelUrl = data.modelUrl;

    setCached(cacheKey, entry);
  }

  // Return metadata only if requested
  if (metadataOnly) {
    return entry;
  }

  // Fetch blobs as needed
  const result = { ...entry };

  if (includeImage && entry._imageUrl && !result.image) {
    result.image = await fetchAsBlob(entry._imageUrl);
  }

  if (includePreview3d && entry._preview3dUrl && !result.preview3d) {
    result.preview3d = await fetchAsBlob(entry._preview3dUrl);
  }

  if (includeModel && entry._modelUrl && !result.model) {
    result.model = await fetchAsBlob(entry._modelUrl);
  }

  return result;
}

export async function saveFurnitureEntry(entry) {
  const payload = {
    id: entry.id || null,
    name: entry.name,
    category: entry.category || null,
    tags: entry.tags || null,
    quantity: entry.quantity || 1,
    dimensionX: entry.dimensionX || null,
    dimensionY: entry.dimensionY || null,
    dimensionZ: entry.dimensionZ || null
  };

  let entryId;

  if (entry.id) {
    // Existing entry, update
    await apiFetch(`/furniture/${entry.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    entryId = entry.id;
  } else {
    // New entry, create (server generates ID)
    const response = await apiFetch('/furniture/', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const created = await response.json();
    entryId = created.id;
  }

  // Upload files
  if (entry.image instanceof Blob) {
    await uploadFile(`/files/furniture/${entryId}/image`, entry.image, 'image.jpg');
  }
  if (entry.preview3d instanceof Blob) {
    await uploadFile(`/files/furniture/${entryId}/preview3d`, entry.preview3d, 'preview3d.png');
  }
  if (entry.model instanceof Blob) {
    await uploadFile(`/files/furniture/${entryId}/model`, entry.model, 'model.glb');
  }

  // Invalidate caches after save
  invalidateFurnitureCache();

  return entryId;
}

export async function deleteFurnitureEntry(id) {
  await apiFetch(`/furniture/${id}`, { method: 'DELETE' });
  invalidateFurnitureCache();
}

export async function getAllCategories(skipCache = false) {
  if (!skipCache) {
    const cached = getCached('categories');
    if (cached) return cached;
  }

  const response = await apiFetch('/furniture/categories');
  const categories = await response.json();

  setCached('categories', categories);
  return categories;
}

export async function getAllTags(skipCache = false) {
  if (!skipCache) {
    const cached = getCached('tags');
    if (cached) return cached;
  }

  const response = await apiFetch('/furniture/tags');
  const tags = await response.json();

  setCached('tags', tags);
  return tags;
}

/**
 * Batch fetch availability for multiple furniture entries.
 * Replaces N calls to getAvailableQuantity with a single server call.
 *
 * @param {string[]} entryIds - Array of furniture entry IDs
 * @param {string} currentHouseId - Current house ID for overlap calculation
 * @param {string} currentRoomId - Current room ID to exclude from counts
 * @param {Object} currentRoomPlacedCounts - Map of entryId -> count already placed in scene
 * @returns {Object} Map of entryId -> { available, total }
 */
export async function getBatchAvailability(entryIds, currentHouseId, currentRoomId, currentRoomPlacedCounts = {}) {
  if (!entryIds || entryIds.length === 0) {
    return {};
  }

  // Check cache first
  const cacheKey = `availability:${currentHouseId || 'none'}:${currentRoomId || 'none'}`;
  const cached = getCached(cacheKey, 'derived');

  // If we have a cached result and it includes all requested IDs, use it
  if (cached && entryIds.every(id => cached.hasOwnProperty(id))) {
    // Adjust for current room placed counts (not in cache)
    const result = {};
    for (const id of entryIds) {
      const placedInScene = currentRoomPlacedCounts[id] || 0;
      result[id] = {
        available: Math.max(0, cached[id].available - placedInScene),
        total: cached[id].total,
      };
    }
    return result;
  }

  // Fetch from server
  const response = await apiFetch('/furniture/availability', {
    method: 'POST',
    body: JSON.stringify({
      entryIds,
      currentHouseId,
      currentRoomId,
    }),
  });

  const serverResult = await response.json();

  // Cache the server result (before adjusting for current room)
  setCached(cacheKey, serverResult, 'derived');

  // Adjust for current room placed counts
  const result = {};
  for (const id of entryIds) {
    const placedInScene = currentRoomPlacedCounts[id] || 0;
    const entry = serverResult[id] || { available: 0, total: 0 };
    result[id] = {
      available: Math.max(0, entry.available - placedInScene),
      total: entry.total,
    };
  }

  return result;
}

function transformFurnitureResponse(entry) {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    tags: entry.tags,
    quantity: entry.quantity,
    dimensionX: entry.dimensionX,
    dimensionY: entry.dimensionY,
    dimensionZ: entry.dimensionZ,
    hasModel: !!entry.modelUrl
  };
}

// ============ Server-Sent Events ============

let eventSource = null;
const eventListeners = new Map();

export function subscribeToEvents(callback) {
  if (!eventSource) {
    eventSource = new EventSource(`${API_BASE}/events`);

    eventSource.addEventListener('preview3d_ready', (e) => {
      const data = JSON.parse(e.data);
      eventListeners.forEach((cb) => cb('preview3d_ready', data));
    });

    eventSource.addEventListener('preview3d_failed', (e) => {
      const data = JSON.parse(e.data);
      eventListeners.forEach((cb) => cb('preview3d_failed', data));
    });

    eventSource.onerror = () => {
      // Reconnect on error after delay
      eventSource.close();
      eventSource = null;
      setTimeout(() => {
        if (eventListeners.size > 0) {
          subscribeToEvents(callback);
        }
      }, 3000);
    };
  }

  const id = Symbol();
  eventListeners.set(id, callback);

  return () => {
    eventListeners.delete(id);
    if (eventListeners.size === 0 && eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}

export async function getFurniturePreview3d(id) {
  const url = `${API_BASE}/files/furniture/${id}/preview3d`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.blob();
}

