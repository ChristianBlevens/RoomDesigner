"""
LBM relighting API endpoints.
"""

import sys
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent))
from lbm_client import relight_image, LBMError
from db.connection import get_houses_db
from utils import IMAGE_EXTENSIONS
from routers.auth import verify_token
import r2

logger = logging.getLogger(__name__)
router = APIRouter()


def get_background_bytes(room_id: str) -> bytes:
    """Get room background image bytes from R2."""
    db = get_houses_db()
    row = db.execute(
        "SELECT background_image_path FROM rooms WHERE id = ?", [room_id]
    ).fetchone()
    if not row or not row[0]:
        raise HTTPException(404, f"Background image not found for room {room_id}")

    data = r2.download_bytes(row[0])
    if not data:
        raise HTTPException(404, f"Background image not found in storage for room {room_id}")
    return data


class RelightRequest(BaseModel):
    room_id: str
    composite_base64: str  # Base64-encoded PNG screenshot


class RelightResponse(BaseModel):
    image_base64: str  # Base64-encoded relighted PNG


@router.post("/relight", response_model=RelightResponse)
async def relight_screenshot(request: RelightRequest, org_id: str = Depends(verify_token)):
    """
    Relight a room screenshot using LBM.

    Takes the room's background image and a composite screenshot,
    returns the relighted image.
    """
    import base64

    background_bytes = get_background_bytes(request.room_id)

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
