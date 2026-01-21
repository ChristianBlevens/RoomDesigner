# MoGe-2 Integration for Room Designer

Automatic room geometry extraction from a single photograph using MoGe-2.

## Current Approach: HuggingFace Space (Free)

Uses the public MoGe-2 Space via Gradio client. Free but rate-limited.

### Quick Start

```javascript
import { MoGe2Client } from './moge2-client.js';

const moge2 = new MoGe2Client();

// When user uploads a room image
const result = await moge2.processImageForRoom(imageFile);

// Load the 3D room model into your scene
const roomModel = await moge2.loadModelIntoScene(scene, result.modelUrl);
```

### What You Get

- **3D point cloud** of the room (as a GLB model)
- **Camera parameters** (FOV, intrinsics)
- **Room geometry** (bounding box, dimensions in meters)

### Limitations

- Shared GPU, may have queue times
- Rate limited (exact limits unpublished)
- Best for development/testing

## Files

| File | Purpose |
|------|---------|
| `moge2-client.js` | JavaScript client for RoomDesigner |
| `CUSTOM_ENDPOINT_SETUP.md` | Guide for deploying your own endpoint |
| `handler.py` | HuggingFace handler (reference only) |
| `requirements.txt` | Python dependencies (reference only) |

## Future: Your Own Endpoint

When you need:
- No rate limits
- Faster response times
- Custom output format

See **[CUSTOM_ENDPOINT_SETUP.md](./CUSTOM_ENDPOINT_SETUP.md)** for:
- Modal.com deployment (recommended, ~5 min setup)
- Replicate deployment
- Custom Docker on various platforms
- Cost comparison

## Coordinate Systems

MoGe-2 outputs OpenCV coordinates. The client handles conversion to Three.js:

```
OpenCV:   X-right, Y-down,  Z-forward
Three.js: X-right, Y-up,    Z-backward

Conversion: (x, y, z) → (x, -y, -z)
```

## Integration Example

```javascript
// In your room image upload handler
import { MoGe2Client } from './huggingface-moge2/moge2-client.js';

const moge2 = new MoGe2Client();

async function handleRoomImageUpload(file) {
  // Show loading state
  showLoadingModal('Analyzing room geometry...');

  try {
    // Process with MoGe-2
    const result = await moge2.processImageForRoom(file);

    // Option A: Load 3D model directly
    if (result.modelUrl) {
      const model = await moge2.loadModelIntoScene(scene, result.modelUrl);
      // model is now in your scene as room geometry
    }

    // Option B: Just use camera params
    camera.fov = result.camera.fov;
    camera.updateProjectionMatrix();

    hideLoadingModal();
  } catch (error) {
    hideLoadingModal();
    // Graceful fallback - let user place furniture manually
    console.warn('MoGe-2 failed, using defaults:', error);
  }
}
```

## Testing

Test the Space directly: https://huggingface.co/spaces/Ruicheng/MoGe-2

Upload a room photo and see the 3D reconstruction.
