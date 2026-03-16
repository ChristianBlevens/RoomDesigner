"""Segmentation tool: proxy to SAM 3 Modal endpoint, Gemini segment fixing."""

import logging
import base64
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

import sam3_client
from routers.auth import verify_token_full
from usage import check_allowance, log_usage

logger = logging.getLogger(__name__)
router = APIRouter()


class PointGroup(BaseModel):
    id: int
    name: str
    points: list[dict]  # [{"x": int, "y": int}, ...]


class SegmentRequest(BaseModel):
    image: str  # base64-encoded
    point_groups: Optional[list[PointGroup]] = None


class FixSegmentRequest(BaseModel):
    image_base64: str  # base64-encoded PNG of cropped transparent segment


class FixSegmentResponse(BaseModel):
    image_base64: str  # base64-encoded fixed PNG


@router.post("/segment")
async def segment_image(request: SegmentRequest, token: dict = Depends(verify_token_full)):
    """
    Segment objects in an image using SAM 3.

    Accepts base64 image and grouped point prompts (one group per object).
    Returns one mask per group.
    """
    org_id = token["org_id"]
    is_admin = token["is_admin_impersonating"]

    allowed, msg = check_allowance(org_id, "modal", is_admin)
    if not allowed:
        raise HTTPException(status_code=429, detail=msg)

    image_b64 = request.image
    if "base64," in image_b64:
        image_b64 = image_b64.split("base64,")[1]

    try:
        image_bytes = base64.b64decode(image_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    # Convert point groups to the format the SAM 3 client expects
    groups = None
    total_points = 0
    if request.point_groups:
        groups = [
            {"id": g.id, "name": g.name, "points": g.points}
            for g in request.point_groups
            if len(g.points) > 0
        ]
        total_points = sum(len(g.points) for g in request.point_groups)

    start = time.time()
    try:
        result = await sam3_client.segment_image(image_bytes, groups)
        duration_ms = int((time.time() - start) * 1000)
        log_usage(
            org_id=org_id, service_category="modal", action="segment",
            success=True, duration_ms=duration_ms,
            admin_initiated=is_admin,
            metadata={"point_group_count": len(groups) if groups else 0, "total_points": total_points},
        )
        return result
    except sam3_client.SAM3Error as e:
        duration_ms = int((time.time() - start) * 1000)
        log_usage(
            org_id=org_id, service_category="modal", action="segment",
            success=False, duration_ms=duration_ms, error_message=str(e),
            admin_initiated=is_admin,
            metadata={"point_group_count": len(groups) if groups else 0, "total_points": total_points},
        )
        raise HTTPException(status_code=502, detail=str(e))


FIX_SEGMENT_PROMPT = (
    "This is a cropped photograph of a single piece of furniture with a transparent background. "
    "Parts of the object may be cut off or missing because other objects were overlapping it "
    "in the original photograph. Reconstruct and fill in any missing, cut-off, or incomplete "
    "portions of this furniture piece so it looks whole and complete. "
    "Keep the transparent background. Only repair areas that appear incomplete — "
    "do not alter parts that already look correct. Also clean up any jagged, rough, "
    "or erroneous edges along the object outline so the boundary looks natural and smooth. "
    "Maintain the same style, color, material, and lighting of the existing portions."
)


@router.post("/fix-segment", response_model=FixSegmentResponse)
async def fix_segment(request: FixSegmentRequest, token: dict = Depends(verify_token_full)):
    """
    Fix a segmented object image using Gemini.

    Accepts a base64 PNG of a cropped transparent furniture segment.
    Returns the AI-repaired version.
    """
    org_id = token["org_id"]
    is_admin = token["is_admin_impersonating"]

    allowed, msg = check_allowance(org_id, "gemini", is_admin)
    if not allowed:
        raise HTTPException(status_code=429, detail=msg)

    from gemini_client import edit_image

    image_b64 = request.image_base64
    if "base64," in image_b64:
        image_b64 = image_b64.split("base64,")[1]

    try:
        image_bytes = base64.b64decode(image_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    start = time.time()
    try:
        result_bytes = await edit_image(image_bytes, FIX_SEGMENT_PROMPT, mime_type="image/png")
        duration_ms = int((time.time() - start) * 1000)
        log_usage(
            org_id=org_id, service_category="gemini", action="fix_segment",
            success=True, duration_ms=duration_ms,
            admin_initiated=is_admin,
            metadata={"full_prompt": FIX_SEGMENT_PROMPT},
        )
    except Exception as e:
        duration_ms = int((time.time() - start) * 1000)
        log_usage(
            org_id=org_id, service_category="gemini", action="fix_segment",
            success=False, duration_ms=duration_ms, error_message=str(e),
            admin_initiated=is_admin,
            metadata={"full_prompt": FIX_SEGMENT_PROMPT},
        )
        logger.error(f"Segment fix failed: {e}")
        raise HTTPException(status_code=502, detail=f"AI repair failed: {str(e)}")

    return FixSegmentResponse(
        image_base64=base64.b64encode(result_bytes).decode("ascii")
    )
