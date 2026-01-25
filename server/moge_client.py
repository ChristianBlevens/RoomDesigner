"""
Server-side MoGe-2 client for calling Modal endpoint.
"""

import os
import base64
import logging
import httpx

logger = logging.getLogger(__name__)

MOGE2_ENDPOINT = os.environ.get("MOGE2_MODAL_ENDPOINT", "")
MOGE2_TIMEOUT = 180.0


class MoGeError(Exception):
    """Error during MoGe-2 processing."""
    pass


MAX_IMAGE_SIZE = 2048  # Max dimension before resize


def _resize_if_needed(image_bytes: bytes) -> bytes:
    """Resize image if larger than MAX_IMAGE_SIZE to reduce memory usage."""
    from PIL import Image
    import io

    img = Image.open(io.BytesIO(image_bytes))
    w, h = img.size

    if max(w, h) <= MAX_IMAGE_SIZE:
        return image_bytes

    # Calculate new size maintaining aspect ratio
    if w > h:
        new_w = MAX_IMAGE_SIZE
        new_h = int(h * MAX_IMAGE_SIZE / w)
    else:
        new_h = MAX_IMAGE_SIZE
        new_w = int(w * MAX_IMAGE_SIZE / h)

    logger.info(f"Resizing image from {w}x{h} to {new_w}x{new_h}")
    img = img.resize((new_w, new_h), Image.LANCZOS)

    # Save as JPEG with reasonable quality
    buffer = io.BytesIO()
    img.save(buffer, format='JPEG', quality=85)
    return buffer.getvalue()


async def process_image_with_modal(image_bytes: bytes) -> dict:
    """
    Send image to Modal MoGe-2 endpoint and get mesh + camera data.

    Args:
        image_bytes: Raw image bytes (JPEG/PNG)

    Returns:
        {
            "mesh_bytes": bytes,
            "camera": {
                "fov": float,
                "fovHorizontal": float,
                "fovVertical": float,
                "aspect": float,
                "near": float,
                "far": float
            },
            "imageSize": {"width": int, "height": int}
        }

    Raises:
        MoGeError: If processing fails
    """
    if not MOGE2_ENDPOINT:
        raise MoGeError("MOGE2_MODAL_ENDPOINT not configured")

    # Resize large images to reduce memory usage
    image_bytes = _resize_if_needed(image_bytes)

    image_b64 = base64.b64encode(image_bytes).decode('ascii')

    logger.info(f"Sending image to Modal ({len(image_bytes) / 1024:.1f} KB)")

    async with httpx.AsyncClient(timeout=MOGE2_TIMEOUT) as client:
        try:
            response = await client.post(
                MOGE2_ENDPOINT,
                json={
                    "image": image_b64,
                    "resolution": "Medium",
                    "applyMask": True,
                    "removeEdges": True
                }
            )
            response.raise_for_status()
        except httpx.TimeoutException:
            raise MoGeError("Modal request timed out (>3 minutes)")
        except httpx.HTTPStatusError as e:
            raise MoGeError(f"Modal request failed: {e.response.status_code}")
        except httpx.RequestError as e:
            raise MoGeError(f"Modal request error: {str(e)}")

    logger.info(f"Response received, parsing JSON ({len(response.content) / 1024:.1f} KB)...")
    result = response.json()

    if "error" in result:
        raise MoGeError(f"Modal processing error: {result['error']}")

    logger.info(f"Decoding mesh from base64...")
    mesh_bytes = base64.b64decode(result["mesh"])

    logger.info(f"Received mesh from Modal ({len(mesh_bytes) / 1024:.1f} KB)")

    return {
        "mesh_bytes": mesh_bytes,
        "camera": result["camera"],
        "imageSize": result["imageSize"]
    }
