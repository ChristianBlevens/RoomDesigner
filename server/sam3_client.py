"""
Server-side SAM 3 client for calling Modal endpoint.
"""

import os
import base64
import logging
import httpx

logger = logging.getLogger(__name__)

SAM3_ENDPOINT = os.environ.get("SAM3_ENDPOINT", "")
SAM3_TIMEOUT = 120.0


class SAM3Error(Exception):
    """Error during SAM 3 processing."""
    pass


async def segment_image(image_bytes: bytes, point_groups: list[dict] | None = None) -> dict:
    """
    Send image and optional point groups to SAM 3 Modal endpoint.

    Args:
        image_bytes: Raw image bytes (JPEG/PNG)
        point_groups: Optional list of {"id": int, "name": str, "points": [{"x": int, "y": int}]}

    Returns:
        {
            "masks": [{"id": int, "name": str, "mask": base64 PNG, "bbox": [x,y,w,h], "score": float}],
            "imageSize": {"width": int, "height": int}
        }

    Raises:
        SAM3Error: If processing fails
    """
    if not SAM3_ENDPOINT:
        raise SAM3Error("SAM3_ENDPOINT not configured")

    image_b64 = base64.b64encode(image_bytes).decode("ascii")

    payload = {"image": image_b64}
    if point_groups:
        payload["point_groups"] = point_groups

    total_points = sum(len(g.get("points", [])) for g in (point_groups or []))
    logger.info(f"Sending image to SAM 3 ({len(image_bytes) / 1024:.1f} KB, {len(point_groups or [])} groups, {total_points} points)")

    async with httpx.AsyncClient(timeout=SAM3_TIMEOUT) as client:
        try:
            response = await client.post(SAM3_ENDPOINT, json=payload)
            response.raise_for_status()
        except httpx.TimeoutException:
            raise SAM3Error("SAM 3 request timed out (>2 minutes)")
        except httpx.HTTPStatusError as e:
            raise SAM3Error(f"SAM 3 request failed: {e.response.status_code}")
        except httpx.RequestError as e:
            raise SAM3Error(f"SAM 3 request error: {str(e)}")

    result = response.json()

    if "error" in result:
        raise SAM3Error(f"SAM 3 processing error: {result['error']}")

    logger.info(f"Received {len(result.get('masks', []))} masks from SAM 3")
    return result
