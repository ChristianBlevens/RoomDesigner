# Setting Up Your Own MoGe-2 Endpoint

This guide covers how to deploy MoGe-2 as your own dedicated endpoint without rate limits.

**Why you'd want this:**
- No rate limits (HF Space is shared/queued)
- Faster response times
- Custom output format
- Full control

---

## Table of Contents

1. [Why HuggingFace Default Container Failed](#why-huggingface-default-container-failed)
2. [Option 1: Custom Docker on HuggingFace](#option-1-custom-docker-on-huggingface)
3. [Option 2: Modal.com (Recommended)](#option-2-modalcom-recommended)
4. [Option 3: Replicate](#option-3-replicate)
5. [Option 4: Self-Hosted (RunPod/Lambda/AWS)](#option-4-self-hosted)
6. [Cost Comparison](#cost-comparison)

---

## Why HuggingFace Default Container Failed

The HF Inference Endpoints "Default (INF2)" container comes with pre-installed packages that conflict:

```
Container has:
├── transformers (requires huggingface-hub >= 0.30.0, < 1.0)
├── huggingface-hub 1.3.2  ← Violates transformers requirement!
├── sentence-transformers
└── tokenizers (also requires huggingface-hub < 1.0)
```

When MoGe-2 installs its dependencies, it can't resolve this conflict because the base container is already broken.

**Solution:** Use a custom Docker container or a different platform.

---

## Option 1: Custom Docker on HuggingFace

### Step 1: Create Dockerfile

```dockerfile
# Dockerfile
FROM pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies (clean environment, no conflicts)
RUN pip install --no-cache-dir \
    flask \
    flask-cors \
    gunicorn \
    pillow \
    numpy==1.26.4 \
    scipy \
    einops \
    timm \
    trimesh \
    huggingface-hub==0.25.2

# Install MoGe utilities
RUN pip install --no-cache-dir \
    git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183

# Install MoGe
RUN pip install --no-cache-dir \
    git+https://github.com/microsoft/MoGe.git

# Pre-download model weights
RUN python -c "from moge.model import MoGeModel; MoGeModel.from_pretrained('Ruicheng/moge-2-vitl')"

# Copy server code
COPY server.py .

EXPOSE 8080

CMD ["gunicorn", "-b", "0.0.0.0:8080", "-w", "1", "-t", "120", "server:app"]
```

### Step 2: Create server.py

```python
# server.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import torch
import numpy as np
from PIL import Image
import io
import base64

app = Flask(__name__)
CORS(app)

# Load model once at startup
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Loading MoGe-2 on {device}...")

from moge.model import MoGeModel
model = MoGeModel.from_pretrained("Ruicheng/moge-2-vitl").to(device)
model.eval()
print("MoGe-2 loaded successfully")


@app.route("/", methods=["POST"])
def predict():
    try:
        # Parse input
        if request.content_type.startswith("image/"):
            image_bytes = request.data
        else:
            data = request.json
            inputs = data.get("inputs", "")
            if "base64," in inputs:
                inputs = inputs.split("base64,")[1]
            image_bytes = base64.b64decode(inputs)

        # Load image
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        image_np = np.array(image)
        h, w = image_np.shape[:2]

        # Convert to tensor
        image_tensor = torch.from_numpy(image_np).permute(2, 0, 1).float() / 255.0
        image_tensor = image_tensor.unsqueeze(0).to(device)

        # Run inference
        with torch.no_grad():
            output = model.infer(image_tensor)

        # Extract results
        points = output["points"].cpu().numpy().squeeze()
        depth = output["depth"].cpu().numpy().squeeze()
        mask = output["mask"].cpu().numpy().squeeze()
        K = output["intrinsics"].cpu().numpy().squeeze()

        # Calculate FOV
        fy = float(K[1, 1])
        fov_y_deg = float(np.degrees(2 * np.arctan(h / (2 * fy))))

        # Get valid points
        valid_mask = mask > 0.5
        valid_points = points[valid_mask]

        # Room bounds
        if len(valid_points) > 100:
            room_min = np.percentile(valid_points, 2, axis=0)
            room_max = np.percentile(valid_points, 98, axis=0)
        else:
            room_min = valid_points.min(axis=0)
            room_max = valid_points.max(axis=0)

        # Sparse point cloud
        if len(valid_points) > 5000:
            indices = np.random.choice(len(valid_points), 5000, replace=False)
            sparse_points = valid_points[indices]
        else:
            sparse_points = valid_points

        # Downsample depth
        depth_small = depth[::8, ::8]

        return jsonify({
            "camera": {
                "fov": round(fov_y_deg, 2),
                "aspect": round(w / h, 4),
                "near": 0.1,
                "far": round(float(room_max[2]) * 2, 2)
            },
            "room": {
                "min": [round(float(x), 3) for x in room_min],
                "max": [round(float(x), 3) for x in room_max],
                "size": [round(float(x), 3) for x in (room_max - room_min)],
                "center": [round(float(x), 3) for x in ((room_min + room_max) / 2)]
            },
            "intrinsics": {
                "fx": round(float(K[0, 0]), 2),
                "fy": round(float(K[1, 1]), 2),
                "cx": round(float(K[0, 2]), 2),
                "cy": round(float(K[1, 2]), 2)
            },
            "geometry": {
                "points": [[round(float(p[0]), 3), round(float(p[1]), 3), round(float(p[2]), 3)]
                          for p in sparse_points],
                "depthMap": {
                    "data": np.round(depth_small, 2).flatten().tolist(),
                    "width": depth_small.shape[1],
                    "height": depth_small.shape[0]
                }
            },
            "imageSize": {"width": w, "height": h}
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "healthy"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
```

### Step 3: Deploy to HuggingFace

1. Create a new HuggingFace repo
2. Upload `Dockerfile` and `server.py`
3. Go to Inference Endpoints
4. Select your repo
5. Choose **"Custom Container"** instead of "Default (INF2)"
6. Select GPU (A10G)
7. Deploy

---

## Option 2: Modal.com (Recommended)

Modal gives you serverless GPU functions with a clean Python environment.

### Step 1: Install Modal

```bash
pip install modal
modal token new
```

### Step 2: Create modal_app.py

```python
# modal_app.py
import modal

app = modal.App("moge2-room-geometry")

# Define the container image
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1-mesa-glx", "libglib2.0-0")
    .pip_install(
        "torch",
        "torchvision",
        "pillow",
        "numpy==1.26.4",
        "scipy",
        "einops",
        "timm",
        "trimesh",
        "huggingface-hub==0.25.2",
        "git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183",
        "git+https://github.com/microsoft/MoGe.git",
    )
)

@app.cls(image=image, gpu="A10G", container_idle_timeout=300)
class MoGe2:
    @modal.enter()
    def load_model(self):
        import torch
        from moge.model import MoGeModel

        self.device = torch.device("cuda")
        self.model = MoGeModel.from_pretrained("Ruicheng/moge-2-vitl").to(self.device)
        self.model.eval()

    @modal.web_endpoint(method="POST")
    def predict(self, image_b64: str):
        import torch
        import numpy as np
        from PIL import Image
        import io
        import base64

        # Decode image
        if "base64," in image_b64:
            image_b64 = image_b64.split("base64,")[1]
        image_bytes = base64.b64decode(image_b64)
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        # Process
        image_np = np.array(image)
        h, w = image_np.shape[:2]
        image_tensor = torch.from_numpy(image_np).permute(2, 0, 1).float() / 255.0
        image_tensor = image_tensor.unsqueeze(0).to(self.device)

        with torch.no_grad():
            output = self.model.infer(image_tensor)

        # Extract and return (same format as above)
        # ... (see server.py for full implementation)

        return {"status": "ok", "fov": 60}  # Simplified
```

### Step 3: Deploy

```bash
modal deploy modal_app.py
```

You get a URL like: `https://your-username--moge2-room-geometry-moge2-predict.modal.run`

### Pricing

- ~$0.000575/second on A10G
- ~$0.035 per minute of GPU time
- Only pay when processing (auto-scales to zero)

---

## Option 3: Replicate

Replicate wraps models in Docker and provides an API.

### Step 1: Create cog.yaml

```yaml
# cog.yaml
build:
  python_version: "3.11"
  gpu: true
  cuda: "12.1"
  system_packages:
    - libgl1-mesa-glx
    - libglib2.0-0
  python_packages:
    - torch
    - torchvision
    - pillow
    - numpy==1.26.4
    - scipy
    - einops
    - timm
    - trimesh
    - huggingface-hub==0.25.2
    - git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183
    - git+https://github.com/microsoft/MoGe.git

predict: "predict.py:Predictor"
```

### Step 2: Create predict.py

```python
# predict.py
from cog import BasePredictor, Input, Path
import torch
import numpy as np
from PIL import Image

class Predictor(BasePredictor):
    def setup(self):
        from moge.model import MoGeModel
        self.device = torch.device("cuda")
        self.model = MoGeModel.from_pretrained("Ruicheng/moge-2-vitl").to(self.device)
        self.model.eval()

    def predict(self, image: Path = Input(description="Room image")) -> dict:
        img = Image.open(image).convert("RGB")
        # ... process and return
        return {"fov": 60}
```

### Step 3: Push to Replicate

```bash
cog login
cog push r8.im/your-username/moge2-room
```

### Pricing

- ~$0.000225/second on A40 GPU
- Pay per prediction

---

## Option 4: Self-Hosted

### RunPod (Cheapest GPU)

1. Create a pod with PyTorch template
2. SSH in and run the Docker container
3. Expose port via RunPod's proxy

```bash
# On RunPod
docker run -d -p 8080:8080 --gpus all your-registry/moge2-server
```

Pricing: ~$0.20-0.40/hour for A10G equivalent

### Lambda Labs

Similar to RunPod, slightly more reliable.

Pricing: ~$0.50/hour for A10G

### AWS/GCP/Azure

Most expensive but most reliable.

- AWS: g5.xlarge (A10G) ~$1.00/hour
- GCP: a2-highgpu-1g ~$1.20/hour

---

## Cost Comparison

| Platform | GPU | $/hour | $/1000 images | Auto-scale |
|----------|-----|--------|---------------|------------|
| **HF Space (free)** | Shared | $0 | $0 | N/A |
| **Modal** | A10G | ~$2.00 | ~$0.60 | ✅ Yes |
| **Replicate** | A40 | ~$0.80 | ~$0.25 | ✅ Yes |
| **RunPod** | A10G | ~$0.40 | ~$2.40* | ❌ No |
| **Lambda** | A10G | ~$0.50 | ~$3.00* | ❌ No |
| **AWS** | A10G | ~$1.00 | ~$6.00* | ⚠️ Complex |

*Self-hosted costs assume endpoint runs 24/7. Actual cost depends on usage patterns.

**Recommendation:**
- **Low volume (<100/day):** Use free HF Space
- **Medium volume:** Modal or Replicate (serverless, pay-per-use)
- **High volume (>10k/day):** Self-hosted on RunPod

---

## Quick Start: Modal (5 minutes)

If you want your own endpoint fast:

```bash
# 1. Install
pip install modal
modal token new

# 2. Create file (copy modal_app.py from above)

# 3. Deploy
modal deploy modal_app.py

# 4. Use
curl -X POST "https://your-url.modal.run" \
  -H "Content-Type: application/json" \
  -d '{"image_b64": "<base64>"}'
```

---

## Files in this Directory

- `handler.py` - HuggingFace custom handler (for reference)
- `requirements.txt` - Dependencies (for reference)
- `moge2-client.js` - JavaScript client for calling the endpoint
- `README.md` - Quick start guide
- `CUSTOM_ENDPOINT_SETUP.md` - This file

---

## Updating moge2-client.js for Custom Endpoint

Once you have your own endpoint, update the client:

```javascript
// Change from HF Space to your endpoint
export class MoGe2Client {
  constructor(endpointUrl, token = null) {
    this.endpointUrl = endpointUrl || "https://your-modal-url.modal.run";
    this.token = token;
  }

  async processImage(imageFile) {
    const base64 = await this._fileToBase64(imageFile);

    const response = await fetch(this.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { 'Authorization': `Bearer ${this.token}` })
      },
      body: JSON.stringify({ inputs: base64 })
    });

    return response.json();
  }

  // ... rest of the client code
}
```

---

*Last updated: January 2026*
