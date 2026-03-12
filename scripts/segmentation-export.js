/**
 * Segmentation export: apply masks to source image, produce transparent PNGs, bundle as ZIP.
 */

/**
 * Export accepted segments as transparent PNGs in a ZIP.
 *
 * @param {HTMLImageElement} sourceImage - Original uploaded image
 * @param {Array<{name: string, mask: object, maskCanvas: HTMLCanvasElement|null}>} segments
 */
export async function exportSegments(sourceImage, segments) {
  const zip = new JSZip();

  for (const seg of segments) {
    const pngBlob = await maskToTransparentPNG(sourceImage, seg.mask, seg.maskCanvas);
    zip.file(`${sanitizeFilename(seg.name)}.png`, pngBlob);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `segments_${Date.now()}.zip`);
}

/**
 * Apply a binary mask to the source image, crop to bbox, return transparent PNG blob.
 */
async function maskToTransparentPNG(sourceImage, mask, editedMaskCanvas) {
  const maskSrc = editedMaskCanvas || mask._decodedImage;

  // Read mask at full resolution to find tight bounds
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = sourceImage.naturalWidth;
  fullCanvas.height = sourceImage.naturalHeight;
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
  fullCtx.drawImage(maskSrc, 0, 0, sourceImage.naturalWidth, sourceImage.naturalHeight);
  const fullData = fullCtx.getImageData(0, 0, sourceImage.naturalWidth, sourceImage.naturalHeight);

  // Compute tight bbox from mask alpha channel
  let minX = sourceImage.naturalWidth, minY = sourceImage.naturalHeight, maxX = 0, maxY = 0;
  const sw = sourceImage.naturalWidth;
  for (let py = 0; py < sourceImage.naturalHeight; py++) {
    for (let px = 0; px < sw; px++) {
      if (fullData.data[(py * sw + px) * 4 + 3] > 128) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }

  if (maxX < minX) {
    // Empty mask — return a 1x1 transparent pixel
    const empty = document.createElement('canvas');
    empty.width = 1;
    empty.height = 1;
    return new Promise((resolve) => empty.toBlob(resolve, 'image/png'));
  }

  const pad = 10;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const w = Math.min(sourceImage.naturalWidth - x, (maxX - minX + 1) + pad * 2);
  const h = Math.min(sourceImage.naturalHeight - y, (maxY - minY + 1) + pad * 2);

  const maskData = fullCtx.getImageData(x, y, w, h);

  // Draw cropped source
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  outCtx.drawImage(sourceImage, x, y, w, h, 0, 0, w, h);

  // Apply mask: transparent outside (check alpha channel)
  const imgData = outCtx.getImageData(0, 0, w, h);
  for (let i = 0; i < maskData.data.length; i += 4) {
    if (maskData.data[i + 3] < 128) {
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
