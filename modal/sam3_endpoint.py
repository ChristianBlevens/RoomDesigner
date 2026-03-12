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

    from sam3 import build_sam3_image_model
    model = build_sam3_image_model(enable_inst_interactivity=True)
    print(f"SAM 3 model downloaded: {type(model)}")


image = (
    modal.Image.debian_slim(python_version="3.12")
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
        "setuptools",
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

        import os
        import torch
        import sam3
        from sam3 import build_sam3_image_model
        from sam3.model.sam3_image_processor import Sam3Processor

        torch.autocast("cuda", dtype=torch.bfloat16).__enter__()
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

        sam3_root = os.path.join(os.path.dirname(sam3.__file__), "..")
        bpe_path = os.path.join(sam3_root, "assets", "bpe_simple_vocab_16e6.txt.gz")

        self.model = build_sam3_image_model(
            bpe_path=bpe_path,
            enable_inst_interactivity=True,
        )
        self.processor = Sam3Processor(self.model)
        print("SAM 3 loaded with point-prompt and text-prompt support")

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

        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        orig_w, orig_h = pil_image.size

        # Resize large images to control memory
        MAX_SIZE = 2048
        scale = 1.0
        if max(orig_w, orig_h) > MAX_SIZE:
            scale = MAX_SIZE / max(orig_w, orig_h)
            pil_image = pil_image.resize(
                (int(orig_w * scale), int(orig_h * scale)), Image.LANCZOS
            )

        # Set image in processor (creates inference_state)
        inference_state = self.processor.set_image(pil_image)

        points = request.get("points", [])
        masks_out = []

        if points:
            # Point-prompted: one mask per point via model.predict_inst
            for i, pt in enumerate(points):
                px = int(pt["x"] * scale)
                py = int(pt["y"] * scale)

                masks, scores, logits = self.model.predict_inst(
                    inference_state,
                    point_coords=np.array([[px, py]]),
                    point_labels=np.array([1]),
                    multimask_output=True,
                )

                # Take highest-scoring mask
                best_idx = int(np.argmax(scores))
                mask = masks[best_idx]
                score = float(scores[best_idx])

                mask_result = self._encode_mask(mask, score, i, scale)
                masks_out.append(mask_result)
        else:
            # No points: try text prompt for auto-like behavior
            try:
                output = self.processor.set_text_prompt(
                    prompt="distinct object",
                    state=inference_state,
                )
                result_masks = output.get("masks", [])
                result_scores = output.get("scores", [])

                for i, mask in enumerate(result_masks):
                    mask_np = mask.cpu().numpy() if hasattr(mask, 'cpu') else np.array(mask)
                    if mask_np.ndim > 2:
                        mask_np = mask_np.squeeze()
                    score = float(result_scores[i]) if i < len(result_scores) else 1.0
                    mask_result = self._encode_mask(mask_np, score, i, scale)
                    masks_out.append(mask_result)
            except Exception as e:
                return {"error": f"Text-prompt segmentation failed: {str(e)}"}

        return {
            "masks": masks_out,
            "imageSize": {"width": orig_w, "height": orig_h},
        }

    def _encode_mask(self, mask, score, mask_id, scale):
        """Encode a binary mask as PNG and compute bbox in original image coords."""
        import cv2
        import numpy as np

        mask_bool = mask > 0 if mask.dtype != bool else mask
        mask_uint8 = mask_bool.astype(np.uint8) * 255
        _, png_bytes = cv2.imencode(".png", mask_uint8)
        mask_b64 = base64.b64encode(png_bytes.tobytes()).decode("ascii")

        ys, xs = np.where(mask_bool)
        if len(xs) > 0:
            bbox = [
                int(xs.min() / scale),
                int(ys.min() / scale),
                int((xs.max() - xs.min()) / scale),
                int((ys.max() - ys.min()) / scale),
            ]
        else:
            bbox = [0, 0, 0, 0]

        return {
            "id": mask_id,
            "mask": mask_b64,
            "bbox": bbox,
            "score": round(score, 4),
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
