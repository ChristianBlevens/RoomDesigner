// API client for RoomDesigner server communication

// Detect base path from current URL (handles /room/ prefix when behind nginx proxy)
// /room/ -> /room/api, / -> /api
const BASE_PATH = window.location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/i, '');
const API_BASE = `${BASE_PATH}/api`;

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
    throw new Error(error.detail || `HTTP ${response.status}`);
  }

  return response;
}

async function fetchAsBlob(url) {
  const response = await fetch(url);
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

export async function getAllHouses() {
  const response = await apiFetch('/houses/');
  return response.json();
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
  return created.id;
}

export async function deleteHouse(id) {
  await apiFetch(`/houses/${id}`, { method: 'DELETE' });
}

// ============ Rooms ============

export async function getAllRooms() {
  const response = await apiFetch('/rooms/');
  const rooms = await response.json();
  return rooms.map(transformRoomResponse);
}

export async function loadRoom(roomId) {
  const response = await apiFetch(`/rooms/${roomId}`);
  const room = await response.json();
  return await transformRoomWithBlobs(room);
}

export async function getRoomsByHouseId(houseId) {
  const response = await apiFetch(`/rooms/house/${houseId}`);
  const rooms = await response.json();
  return rooms.map(transformRoomResponse);
}

export async function getOrphanRooms() {
  const response = await apiFetch('/rooms/orphans');
  const rooms = await response.json();
  return rooms.map(transformRoomResponse);
}

export async function saveRoom(roomState) {
  const payload = {
    id: roomState.id || null,
    houseId: roomState.houseId,
    name: roomState.name,
    placedFurniture: roomState.placedFurniture || [],
    mogeData: roomState.mogeData || null,
    lightingSettings: roomState.lightingSettings || null
  };

  let roomId;

  if (roomState.id) {
    // Existing room - upload background first, then update
    if (roomState.backgroundImage instanceof Blob) {
      await uploadFile(`/files/room/${roomState.id}/background`, roomState.backgroundImage, 'background.jpg');
    }
    await apiFetch(`/rooms/${roomState.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    roomId = roomState.id;
  } else {
    // New room - include remoteMeshUrl for atomic mesh download
    if (roomState.remoteMeshUrl) {
      payload.remoteMeshUrl = roomState.remoteMeshUrl;
    }
    const response = await apiFetch('/rooms/', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const created = await response.json();
    roomId = created.id;

    // Upload background after room created (now we have the ID)
    if (roomState.backgroundImage instanceof Blob) {
      await uploadFile(`/files/room/${roomId}/background`, roomState.backgroundImage, 'background.jpg');
    }
  }

  return roomId;
}

export async function deleteRoom(roomId) {
  await apiFetch(`/rooms/${roomId}`, { method: 'DELETE' });
}

function transformRoomResponse(room) {
  return {
    id: room.id,
    houseId: room.houseId,
    name: room.name,
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

export async function getAllFurniture() {
  const response = await apiFetch('/furniture/');
  const entries = await response.json();

  return Promise.all(entries.map(async (entry) => {
    const result = transformFurnitureResponse(entry);
    if (entry.thumbnailUrl) {
      result.thumbnail = await fetchAsBlob(entry.thumbnailUrl);
    } else if (entry.imageUrl) {
      result.image = await fetchAsBlob(entry.imageUrl);
    }
    return result;
  }));
}

export async function getFurnitureEntry(id) {
  const response = await apiFetch(`/furniture/${id}`);
  const entry = await response.json();

  const result = transformFurnitureResponse(entry);

  if (entry.imageUrl) {
    result.image = await fetchAsBlob(entry.imageUrl);
  }
  if (entry.thumbnailUrl) {
    result.thumbnail = await fetchAsBlob(entry.thumbnailUrl);
  }
  if (entry.modelUrl) {
    result.model = await fetchAsBlob(entry.modelUrl);
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
  if (entry.thumbnail instanceof Blob) {
    await uploadFile(`/files/furniture/${entryId}/thumbnail`, entry.thumbnail, 'thumbnail.jpg');
  }
  if (entry.model instanceof Blob) {
    await uploadFile(`/files/furniture/${entryId}/model`, entry.model, 'model.zip');
  }

  return entryId;
}

export async function deleteFurnitureEntry(id) {
  await apiFetch(`/furniture/${id}`, { method: 'DELETE' });
}

export async function getAllCategories() {
  const response = await apiFetch('/furniture/categories');
  return response.json();
}

export async function getAllTags() {
  const response = await apiFetch('/furniture/tags');
  return response.json();
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
    dimensionZ: entry.dimensionZ
  };
}

// ============ MoGe Mesh ============

export async function saveMogeMesh(roomId, meshUrl) {
  const response = await apiFetch(`/files/room/${roomId}/mesh`, {
    method: 'POST',
    body: JSON.stringify({ mesh_url: meshUrl })
  });
  return response.json();
}

// ============ Compatibility ============

export async function openDatabase() {
  return true;
}
