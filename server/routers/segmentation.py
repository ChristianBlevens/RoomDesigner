"""Segmentation tool: proxy to SAM 3 Modal endpoint."""

import logging
import base64
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import sam3_client

logger = logging.getLogger(__name__)
router = APIRouter()


class SegmentRequest(BaseModel):
    image: str  # base64-encoded
    points: Optional[list[dict]] = None  # [{"x": int, "y": int}, ...]


@router.post("/segment")
async def segment_image(request: SegmentRequest):
    """
    Segment objects in an image using SAM 3.

    Accepts base64 image and optional point prompts.
    Returns masks as base64 PNGs with bounding boxes and scores.
    """
    image_b64 = request.image
    if "base64," in image_b64:
        image_b64 = image_b64.split("base64,")[1]

    try:
        image_bytes = base64.b64decode(image_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    try:
        result = await sam3_client.segment_image(image_bytes, request.points)
    except sam3_client.SAM3Error as e:
        raise HTTPException(status_code=502, detail=str(e))

    return result
