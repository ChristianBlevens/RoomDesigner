/**
 * Segmentation export: apply masks to source image, produce transparent PNGs, bundle as ZIP.
 */

/**
 * Export accepted segments as transparent PNGs in a ZIP.
 *
 * @param {HTMLImageElement} sourceImage - Original uploaded image
 * @param {Array<{name: string, mask: object}>} segments - Accepted segments with names
 */
export async function exportSegments(sourceImage, segments) {
  const zip = new JSZip();

  for (const seg of segments) {
    const pngBlob = await maskToTransparentPNG(sourceImage, seg.mask);
    zip.file(`${sanitizeFilename(seg.name)}.png`, pngBlob);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `segments_${Date.now()}.zip`);
}

/**
 * Apply a binary mask to the source image, crop to bbox, return transparent PNG blob.
 */
async function maskToTransparentPNG(sourceImage, mask) {
  const bbox = mask.bbox; // [x, y, w, h]
  const pad = 10;
  const x = Math.max(0, bbox[0] - pad);
  const y = Math.max(0, bbox[1] - pad);
  const w = Math.min(sourceImage.naturalWidth - x, bbox[2] + pad * 2);
  const h = Math.min(sourceImage.naturalHeight - y, bbox[3] + pad * 2);

  // Get mask pixel data at full image size
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = sourceImage.naturalWidth;
  maskCanvas.height = sourceImage.naturalHeight;
  const maskCtx = maskCanvas.getContext('2d');
  maskCtx.drawImage(mask._decodedImage, 0, 0, sourceImage.naturalWidth, sourceImage.naturalHeight);
  const maskData = maskCtx.getImageData(x, y, w, h);

  // Draw cropped source
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(sourceImage, x, y, w, h, 0, 0, w, h);

  // Apply mask: transparent outside
  const imgData = outCtx.getImageData(0, 0, w, h);
  for (let i = 0; i < maskData.data.length; i += 4) {
    if (maskData.data[i] < 128) {
      imgData.data[i + 3] = 0;
    }
  }
  outCtx.putImageData(imgData, 0, 0);

  return new Promise((resolve) => {
    outCanvas.toBlob(resolve, 'image/png');
  });
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
