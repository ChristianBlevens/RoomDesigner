"""
SAM 3 segmentation endpoint on Modal.com

Deployment:
    modal deploy modal/sam3_endpoint.py

Environment:
    MODAL_TOKEN_ID and MODAL_TOKEN_SECRET must be set
    HuggingFace token required for gated model access
"""

import modal
import base64

hf_secret = modal.Secret.from_name("huggingface")


def download_model():
    """Download SAM 3 checkpoint during image build (cached)."""
    import os
    import sys
    sys.path.insert(0, "/opt/sam3")

    from huggingface_hub import login
    login(token=os.environ["HF_TOKEN"])

    from sam3.build_sam import build_sam3
    model = build_sam3(checkpoint=None)
    print(f"SAM 3 model downloaded: {type(model)}")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "git",
        "libgl1-mesa-glx",
        "libglib2.0-0",
    )
    .pip_install(
        "torch>=2.7.0",
        "torchvision",
        "numpy>=1.26,<2.0",
        "opencv-python-headless",
        "pillow",
        "fastapi[standard]",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/facebookresearch/sam3.git /opt/sam3",
        "cd /opt/sam3 && pip install -e '.[notebooks,dev]'",
    )
    .run_function(download_model, secrets=[hf_secret])
)

app = modal.App("roomdesigner-sam3", image=image)


@app.cls(
    gpu="T4",
    scaledown_window=300,
    timeout=120,
    retries=modal.Retries(max_retries=2, initial_delay=1.0),
)
class SAM3Inference:
    """SAM 3 inference service for furniture segmentation."""

    @modal.enter()
    def load_model(self):
        """Load model when container starts."""
        import sys
        sys.path.insert(0, "/opt/sam3")

        import torch
        from sam3.build_sam import build_sam3
        from sam3.sam3_image_predictor import SAM3ImagePredictor

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model = build_sam3(checkpoint="sam3_final.pt").to(self.device)
        model.eval()
        self.predictor = SAM3ImagePredictor(model)
        print(f"SAM 3 loaded on {self.device}")

    @modal.fastapi_endpoint(method="POST")
    def segment(self, request: dict):
        """
        Segment objects at specified points.

        Request:
            {
                "image": base64-encoded image,
                "points": [{"x": int, "y": int}, ...] (optional)
            }

        Response:
            {
                "masks": [
                    {
                        "id": int,
                        "mask": base64-encoded PNG (binary mask, white on black),
                        "bbox": [x, y, w, h],
                        "score": float
                    },
                    ...
                ],
                "imageSize": {"width": int, "height": int}
            }
        """
        import io
        import cv2
        import numpy as np
        import torch
        from PIL import Image

        image_b64 = request.get("image")
        if not image_b64:
            return {"error": "No image provided"}

        if "base64," in image_b64:
            image_b64 = image_b64.split("base64,")[1]

        try:
            image_bytes = base64.b64decode(image_b64)
        except Exception as e:
            return {"error": f"Failed to decode image: {str(e)}"}

        image = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
        h, w = image.shape[:2]

        # Resize large images to control memory
        MAX_SIZE = 2048
        scale = 1.0
        if max(h, w) > MAX_SIZE:
            scale = MAX_SIZE / max(h, w)
            image = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            h, w = image.shape[:2]

        self.predictor.set_image(image)

        points = request.get("points", [])
        masks_out = []

        if points:
            # Point-prompted: one mask per point
            for i, pt in enumerate(points):
                px = int(pt["x"] * scale)
                py = int(pt["y"] * scale)

                masks, scores, _ = self.predictor.predict_inst(
                    point_coords=[[px, py]],
                    point_labels=[1],
                    multimask_output=True,
                )

                # Take highest-scoring mask
                best_idx = int(np.argmax(scores))
                mask = masks[best_idx]
                score = float(scores[best_idx])

                # Encode mask as PNG
                mask_uint8 = (mask.astype(np.uint8)) * 255
                _, png_bytes = cv2.imencode(".png", mask_uint8)
                mask_b64 = base64.b64encode(png_bytes.tobytes()).decode("ascii")

                # Bounding box from mask
                ys, xs = np.where(mask)
                if len(xs) > 0:
                    bbox = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min()), int(ys.max() - ys.min())]
                else:
                    bbox = [0, 0, 0, 0]

                masks_out.append({
                    "id": i,
                    "mask": mask_b64,
                    "bbox": bbox,
                    "score": round(score, 4),
                })
        else:
            # No points: try text prompt as fallback for auto-like behavior
            try:
                masks = self.predictor.predict_concept(text_prompt="distinct object")
                for i, mask in enumerate(masks):
                    mask_np = mask.cpu().numpy() if hasattr(mask, 'cpu') else np.array(mask)
                    if mask_np.ndim > 2:
                        mask_np = mask_np.squeeze()
                    mask_uint8 = (mask_np.astype(np.uint8)) * 255
                    _, png_bytes = cv2.imencode(".png", mask_uint8)
                    mask_b64 = base64.b64encode(png_bytes.tobytes()).decode("ascii")

                    ys, xs = np.where(mask_np)
                    if len(xs) > 0:
                        bbox = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min()), int(ys.max() - ys.min())]
                    else:
                        bbox = [0, 0, 0, 0]

                    masks_out.append({
                        "id": i,
                        "mask": mask_b64,
                        "bbox": bbox,
                        "score": 1.0,
                    })
            except Exception as e:
                return {"error": f"Text-prompt segmentation failed: {str(e)}"}

        # Scale bboxes back to original image coordinates
        if scale != 1.0:
            for m in masks_out:
                m["bbox"] = [int(v / scale) for v in m["bbox"]]

        return {
            "masks": masks_out,
            "imageSize": {"width": int(w / scale), "height": int(h / scale)},
        }


@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    """Health check endpoint."""
    return {"status": "healthy", "service": "sam3"}


@app.local_entrypoint()
def main():
    """Test the endpoint locally."""
    import sys

    if len(sys.argv) < 2:
        print("Usage: modal run modal/sam3_endpoint.py <image_path> [x1,y1 x2,y2 ...]")
        return

    image_path = sys.argv[1]
    with open(image_path, "rb") as f:
        image_bytes = f.read()

    points = []
    for arg in sys.argv[2:]:
        x, y = arg.split(",")
        points.append({"x": int(x), "y": int(y)})

    image_b64 = base64.b64encode(image_bytes).decode("ascii")

    inference = SAM3Inference()
    result = inference.segment.remote({
        "image": image_b64,
        "points": points,
    })

    if "error" in result:
        print(f"Error: {result['error']}")
        return

    print(f"Image size: {result['imageSize']}")
    print(f"Masks returned: {len(result['masks'])}")
    for m in result["masks"]:
        print(f"  Mask {m['id']}: score={m['score']}, bbox={m['bbox']}")
