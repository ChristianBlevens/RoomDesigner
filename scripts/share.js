// Share page: public house view with optional owner-mode image generation

const TOKEN_KEY = 'roomdesigner_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

// Extract token from URL path: /share/{token} or /room/share/{token}
function getShareToken() {
  const parts = window.location.pathname.split('/');
  const shareIdx = parts.indexOf('share');
  if (shareIdx >= 0 && parts[shareIdx + 1]) {
    return parts[shareIdx + 1];
  }
  return null;
}

// Detect base API path (handles /room/ prefix behind nginx)
function getApiBase() {
  const path = window.location.pathname;
  const shareIdx = path.indexOf('/share/');
  if (shareIdx > 0) {
    return path.substring(0, shareIdx) + '/api';
  }
  return '/api';
}

const shareToken = getShareToken();
const API_BASE = getApiBase();

async function fetchShareData() {
  const headers = {};
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}/share/${shareToken}`, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function formatDateRange(start, end) {
  const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
  return `${fmt(start)} – ${fmt(end)}`;
}

function renderRoomCard(room, isOwner) {
  const card = document.createElement('div');
  card.className = 'share-room-card';

  const header = document.createElement('h2');
  header.textContent = room.name;
  card.appendChild(header);

  // Image area
  const imageArea = document.createElement('div');
  imageArea.className = 'share-image-area';

  if (room.finalImageUrl && room.backgroundImageUrl) {
    // Before/after slider
    const slider = createBeforeAfterSlider(room.backgroundImageUrl, room.finalImageUrl);
    imageArea.appendChild(slider);
  } else if (room.finalImageUrl) {
    const img = document.createElement('img');
    img.src = room.finalImageUrl;
    img.className = 'share-room-image';
    img.alt = `${room.name} staged`;
    imageArea.appendChild(img);
  } else if (room.backgroundImageUrl) {
    const img = document.createElement('img');
    img.src = room.backgroundImageUrl;
    img.className = 'share-room-image share-room-image-empty';
    img.alt = `${room.name} empty`;
    imageArea.appendChild(img);
    if (!isOwner) {
      const note = document.createElement('p');
      note.className = 'share-no-image-note';
      note.textContent = 'No staged image yet';
      imageArea.appendChild(note);
    }
  }

  card.appendChild(imageArea);

  // Owner mode: generate/update button
  if (isOwner) {
    const controls = document.createElement('div');
    controls.className = 'share-owner-controls';

    const genBtn = document.createElement('button');
    genBtn.className = 'btn-primary';
    genBtn.textContent = room.finalImageUrl ? 'Generate New Image' : 'Generate Image';
    genBtn.addEventListener('click', () => handleGenerateImage(room, card, imageArea));
    controls.appendChild(genBtn);

    card.appendChild(controls);
  }

  // Download button for final image
  if (room.finalImageUrl) {
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn-secondary share-download-btn';
    dlBtn.textContent = 'Download Image';
    dlBtn.addEventListener('click', () => downloadImage(room.finalImageUrl, room.name));
    card.appendChild(dlBtn);
  }

  // Furniture list
  if (room.furniture && room.furniture.length > 0) {
    const furnSection = document.createElement('div');
    furnSection.className = 'share-furniture-list';
    const furnTitle = document.createElement('h3');
    furnTitle.textContent = 'Furniture';
    furnSection.appendChild(furnTitle);

    const ul = document.createElement('ul');
    for (const item of room.furniture) {
      const li = document.createElement('li');
      let text = item.name;
      if (item.category) text += ` (${item.category})`;
      if (item.condition) {
        const badge = document.createElement('span');
        badge.className = `share-condition-badge share-condition-${item.condition}`;
        badge.textContent = item.condition;
        li.textContent = text + ' ';
        li.appendChild(badge);
      } else {
        li.textContent = text;
      }
      ul.appendChild(li);
    }
    furnSection.appendChild(ul);
    card.appendChild(furnSection);
  }

  return card;
}

function createBeforeAfterSlider(beforeUrl, afterUrl) {
  const container = document.createElement('div');
  container.className = 'share-slider-container';

  const beforeImg = document.createElement('img');
  beforeImg.src = beforeUrl;
  beforeImg.className = 'share-slider-before';
  beforeImg.alt = 'Before';
  beforeImg.draggable = false;

  const afterImg = document.createElement('img');
  afterImg.src = afterUrl;
  afterImg.className = 'share-slider-after';
  afterImg.alt = 'After';
  afterImg.draggable = false;

  const divider = document.createElement('div');
  divider.className = 'share-slider-divider';
  const handle = document.createElement('div');
  handle.className = 'share-slider-handle';
  divider.appendChild(handle);

  container.appendChild(afterImg);
  container.appendChild(beforeImg);
  container.appendChild(divider);

  // Slider interaction
  let isDragging = false;

  function updateSlider(clientX) {
    const rect = container.getBoundingClientRect();
    let x = (clientX - rect.left) / rect.width;
    x = Math.max(0, Math.min(1, x));
    beforeImg.style.clipPath = `inset(0 ${(1 - x) * 100}% 0 0)`;
    divider.style.left = `${x * 100}%`;
  }

  container.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isDragging = true;
    container.setPointerCapture(e.pointerId);
    updateSlider(e.clientX);
  });

  container.addEventListener('pointermove', (e) => {
    if (isDragging) updateSlider(e.clientX);
  });

  container.addEventListener('pointerup', () => {
    isDragging = false;
  });

  // Start at 50%
  beforeImg.style.clipPath = 'inset(0 50% 0 0)';
  divider.style.left = '50%';

  return container;
}

function renderInventory(inventory) {
  const container = document.getElementById('share-inventory');
  container.innerHTML = '';

  // Group by category
  const byCategory = {};
  for (const item of inventory) {
    const cat = item.category || 'Uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  }

  for (const [category, items] of Object.entries(byCategory).sort()) {
    const group = document.createElement('div');
    group.className = 'share-manifest-group';

    const catHeader = document.createElement('h3');
    catHeader.textContent = category;
    group.appendChild(catHeader);

    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      let text = `${item.name} x${item.totalInHouse}`;
      if (item.location) text += ` — ${item.location}`;
      li.textContent = text;
      if (item.condition) {
        const badge = document.createElement('span');
        badge.className = `share-condition-badge share-condition-${item.condition}`;
        badge.textContent = item.condition;
        li.appendChild(document.createTextNode(' '));
        li.appendChild(badge);
      }
      ul.appendChild(li);
    }
    group.appendChild(ul);
    container.appendChild(group);
  }
}

async function downloadImage(url, name) {
  const response = await fetch(url, { cache: 'no-store' });
  const blob = await response.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.png`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Owner mode: image generation

