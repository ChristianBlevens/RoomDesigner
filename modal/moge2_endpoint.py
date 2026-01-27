"""
MoGe-2 inference endpoint on Modal.com

Deployment:
    modal deploy modal/moge2_endpoint.py

Test locally:
    modal run modal/moge2_endpoint.py

Environment:
    MODAL_TOKEN_ID and MODAL_TOKEN_SECRET must be set

Note:
    This implementation copies the moge code directly from the HuggingFace Space
    (same approach as the official demo) to avoid dependency conflicts with utils3d.
"""

import modal
import base64


def download_model():
    """Download MoGe-2 model during image build (cached)."""
    import sys
    sys.path.insert(0, '/root')

    import torch
    from moge.model import import_model_class_by_version

    MoGeModel = import_model_class_by_version('v2')
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
        "einops",
        "timm>=0.9.0",
        "huggingface-hub",
        "fastapi[standard]",
        # Use the SAME utils3d version as HuggingFace demo (has image_mesh, image_uv, depth_edge)
        "git+https://github.com/EasternJournalist/utils3d.git@c5daf6f6c244d251f252102d09e9b7bcef791a38",
    )
    # Clone moge code from HuggingFace Space (same approach as official demo)
    # This avoids the dependency conflict between MoGe pip package and utils3d
    .run_commands(
        "git clone --depth 1 https://huggingface.co/spaces/Ruicheng/MoGe-2 /tmp/moge-repo",
        "cp -r /tmp/moge-repo/moge /root/moge",
        "rm -rf /tmp/moge-repo",
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
        import sys
        sys.path.insert(0, '/root')

        import torch
        from moge.model import import_model_class_by_version

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        MoGeModel = import_model_class_by_version('v2')
        self.model = MoGeModel.from_pretrained("Ruicheng/moge-2-vitl").to(self.device)
        self.model.eval()
        self.model.half()  # Use FP16 like HF demo
        print(f"MoGe-2 loaded on {self.device} (FP16)")

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

        # Resolution levels (same as HF demo)
        resolution_map = {"Low": 0, "Medium": 5, "High": 9, "Ultra": 30}
        resolution = request.get("resolution", "High")
        resolution_level = resolution_map.get(resolution, 9)

        apply_mask = request.get("applyMask", True)
        remove_edges = request.get("removeEdges", True)

        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if image is None:
            return {"error": "Failed to decode image"}

        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        # Resize to max 800px (same as HuggingFace demo) to control mesh density
        MAX_SIZE = 800
        h, w = image.shape[:2]
        if max(h, w) > MAX_SIZE:
            scale = MAX_SIZE / max(h, w)
            image = cv2.resize(image, (0, 0), fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            h, w = image.shape[:2]
            print(f"Resized image to {w}x{h}")

        input_tensor = torch.tensor(
            image / 255.0,
            dtype=torch.float16,  # FP16 like HF demo
            device=self.device
        ).permute(2, 0, 1)

        with torch.no_grad():
            output = self.model.infer(
                input_tensor,
                resolution_level=resolution_level,
                apply_mask=apply_mask,
                use_fp16=True  # Same as HF demo
            )

        points = output["points"].cpu().numpy()
        depth = output["depth"].cpu().numpy()
        mask = output["mask"].cpu().numpy()
        intrinsics = output["intrinsics"].cpu().numpy()

        # Use utils3d function for FOV calculation (same as HF demo)
        fov_h, fov_v = utils3d.numpy.intrinsics_to_fov(intrinsics)
        fov_h = float(np.rad2deg(fov_h))
        fov_v = float(np.rad2deg(fov_v))

        # Clean mask using depth edges (same as HF demo)
        if apply_mask:
            if remove_edges:
                mask_cleaned = mask & ~utils3d.numpy.depth_edge(depth, rtol=0.04)
            else:
                mask_cleaned = mask
        else:
            mask_cleaned = np.ones_like(mask, dtype=bool)

        # Generate mesh using image_mesh (same as HF demo)
        faces, vertices, vertex_colors, vertex_uvs = utils3d.numpy.image_mesh(
            points,
            image.astype(np.float32) / 255,
            utils3d.numpy.image_uv(width=w, height=h),
            mask=mask_cleaned,
            tri=True
        )

        # Coordinate transforms (same as HF demo)
        vertices = vertices * np.array([1, -1, -1], dtype=np.float32)
        vertex_uvs = vertex_uvs * np.array([1, -1], dtype=np.float32) + np.array([0, 1], dtype=np.float32)

        print(f"Original mesh: {len(faces)} faces, {len(vertices)} vertices")

        # Create trimesh for simplification
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)

        # Simplify using quadric decimation
        # Target ~2000 faces (reasonable for raycasting, preserves room shape)
        target_faces = min(2000, len(faces))
        if len(faces) > target_faces:
            mesh = mesh.simplify_quadric_decimation(target_faces)
            print(f"Simplified to {len(mesh.faces)} faces, {len(mesh.vertices)} vertices")
        else:
            print(f"Mesh already has {len(faces)} faces, no simplification needed")

        # Validate mesh has actual depth
        bounds = mesh.bounds
        mesh_size = bounds[1] - bounds[0]
        print(f"Mesh bounds: min={bounds[0]}, max={bounds[1]}")
        print(f"Mesh size: {mesh_size}")

        if np.allclose(mesh_size, 0, atol=1e-6):
            return {"error": "Mesh generation failed - all vertices collapsed to single point"}

        # Clean up mesh after decimation
        mesh.remove_unreferenced_vertices()
        mesh.update_faces(mesh.nondegenerate_faces())
        mesh.fix_normals()
        # No smoothing - we want sharp edges at floor-wall transitions

        print(f"Final mesh: {len(mesh.faces)} faces, {len(mesh.vertices)} vertices")

        # Export to GLB (geometry only)
        glb_bytes = mesh.export(file_type='glb')
        print(f"GLB size: {len(glb_bytes) / 1024:.1f} KB")

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
