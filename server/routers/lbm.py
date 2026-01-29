"""
LBM relighting API endpoints.
"""

import sys
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent))
from lbm_client import relight_image, LBMError
from config import ROOM_BACKGROUNDS
from utils import IMAGE_EXTENSIONS

logger = logging.getLogger(__name__)
router = APIRouter()


def find_background_file(room_id: str) -> Path | None:
    """Find room background image file."""
    for ext in IMAGE_EXTENSIONS:
        path = ROOM_BACKGROUNDS / f"{room_id}.{ext}"
        if path.exists():
            return path
    return None


class RelightRequest(BaseModel):
    room_id: str
    composite_base64: str  # Base64-encoded PNG screenshot


class RelightResponse(BaseModel):
    image_base64: str  # Base64-encoded relighted PNG


@router.post("/relight", response_model=RelightResponse)
async def relight_screenshot(request: RelightRequest):
    """
    Relight a room screenshot using LBM.

    Takes the room's background image and a composite screenshot,
    returns the relighted image.
    """
    import base64

    # Find background image for this room
    background_path = find_background_file(request.room_id)
    if not background_path:
        raise HTTPException(404, f"Background image not found for room {request.room_id}")

    background_bytes = background_path.read_bytes()

    # Decode composite screenshot
    try:
        composite_b64 = request.composite_base64
        if "base64," in composite_b64:
            composite_b64 = composite_b64.split("base64,")[1]
        composite_bytes = base64.b64decode(composite_b64)
    except Exception as e:
        raise HTTPException(400, f"Invalid composite image: {str(e)}")

    # Call LBM
    try:
        relighted_bytes = await relight_image(background_bytes, composite_bytes)
    except LBMError as e:
        logger.error(f"LBM relighting failed: {e}")
        raise HTTPException(502, f"LBM processing failed: {str(e)}")

    return RelightResponse(
        image_base64=base64.b64encode(relighted_bytes).decode("ascii")
    )


@router.get("/status")
async def lbm_status():
    """Check if LBM endpoint is configured."""
    import os
    endpoint = os.environ.get("LBM_MODAL_ENDPOINT", "")
    return {
        "configured": bool(endpoint),
        "endpoint": endpoint[:50] + "..." if len(endpoint) > 50 else endpoint
    }
