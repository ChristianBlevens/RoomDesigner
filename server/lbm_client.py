"""
Server-side LBM client for calling Modal endpoint.
"""

import os
import base64
import logging
import httpx

logger = logging.getLogger(__name__)

LBM_ENDPOINT = os.environ.get("LBM_MODAL_ENDPOINT", "")
LBM_TIMEOUT = 120.0  # 2 minutes to handle cold start (~70s) + processing (~15s)


class LBMError(Exception):
    """Error during LBM processing."""
    pass


async def relight_image(background_bytes: bytes, composite_bytes: bytes) -> bytes:
    """
    Send images to Modal LBM endpoint for relighting.

    Args:
        background_bytes: Raw background image bytes (the room photo)
        composite_bytes: Raw composite image bytes (room + furniture screenshot)

    Returns:
        Relighted image as PNG bytes

    Raises:
        LBMError: If processing fails
    """
    if not LBM_ENDPOINT:
        raise LBMError("LBM_MODAL_ENDPOINT not configured")

    background_b64 = base64.b64encode(background_bytes).decode("ascii")
    composite_b64 = base64.b64encode(composite_bytes).decode("ascii")

    logger.info(
        f"Sending to LBM: background={len(background_bytes)/1024:.1f}KB, "
        f"composite={len(composite_bytes)/1024:.1f}KB"
    )

    async with httpx.AsyncClient(timeout=LBM_TIMEOUT) as client:
        try:
            response = await client.post(
                LBM_ENDPOINT,
                json={
                    "background": background_b64,
                    "composite": composite_b64,
                    "num_steps": 1
                }
            )
            response.raise_for_status()
        except httpx.TimeoutException:
            raise LBMError("LBM request timed out (>2 minutes)")
        except httpx.HTTPStatusError as e:
            raise LBMError(f"LBM request failed: {e.response.status_code}")
        except httpx.RequestError as e:
            raise LBMError(f"LBM request error: {str(e)}")

    result = response.json()

    if "error" in result:
        raise LBMError(f"LBM processing error: {result['error']}")

    output_bytes = base64.b64decode(result["image"])
    logger.info(f"Received relighted image: {len(output_bytes)/1024:.1f}KB")

    return output_bytes
