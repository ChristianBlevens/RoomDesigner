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

// Extract GLB model from file (handles both direct GLB and legacy ZIP)
export async function extractModelFromZip(file) {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  // Check if it's a GLB file (magic bytes: "glTF" = 0x676C5446)
  const isGlb = bytes[0] === 0x67 && bytes[1] === 0x6C && bytes[2] === 0x54 && bytes[3] === 0x46;

  if (isGlb) {
    return {
      modelBlob: new Blob([arrayBuffer], { type: 'model/gltf-binary' })
    };
  }

  // Legacy ZIP support
  const zip = await JSZip.loadAsync(arrayBuffer);

  let glbFileName = null;
  for (const fileName of Object.keys(zip.files)) {
    if (zip.files[fileName].dir) continue;
    if (fileName.toLowerCase().endsWith('.glb')) {
      glbFileName = fileName;
      break;
    }
  }

  if (!glbFileName) {
    throw new Error('No GLB file found');
  }

  const blob = await zip.files[glbFileName].async('blob');
  return {
    modelBlob: new Blob([blob], { type: 'model/gltf-binary' })
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