let screenshotModule = null;

async function loadScreenshotDeps() {
  if (screenshotModule) return;
  screenshotModule = await import('./screenshot.js');
}

async function handleGenerateImage(room, card, imageArea) {
  if (!room.placedFurniture || !room.mogeData) {
    alert('This room does not have the data needed to generate an image.');
    return;
  }

  const genBtn = card.querySelector('.share-owner-controls button');
  const originalText = genBtn.textContent;
  genBtn.textContent = 'Loading renderer...';
  genBtn.disabled = true;

  try {
    await loadScreenshotDeps();

    genBtn.textContent = 'Capturing screenshot...';

    // Determine the correct background URL (wall color variant if active, otherwise original)
    let backgroundUrl = room.backgroundImageUrl;
    if (room.wallColors?.activeVariantId && room.wallColors.variants) {
      const activeVariant = room.wallColors.variants.find(v => v.id === room.wallColors.activeVariantId);
      if (activeVariant?.imageUrl) {
        backgroundUrl = activeVariant.imageUrl;
      }
    }

    // Build room data in the format captureRoomScreenshot expects
    const roomData = {
      id: room.id,
      name: room.name,
      backgroundImageUrl: backgroundUrl,
      placedFurniture: room.placedFurniture,
      mogeData: room.mogeData,
      lightingSettings: room.lightingSettings,
      roomScale: room.roomScale,
    };

    // Build furniture entries map from room.furniture (which has modelUrl in owner mode)
    const furnitureEntries = new Map();
    for (const item of room.furniture) {
      if (item.modelUrl) {
        const modelResponse = await fetch(item.modelUrl, { cache: 'no-store' });
        const modelBlob = await modelResponse.blob();
        furnitureEntries.set(item.entryId, {
          ...item,
          model: modelBlob,
        });
      }
    }

    // Fetch background image blob
    const bgResponse = await fetch(backgroundUrl, { cache: 'no-store' });
    roomData.backgroundImage = await bgResponse.blob();

    const screenshot = await screenshotModule.captureRoomScreenshot(roomData, furnitureEntries);
    screenshotModule.disposeScreenshotRenderer();

    // Ask about AI enhancement
    let finalBlob = screenshot;
    const enhance = confirm('Enhance with AI? This makes furniture blend naturally with room lighting.');
    if (enhance) {
      genBtn.textContent = 'Enhancing with AI...';
      try {
        const base64 = await blobToBase64(screenshot);
        const token = getToken();
        const response = await fetch(`${API_BASE}/enhance/screenshot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            room_id: room.id,
            composite_base64: base64,
          }),
        });
        if (response.ok) {
          const result = await response.json();
          finalBlob = base64ToBlob(result.image_base64);
        }
      } catch (err) {
        console.error('Enhancement failed, using original:', err);
      }
    }

    // Upload final image
    genBtn.textContent = 'Uploading...';
    const uploadBase64 = await blobToBase64(finalBlob);
    const token = getToken();
    const uploadResponse = await fetch(`${API_BASE}/rooms/${room.id}/final-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ image_base64: uploadBase64 }),
    });
    const uploadResult = await uploadResponse.json();

    // Update the room card with the new image
    room.finalImageUrl = uploadResult.finalImageUrl;
    imageArea.innerHTML = '';
    if (room.backgroundImageUrl) {
      const slider = createBeforeAfterSlider(room.backgroundImageUrl, room.finalImageUrl);
      imageArea.appendChild(slider);
    } else {
      const img = document.createElement('img');
      img.src = room.finalImageUrl;
      img.className = 'share-room-image';
      imageArea.appendChild(img);
    }

    genBtn.textContent = 'Generate New Image';
    genBtn.disabled = false;

    // Add download button if it didn't exist
    if (!card.querySelector('.share-download-btn')) {
      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn-secondary share-download-btn';
      dlBtn.textContent = 'Download Image';
      dlBtn.addEventListener('click', () => downloadImage(room.finalImageUrl, room.name));
      card.insertBefore(dlBtn, card.querySelector('.share-furniture-list'));
    }

  } catch (err) {
    console.error('Image generation failed:', err);
    genBtn.textContent = originalText;
    genBtn.disabled = false;
    alert(`Failed to generate image: ${err.message}`);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, mimeType = 'image/png') {
  const byteChars = atob(base64);
  const byteArrays = [];
  for (let offset = 0; offset < byteChars.length; offset += 512) {
    const slice = byteChars.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }
  return new Blob(byteArrays, { type: mimeType });
}

