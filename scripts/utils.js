// Utility functions for Room Furniture Planner

export function generateId() {
  return crypto.randomUUID();
}

// Convert Blob to Base64 data URL
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Convert Base64 data URL to Blob
export async function base64ToBlob(base64) {
  const response = await fetch(base64);
  return response.blob();
}

// Show error popup
export function showError(message) {
  const popup = document.getElementById('error-popup');
  const messageEl = document.getElementById('error-message');
  messageEl.textContent = message;
  popup.classList.remove('modal-hidden');
}

// Hide error popup
export function hideError() {
  const popup = document.getElementById('error-popup');
  popup.classList.add('modal-hidden');
}

// Extract model and all assets from ZIP file
// Returns an object with the main model blob and a map of all extracted files
export async function extractModelFromZip(zipFile) {
  const zip = await JSZip.loadAsync(zipFile);

  // Find the main model file (GLB or GLTF)
  const modelExtensions = ['.glb', '.gltf'];
  let modelFileName = null;

  for (const fileName of Object.keys(zip.files)) {
    if (zip.files[fileName].dir) continue;
    const lowerName = fileName.toLowerCase();
    if (modelExtensions.some(ext => lowerName.endsWith(ext))) {
      modelFileName = fileName;
      break;
    }
  }

  if (!modelFileName) {
    throw new Error('No GLB or GLTF file found in ZIP archive');
  }

  const isGlb = modelFileName.toLowerCase().endsWith('.glb');

  // For GLB files, we only need the single file
  if (isGlb) {
    const blob = await zip.files[modelFileName].async('blob');
    return {
      modelBlob: new Blob([blob], { type: 'model/gltf-binary' }),
      assets: null,
      isGlb: true
    };
  }

  // For GLTF files, extract all files and create a map of blob URLs
  const assets = new Map();
  const modelDir = modelFileName.includes('/')
    ? modelFileName.substring(0, modelFileName.lastIndexOf('/') + 1)
    : '';

  for (const fileName of Object.keys(zip.files)) {
    if (zip.files[fileName].dir) continue;

    const blob = await zip.files[fileName].async('blob');

    // Get the path relative to the model file's directory
    let relativePath = fileName;
    if (modelDir && fileName.startsWith(modelDir)) {
      relativePath = fileName.substring(modelDir.length);
    }

    // Determine MIME type
    let mimeType = 'application/octet-stream';
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.gltf')) mimeType = 'model/gltf+json';
    else if (lowerName.endsWith('.bin')) mimeType = 'application/octet-stream';
    else if (lowerName.endsWith('.png')) mimeType = 'image/png';
    else if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (lowerName.endsWith('.webp')) mimeType = 'image/webp';

    const blobWithType = new Blob([blob], { type: mimeType });
    const blobUrl = URL.createObjectURL(blobWithType);

    assets.set(relativePath, blobUrl);
    // Also store with original path for fallback
    if (relativePath !== fileName) {
      assets.set(fileName, blobUrl);
    }
  }

  // Get the model blob
  const modelRelativePath = modelDir ? modelFileName.substring(modelDir.length) : modelFileName;
  const modelBlobUrl = assets.get(modelRelativePath) || assets.get(modelFileName);

  return {
    modelBlob: null,
    modelBlobUrl: modelBlobUrl,
    assets: assets,
    isGlb: false
  };
}

// Debounce function for search input
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
