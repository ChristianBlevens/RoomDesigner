"""Segmentation tool: proxy to SAM 3 Modal endpoint."""

import logging
import base64
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import sam3_client

logger = logging.getLogger(__name__)
router = APIRouter()


class PointGroup(BaseModel):
    id: int
    name: str
    points: list[dict]  # [{"x": int, "y": int}, ...]


class SegmentRequest(BaseModel):
    image: str  # base64-encoded
    point_groups: Optional[list[PointGroup]] = None


@router.post("/segment")
async def segment_image(request: SegmentRequest):
    """
    Segment objects in an image using SAM 3.

    Accepts base64 image and grouped point prompts (one group per object).
    Returns one mask per group.
    """
    image_b64 = request.image
    if "base64," in image_b64:
        image_b64 = image_b64.split("base64,")[1]

    try:
        image_bytes = base64.b64decode(image_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    # Convert point groups to the format the SAM 3 client expects
    groups = None
    if request.point_groups:
        groups = [
            {"id": g.id, "name": g.name, "points": g.points}
            for g in request.point_groups
            if len(g.points) > 0
        ]

    try:
        result = await sam3_client.segment_image(image_bytes, groups)
    except sam3_client.SAM3Error as e:
        raise HTTPException(status_code=502, detail=str(e))

    return result
