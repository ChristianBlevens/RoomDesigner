"""
MoGe-2 inference endpoint on Modal.com

Deployment:
    modal deploy modal/moge2_endpoint.py

Test locally:
    modal run modal/moge2_endpoint.py

Environment:
    MODAL_TOKEN_ID and MODAL_TOKEN_SECRET must be set
"""

import modal
import io
import base64
from typing import Optional


def download_model():
    """Download MoGe-2 model during image build (cached)."""
    import torch
    from moge.model.v2 import MoGeModel

    model = MoGeModel.from_pretrained("Ruicheng/moge-2-vitl")
    print(f"Model downloaded: {type(model)}")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libgl1-mesa-glx",
        "libglib2.0-0",
        "git",
    )
    .pip_install(
        "torch>=2.0.0",
        "torchvision",
        "numpy<2.0",
        "opencv-python-headless",
        "scipy",
        "pillow",
        "trimesh[easy]",
        "fast-simplification",
        "einops",
        "timm>=0.9.0",
        "huggingface-hub",
        "git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183",
        "git+https://github.com/microsoft/MoGe.git",
    )
    .run_function(download_model)
)

app = modal.App("roomdesigner-moge2", image=image)


@app.cls(
    gpu="T4",
    scaledown_window=300,
    timeout=180,
    retries=modal.Retries(max_retries=2, initial_delay=1.0),
)
class MoGe2Inference:
    """MoGe-2 inference service for room geometry extraction."""

    @modal.enter()
    def load_model(self):
        """Load model when container starts (runs once)."""
        import torch
        from moge.model.v2 import MoGeModel

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = MoGeModel.from_pretrained("Ruicheng/moge-2-vitl").to(self.device)
        self.model.eval()
        print(f"MoGe-2 loaded on {self.device}")

    @modal.fastapi_endpoint(method="POST")
    def process_image(self, request: dict):
        """
        HTTP endpoint for MoGe-2 processing.

        Request body:
            {
                "image": base64-encoded image bytes,
                "resolution": "Low" | "Medium" | "High" | "Ultra" (default: "High"),
                "applyMask": boolean (default: true),
                "removeEdges": boolean (default: true)
            }

        Response:
            {
                "mesh": base64-encoded GLB bytes,
                "camera": { fov, fovHorizontal, fovVertical, aspect, near, far },
                "imageSize": { width, height }
            }
        """
        import cv2
        import numpy as np
        import torch
        import trimesh
        import utils3d

        image_b64 = request.get("image")
        if not image_b64:
            return {"error": "No image provided"}

        if "base64," in image_b64:
            image_b64 = image_b64.split("base64,")[1]

        try:
            image_bytes = base64.b64decode(image_b64)
        except Exception as e:
            return {"error": f"Failed to decode image: {str(e)}"}

        resolution_map = {"Low": 3, "Medium": 5, "High": 7, "Ultra": 9}
        resolution = request.get("resolution", "High")
        resolution_level = resolution_map.get(resolution, 7)

        apply_mask = request.get("applyMask", True)
        remove_edges = request.get("removeEdges", True)
        edge_threshold = 0.01

        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if image is None:
            return {"error": "Failed to decode image"}

        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        h, w = image.shape[:2]

        input_tensor = torch.tensor(
            image / 255.0,
            dtype=torch.float32,
            device=self.device
        ).permute(2, 0, 1)

        with torch.no_grad():
            output = self.model.infer(
                input_tensor,
                resolution_level=resolution_level
            )

        points = output["points"].cpu().numpy()
        mask = output["mask"].cpu().numpy()
        intrinsics = output["intrinsics"].cpu().numpy()

        fy = float(intrinsics[1, 1])
        fx = float(intrinsics[0, 0])
        fov_v = float(np.degrees(2 * np.arctan(h / (2 * fy))))
        fov_h = float(np.degrees(2 * np.arctan(w / (2 * fx))))

        if apply_mask:
            valid_mask = mask > 0.5
        else:
            valid_mask = np.ones_like(mask, dtype=bool)

        if remove_edges:
            kernel_size = max(1, int(min(h, w) * edge_threshold))
            kernel = np.ones((kernel_size, kernel_size), np.uint8)
            valid_mask = cv2.erode(valid_mask.astype(np.uint8), kernel).astype(bool)

        uv = utils3d.np.uv_map(h, w)

        faces, vertices, vertex_colors, vertex_uvs = utils3d.np.build_mesh_from_map(
            points,
            image / 255.0,
            uv,
            mask=valid_mask,
            tri=True
        )

        vertices = vertices * np.array([1, -1, -1], dtype=np.float32)
        vertex_uvs = vertex_uvs * np.array([1, -1], dtype=np.float32) + np.array([0, 1], dtype=np.float32)

        # Create trimesh
        from PIL import Image as PILImage

        mesh = trimesh.Trimesh(
            vertices=vertices,
            faces=faces,
            process=False
        )

        original_faces = len(mesh.faces)
        print(f"Original mesh: {original_faces} faces")

        # Decimate if too many faces (target ~15k for raycasting)
        TARGET_FACES = 15000
        if original_faces > TARGET_FACES:
            # Use quadric decimation
            mesh = mesh.simplify_quadric_decimation(TARGET_FACES)
            print(f"Decimated to {len(mesh.faces)} faces")

            # Recompute vertex normals after decimation
            mesh.fix_normals()

        # Apply Laplacian smoothing to reduce noise (preserves shape)
        trimesh.smoothing.filter_laplacian(mesh, iterations=2)
        print(f"Applied smoothing")

        # Create texture from original image
        texture_image = PILImage.fromarray(image)

        # Create material with texture
        material = trimesh.visual.material.PBRMaterial(
            baseColorTexture=texture_image,
            metallicFactor=0.0,
            roughnessFactor=1.0
        )

        # Apply UV coordinates and material
        # Note: decimation may have changed vertex count, need to handle UVs
        if len(mesh.vertices) == len(vertex_uvs):
            mesh.visual = trimesh.visual.TextureVisuals(
                uv=vertex_uvs,
                material=material
            )
        else:
            # UVs don't match after decimation - use vertex colors instead
            print(f"UV mismatch after decimation, using vertex colors")
            mesh.visual = trimesh.visual.ColorVisuals(
                mesh=mesh,
                vertex_colors=vertex_colors[:len(mesh.vertices)] if len(vertex_colors) >= len(mesh.vertices) else None
            )

        # Export to GLB
        glb_bytes = mesh.export(file_type='glb')

        mesh_base64 = base64.b64encode(glb_bytes).decode('ascii')

        return {
            "mesh": mesh_base64,
            "camera": {
                "fov": round(fov_v, 2),
                "fovHorizontal": round(fov_h, 2),
                "fovVertical": round(fov_v, 2),
                "aspect": round(w / h, 4),
                "near": 0.1,
                "far": 100
            },
            "imageSize": {
                "width": w,
                "height": h
            }
        }


@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    """Health check endpoint."""
    return {"status": "healthy", "service": "moge2"}


@app.local_entrypoint()
def main():
    """Test the endpoint locally with an image file."""
    import sys

    if len(sys.argv) < 2:
        print("Usage: modal run modal/moge2_endpoint.py <image_path>")
        return

    image_path = sys.argv[1]
    with open(image_path, "rb") as f:
        image_bytes = f.read()

    image_b64 = base64.b64encode(image_bytes).decode('ascii')

    inference = MoGe2Inference()
    result = inference.process_image.remote({"image": image_b64, "resolution": "High"})

    if "error" in result:
        print(f"Error: {result['error']}")
        return

    print(f"Camera: {result['camera']}")
    print(f"Image size: {result['imageSize']}")
    print(f"Mesh size: {len(result['mesh'])} bytes (base64)")

    mesh_bytes = base64.b64decode(result['mesh'])
    with open("test_output.glb", "wb") as f:
        f.write(mesh_bytes)
    print("Saved test_output.glb")
