"""
LBM Relighting inference endpoint on Modal.com

Deployment:
    modal deploy modal/lbm_endpoint.py

Test locally:
    modal run modal/lbm_endpoint.py <background_image> <composite_image>

Environment:
    MODAL_TOKEN_ID and MODAL_TOKEN_SECRET must be set
"""

import modal
import base64


def download_model():
    """Download LBM relighting model during image build (cached)."""
    import os
    os.environ["HF_HOME"] = "/root/.cache/huggingface"

    import torch
    from lbm.inference import get_model

    model = get_model(
        "jasperai/LBM_relighting",
        torch_dtype=torch.bfloat16,
        device="cpu"  # Download only, will move to GPU at runtime
    )
    print(f"LBM model downloaded: {type(model)}")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libgl1-mesa-glx",
        "libglib2.0-0",
        "git",
    )
    .env({"HF_HOME": "/root/.cache/huggingface"})
    .pip_install(
        "torch==2.7.0",
        "torchvision",
        "pillow",
        "numpy<2.0",
        "fastapi[standard]",
        "diffusers",
        "transformers",
        "accelerate",
        "safetensors",
        "git+https://github.com/gojasper/LBM.git",
    )
    .run_function(download_model)
)

app = modal.App("roomdesigner-lbm", image=image)


@app.cls(
    gpu="T4",
    scaledown_window=300,
    timeout=300,  # 5 minutes - plenty of time for processing
    retries=modal.Retries(max_retries=2, initial_delay=1.0),
)
class LBMRelighting:
    """LBM relighting service for furniture harmonization."""

    @modal.enter()
    def load_model(self):
        """Load model when container starts (runs once)."""
        import os
        os.environ["HF_HOME"] = "/root/.cache/huggingface"

        import torch
        from lbm.inference import get_model

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = get_model(
            "jasperai/LBM_relighting",
            torch_dtype=torch.bfloat16,
            device=self.device,
        )
        print(f"LBM loaded on {self.device} (bfloat16)")

    @modal.fastapi_endpoint(method="POST")
    def relight(self, request: dict):
        """
        HTTP endpoint for LBM relighting.

        Request body:
            {
                "background": base64-encoded background image (room photo),
                "composite": base64-encoded composite image (room + furniture),
                "num_steps": int (default: 1, single-step inference)
            }

        Response:
            {
                "image": base64-encoded relighted image (PNG)
            }
        """
        import io
        from PIL import Image
        from lbm.inference import evaluate

        background_b64 = request.get("background")
        composite_b64 = request.get("composite")
        num_steps = request.get("num_steps", 1)

        if not background_b64 or not composite_b64:
            return {"error": "Both 'background' and 'composite' images are required"}

        # Strip data URL prefix if present
        if "base64," in background_b64:
            background_b64 = background_b64.split("base64,")[1]
        if "base64," in composite_b64:
            composite_b64 = composite_b64.split("base64,")[1]

        try:
            background_bytes = base64.b64decode(background_b64)
            composite_bytes = base64.b64decode(composite_b64)
        except Exception as e:
            return {"error": f"Failed to decode images: {str(e)}"}

        # Load images
        import numpy as np

        background = Image.open(io.BytesIO(background_bytes)).convert("RGB")
        composite = Image.open(io.BytesIO(composite_bytes)).convert("RGB")

        # Ensure same size (composite should match background)
        if background.size != composite.size:
            composite = composite.resize(background.size, Image.LANCZOS)

        print(f"Processing: background={background.size}, composite={composite.size}")

        # Compute mask: where composite differs from background (that's the furniture)
        bg_array = np.array(background).astype(np.float32)
        comp_array = np.array(composite).astype(np.float32)

        # Calculate absolute difference across color channels
        diff = np.abs(comp_array - bg_array)
        diff_gray = np.max(diff, axis=2)  # Max difference across RGB

        # Threshold to create binary mask (furniture pixels)
        # Using a low threshold to catch subtle differences like shadows
        threshold = 10
        mask_array = (diff_gray > threshold).astype(np.uint8) * 255

        # Dilate mask slightly to catch edges
        from PIL import ImageFilter
        mask = Image.fromarray(mask_array, mode='L')
        mask = mask.filter(ImageFilter.MaxFilter(3))  # Dilate
        mask = mask.filter(ImageFilter.GaussianBlur(2))  # Smooth edges

        print(f"Mask coverage: {np.mean(np.array(mask) > 128) * 100:.1f}% of image")

        # Run LBM on the composite (naive paste)
        try:
            output_image = evaluate(
                self.model,
                composite,
                num_sampling_steps=num_steps
            )
        except Exception as e:
            return {"error": f"LBM inference failed: {str(e)}"}

        # Resize output to match original size (LBM may resize)
        if output_image.size != background.size:
            output_image = output_image.resize(background.size, Image.LANCZOS)

        # Re-composite: place relighted areas onto original background using mask
        # This keeps the original background pristine and only applies relighting to furniture
        output_image = Image.composite(output_image, background, mask)

        # Convert result to PNG bytes
        output_buffer = io.BytesIO()
        output_image.save(output_buffer, format="PNG")
        output_bytes = output_buffer.getvalue()

        print(f"Output size: {len(output_bytes) / 1024:.1f} KB")

        return {
            "image": base64.b64encode(output_bytes).decode("ascii")
        }


@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    """Health check endpoint."""
    return {"status": "healthy", "service": "lbm-relighting"}


@app.local_entrypoint()
def main():
    """Test the endpoint locally with image files."""
    import sys

    if len(sys.argv) < 3:
        print("Usage: modal run modal/lbm_endpoint.py <background_image> <composite_image>")
        return

    background_path = sys.argv[1]
    composite_path = sys.argv[2]

    with open(background_path, "rb") as f:
        background_b64 = base64.b64encode(f.read()).decode("ascii")
    with open(composite_path, "rb") as f:
        composite_b64 = base64.b64encode(f.read()).decode("ascii")

    relight = LBMRelighting()
    result = relight.relight.remote({
        "background": background_b64,
        "composite": composite_b64,
        "num_steps": 1
    })

    if "error" in result:
        print(f"Error: {result['error']}")
        return

    output_bytes = base64.b64decode(result["image"])
    with open("test_relighted.png", "wb") as f:
        f.write(output_bytes)
    print(f"Saved test_relighted.png ({len(output_bytes) / 1024:.1f} KB)")
