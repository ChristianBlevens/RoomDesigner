"""
TRELLIS.2 image-to-3D endpoint on Modal.com

Deployment:
    modal deploy modal/trellis2_endpoint.py

Test locally:
    modal run modal/trellis2_endpoint.py <image_path>

Environment:
    MODAL_TOKEN_ID and MODAL_TOKEN_SECRET must be set

Note:
    First image build takes 30-60 minutes due to CUDA kernel compilation.
    Subsequent deploys use the cached image and are fast.
    GPU: A100 40GB required (TRELLIS.2 minimum is 24GB VRAM).
"""

import modal
import base64


def download_model():
    """Download TRELLIS.2 model during image build (cached)."""
    import sys
    sys.path.insert(0, '/opt/trellis2')

    from trellis2.pipelines import Trellis2ImageTo3DPipeline

    pipeline = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
    print(f"Model downloaded: {type(pipeline)}")


image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install(
        "git",
        "build-essential",
        "ninja-build",
        "libgl1-mesa-glx",
        "libglib2.0-0",
        "libegl1-mesa",
        "libxrender1",
        "wget",
    )
    .pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        "numpy<2.0",
        "pillow",
        "trimesh[easy]",
        "huggingface-hub",
        "transformers",
        "einops",
        "omegaconf",
        "scipy",
        "scikit-image",
        "fastapi[standard]",
    )
    # Flash attention (required by TRELLIS.2 DiT backbone)
    .pip_install("flash-attn", extra_options="--no-build-isolation")
    # Clone TRELLIS.2 and run its setup script (compiles CUDA kernels)
    .run_commands(
        "git clone --depth 1 https://github.com/microsoft/TRELLIS.2 /opt/trellis2",
        "cd /opt/trellis2 && bash setup.sh",
        "cd /opt/trellis2 && pip install -e .",
    )
    .run_function(download_model)
)

app = modal.App("roomdesigner-trellis2", image=image)


@app.cls(
    gpu="A100",
    scaledown_window=300,
    timeout=300,
    retries=modal.Retries(max_retries=2, initial_delay=1.0),
)
class Trellis2Inference:
    """TRELLIS.2 inference service for image-to-3D generation."""

    @modal.enter()
    def load_model(self):
        """Load model when container starts (runs once)."""
        import sys
        sys.path.insert(0, '/opt/trellis2')

        import torch
        from trellis2.pipelines import Trellis2ImageTo3DPipeline

        self.device = torch.device("cuda")
        self.pipeline = Trellis2ImageTo3DPipeline.from_pretrained(
            "microsoft/TRELLIS.2-4B"
        )
        self.pipeline.to(self.device)
        print(f"TRELLIS.2 loaded on {self.device}")

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        """
        HTTP endpoint for TRELLIS.2 3D generation.

        Request body:
            {
                "image": base64-encoded image bytes,
                "resolution": 512 | 1024 (default: 512)
            }

        Response (success):
            {
                "glb": base64-encoded GLB bytes,
                "status": "completed"
            }

        Response (failure):
            {
                "error": "error message",
                "status": "failed"
            }
        """
        import io
        import torch
        from PIL import Image

        image_b64 = request.get("image")
        if not image_b64:
            return {"error": "No image provided", "status": "failed"}

        if "base64," in image_b64:
            image_b64 = image_b64.split("base64,")[1]

        try:
            image_bytes = base64.b64decode(image_b64)
        except Exception as e:
            return {"error": f"Failed to decode image: {str(e)}", "status": "failed"}

        resolution = request.get("resolution", 512)

        try:
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

            with torch.no_grad():
                result = self.pipeline.run(image, resolution=resolution)[0]

            # Export to GLB bytes
            glb_data = result.to_glb()
            if isinstance(glb_data, bytes):
                glb_bytes = glb_data
            else:
                glb_bytes = glb_data.export(file_type="glb")

            glb_base64 = base64.b64encode(glb_bytes).decode("ascii")
            print(f"Generated GLB: {len(glb_bytes) / 1024:.1f} KB at resolution {resolution}")

            return {
                "glb": glb_base64,
                "status": "completed",
            }

        except Exception as e:
            import traceback
            traceback.print_exc()
            return {"error": str(e), "status": "failed"}


@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    """Health check endpoint."""
    return {"status": "healthy", "service": "trellis2"}


@app.local_entrypoint()
def main():
    """Test the endpoint locally with an image file."""
    import sys

    if len(sys.argv) < 2:
        print("Usage: modal run modal/trellis2_endpoint.py <image_path>")
        return

    image_path = sys.argv[1]
    with open(image_path, "rb") as f:
        image_bytes = f.read()

    image_b64 = base64.b64encode(image_bytes).decode("ascii")

    inference = Trellis2Inference()
    result = inference.generate.remote({"image": image_b64, "resolution": 512})

    if "error" in result:
        print(f"Error: {result['error']}")
        return

    print(f"Status: {result['status']}")
    glb_bytes = base64.b64decode(result["glb"])
    with open("test_output.glb", "wb") as f:
        f.write(glb_bytes)
    print(f"Saved test_output.glb ({len(glb_bytes) / 1024:.1f} KB)")
