"""
Custom Inference Handler for MoGe-2 on HuggingFace Inference Endpoints.

This handler processes a room image and returns:
- Camera intrinsics (FOV, focal length)
- Room geometry (bounding box, dimensions)
- Depth map (downsampled for transfer)
- Sparse point cloud (for visualization)

Deploy: Upload this file + requirements.txt to a HuggingFace model repo,
then deploy as an Inference Endpoint.
"""

from typing import Dict, Any
import torch
import numpy as np
from PIL import Image
import io
import base64
import json


class EndpointHandler:
    def __init__(self, path: str = ""):
        """
        Initialize the MoGe-2 model.
        Called once when the endpoint starts.
        """
        from moge.model import MoGeModel

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        # Load MoGe-2 model
        # If path contains the model, use it; otherwise download from HF
        try:
            self.model = MoGeModel.from_pretrained(path).to(self.device)
        except:
            # Fallback to downloading from HuggingFace
            self.model = MoGeModel.from_pretrained("Ruicheng/moge-2-vitl").to(self.device)

        self.model.eval()
        print(f"MoGe-2 loaded on {self.device}")

    def __call__(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process inference request.

        Input formats supported:
        1. {"inputs": <base64_encoded_image>}
        2. {"inputs": {"image": <base64_encoded_image>}}
        3. Raw image bytes (when Content-Type is image/*)

        Returns:
        {
            "camera": { "fov", "aspect", "near", "far" },
            "room": { "min", "max", "size", "center" },
            "intrinsics": { "fx", "fy", "cx", "cy" },
            "geometry": {
                "points": [...],  # Sparse point cloud
                "depthMap": { "data", "width", "height" }
            }
        }
        """
        # Extract image from request
        image = self._parse_input(data)

        if image is None:
            return {"error": "No valid image provided"}

        # Convert to tensor
        image_np = np.array(image)
        h, w = image_np.shape[:2]

        image_tensor = torch.from_numpy(image_np).permute(2, 0, 1).float() / 255.0
        image_tensor = image_tensor.unsqueeze(0).to(self.device)

        # Run inference
        with torch.no_grad():
            output = self.model.infer(image_tensor)

        # Process and return results
        result = self._export_for_threejs(output, h, w)

        return result

    def _parse_input(self, data: Dict[str, Any]) -> Image.Image:
        """Parse various input formats to PIL Image."""

        inputs = data.get("inputs", data)

        # Handle dict input
        if isinstance(inputs, dict):
            inputs = inputs.get("image", inputs.get("data", None))

        if inputs is None:
            return None

        # Handle base64 string
        if isinstance(inputs, str):
            # Remove data URL prefix if present
            if "base64," in inputs:
                inputs = inputs.split("base64,")[1]

            try:
                image_bytes = base64.b64decode(inputs)
                return Image.open(io.BytesIO(image_bytes)).convert("RGB")
            except Exception as e:
                print(f"Failed to decode base64: {e}")
                return None

        # Handle raw bytes
        if isinstance(inputs, bytes):
            try:
                return Image.open(io.BytesIO(inputs)).convert("RGB")
            except Exception as e:
                print(f"Failed to open bytes as image: {e}")
                return None

        return None

    def _export_for_threejs(self, output: Dict, h: int, w: int) -> Dict[str, Any]:
        """Convert MoGe-2 output to Three.js-compatible format."""

        points = output["points"].cpu().numpy().squeeze()  # (H, W, 3)
        depth = output["depth"].cpu().numpy().squeeze()    # (H, W)
        mask = output["mask"].cpu().numpy().squeeze()      # (H, W)
        K = output["intrinsics"].cpu().numpy().squeeze()   # (3, 3)

        # Calculate FOV from intrinsics
        fy = float(K[1, 1])
        fx = float(K[0, 0])
        cx = float(K[0, 2])
        cy = float(K[1, 2])

        fov_y_deg = float(np.degrees(2 * np.arctan(h / (2 * fy))))

        # Get valid points
        valid_mask = mask > 0.5
        valid_points = points[valid_mask]

        # Calculate room bounds (use percentiles to exclude outliers)
        if len(valid_points) > 100:
            room_min = np.percentile(valid_points, 2, axis=0)
            room_max = np.percentile(valid_points, 98, axis=0)
        else:
            room_min = valid_points.min(axis=0) if len(valid_points) > 0 else np.zeros(3)
            room_max = valid_points.max(axis=0) if len(valid_points) > 0 else np.ones(3)

        room_size = room_max - room_min
        room_center = (room_min + room_max) / 2

        # Downsample point cloud for transfer (target ~5000 points)
        if len(valid_points) > 5000:
            indices = np.random.choice(len(valid_points), 5000, replace=False)
            sparse_points = valid_points[indices]
        else:
            sparse_points = valid_points

        # Downsample depth map (1/8 resolution for faster transfer)
        depth_small = depth[::8, ::8]

        # Quantize depth to reduce JSON size (2 decimal places)
        depth_list = np.round(depth_small, 2).flatten().tolist()

        return {
            "camera": {
                "fov": round(fov_y_deg, 2),
                "aspect": round(w / h, 4),
                "near": 0.1,
                "far": round(float(room_max[2]) * 2, 2)
            },
            "room": {
                "min": [round(float(x), 3) for x in room_min],
                "max": [round(float(x), 3) for x in room_max],
                "size": [round(float(x), 3) for x in room_size],
                "center": [round(float(x), 3) for x in room_center]
            },
            "intrinsics": {
                "fx": round(fx, 2),
                "fy": round(fy, 2),
                "cx": round(cx, 2),
                "cy": round(cy, 2)
            },
            "geometry": {
                "points": [[round(float(p[0]), 3), round(float(p[1]), 3), round(float(p[2]), 3)]
                          for p in sparse_points],
                "depthMap": {
                    "data": depth_list,
                    "width": depth_small.shape[1],
                    "height": depth_small.shape[0]
                }
            },
            "imageSize": {
                "width": w,
                "height": h
            }
        }
