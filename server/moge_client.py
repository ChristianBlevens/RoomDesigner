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

    result = response.json()

    if "error" in result:
        raise MoGeError(f"Modal processing error: {result['error']}")

    mesh_bytes = base64.b64decode(result["mesh"])

    logger.info(f"Received mesh from Modal ({len(mesh_bytes) / 1024:.1f} KB)")

    return {
        "mesh_bytes": mesh_bytes,
        "camera": result["camera"],
        "imageSize": result["imageSize"]
    }