// ============ Initialize ============

async function init() {
  if (!shareToken) {
    document.getElementById('share-loading').classList.add('hidden');
    document.getElementById('share-error').classList.remove('hidden');
    return;
  }

  try {
    const data = await fetchShareData();

    document.getElementById('share-loading').classList.add('hidden');
    document.getElementById('share-content').classList.remove('hidden');

    document.getElementById('share-house-name').textContent = data.house.name;
    document.getElementById('share-house-dates').textContent = formatDateRange(data.house.startDate, data.house.endDate);

    const roomsContainer = document.getElementById('share-rooms');
    for (const room of data.rooms) {
      const card = renderRoomCard(room, data.isOwner);
      roomsContainer.appendChild(card);
    }

    renderInventory(data.inventory);

    // Download all button
    document.getElementById('share-download-all').addEventListener('click', async () => {
      for (const room of data.rooms) {
        if (room.finalImageUrl) {
          await downloadImage(room.finalImageUrl, room.name);
        }
      }
    });

    // Hide download all if no final images
    if (!data.rooms.some(r => r.finalImageUrl)) {
      document.getElementById('share-download-all').style.display = 'none';
    }

  } catch (err) {
    console.error('Failed to load share data:', err);
    document.getElementById('share-loading').classList.add('hidden');
    document.getElementById('share-error').classList.remove('hidden');
  }
}

init();
