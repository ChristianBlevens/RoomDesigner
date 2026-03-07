"""
Server-side client for Modal TRELLIS.2 endpoint.

The Modal endpoint is a single HTTP call: send image -> wait -> receive GLB.
Called as an asyncio background task from the polling loop so it doesn't block.
"""

import base64
import logging
import os

import httpx

logger = logging.getLogger(__name__)

TRELLIS2_ENDPOINT = os.environ.get("TRELLIS2_ENDPOINT", "")
TRELLIS2_TIMEOUT = 300.0  # 5 minutes: cold start (~60s) + inference (~8-25s) + buffer


class Trellis2Error(Exception):
    """Error during TRELLIS.2 processing."""
    pass


async def generate_3d(image_bytes: bytes, resolution: int = 512) -> bytes:
    """
    Send image to TRELLIS.2 Modal endpoint, return GLB bytes.

    Args:
        image_bytes: Raw image bytes (JPEG/PNG)
        resolution: Generation resolution (512 or 1024)

    Returns:
        GLB file bytes (raw, not base64)

    Raises:
        Trellis2Error: On any failure
    """
    if not TRELLIS2_ENDPOINT:
        raise Trellis2Error("TRELLIS2_ENDPOINT environment variable not configured")

    image_b64 = base64.b64encode(image_bytes).decode("ascii")

    payload = {
        "image": image_b64,
        "resolution": resolution,
    }

    logger.info(f"Sending to TRELLIS.2: {len(image_bytes) / 1024:.1f}KB image, resolution={resolution}")

    try:
        async with httpx.AsyncClient(timeout=TRELLIS2_TIMEOUT) as client:
            response = await client.post(TRELLIS2_ENDPOINT, json=payload)

        if response.status_code != 200:
            raise Trellis2Error(
                f"TRELLIS.2 endpoint returned {response.status_code}: {response.text}"
            )

        result = response.json()

        if result.get("status") == "failed":
            raise Trellis2Error(f"TRELLIS.2 generation failed: {result.get('error')}")

        glb_b64 = result.get("glb")
        if not glb_b64:
            raise Trellis2Error("No GLB data in TRELLIS.2 response")

        glb_bytes = base64.b64decode(glb_b64)
        logger.info(f"Received GLB from TRELLIS.2: {len(glb_bytes) / 1024:.1f}KB")

        return glb_bytes

    except httpx.TimeoutException:
        raise Trellis2Error(
            "TRELLIS.2 endpoint timed out (may need cold start — try again in ~60s)"
        )
    except httpx.HTTPError as e:
        raise Trellis2Error(f"TRELLIS.2 HTTP error: {str(e)}")
