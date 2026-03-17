"""Screenshot enhancement and wall color editing via Gemini API."""

import sys
import base64
import json
import logging
import time
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))
from gemini_client import edit_image
from db.connection import get_houses_db
from routers.auth import verify_token, verify_token_full
from usage import check_allowance, log_usage, get_allowance_warning
from errors import log_exception
from activity import log_activity
from circuit_breaker import gemini_breaker
import r2

logger = logging.getLogger(__name__)
router = APIRouter()

ENHANCE_PROMPT = (
    "Adjust only the lighting, shadows, and reflections in this image so that all "
    "objects appear naturally lit by the room's environment. Do not add, remove, "
    "move, or alter any objects, furniture, walls, or surfaces. Do not change the "
    "composition. Only correct how light interacts with the existing scene."
)

WALL_COLOR_PROMPT_BOTH = (
    "Change all wall surfaces in this room to {color_name} ({color_hex}). "
    "Keep the exact same room structure, flooring, ceiling, windows, doors, "
    "and all other elements unchanged. Make it look like the walls were "
    "professionally painted in this color."
)

WALL_COLOR_PROMPT_HEX_ONLY = (
    "Change all wall surfaces in this room to the color {color_hex}. "
    "Keep the exact same room structure, flooring, ceiling, windows, doors, "
    "and all other elements unchanged. Make it look like the walls were "
    "professionally painted in this color."
)

WALL_COLOR_PROMPT_NAME_ONLY = (
    "Change all wall surfaces in this room to {color_name}. "
    "Keep the exact same room structure, flooring, ceiling, windows, doors, "
    "and all other elements unchanged. Make it look like the walls were "
    "professionally painted in this color."
)

ROOM_CLEAR_PROMPT = (
    "Remove all furniture, objects, and clutter from this room photograph. "
    "Show the empty room with bare floors, walls, and ceiling. "
    "Reconstruct the surfaces behind removed objects to look natural and continuous. "
    "Preserve the room's architecture, lighting, windows, doors, and built-in features. "
    "Do not add any new objects or furniture."
)


class EnhanceRequest(BaseModel):
    room_id: str
    composite_base64: str
    custom_prompt: Optional[str] = None


class EnhanceResponse(BaseModel):
    image_base64: str
    allowance_warning: Optional[dict] = None


class WallColorRequest(BaseModel):
    room_id: str
    color_name: Optional[str] = None
    color_hex: Optional[str] = None


class WallColorResponse(BaseModel):
    variant_id: str
    image_base64: str
    image_url: str
    allowance_warning: Optional[dict] = None


@router.post("/screenshot", response_model=EnhanceResponse)
async def enhance_screenshot(request: EnhanceRequest, token: dict = Depends(verify_token_full)):
    """Enhance a room screenshot for export."""
    org_id = token["org_id"]
    is_admin = token["is_admin_impersonating"]

    allowed, msg = check_allowance(org_id, "gemini", is_admin)
    if not allowed:
        raise HTTPException(429, msg)

    try:
        composite_b64 = request.composite_base64
        if "base64," in composite_b64:
            composite_b64 = composite_b64.split("base64,")[1]
        image_bytes = base64.b64decode(composite_b64)
    except Exception as e:
        raise HTTPException(400, f"Invalid image: {str(e)}")

    if not gemini_breaker.can_execute():
        raise HTTPException(503, "Gemini service is temporarily unavailable. Please try again in a few minutes.")

    prompt = ENHANCE_PROMPT
    if request.custom_prompt:
        prompt += f" Additional instructions: {request.custom_prompt}"

    start = time.time()
    try:
        result_bytes = await edit_image(image_bytes, prompt)
        gemini_breaker.record_success()
        duration_ms = int((time.time() - start) * 1000)
        log_usage(
            org_id=org_id, service_category="gemini", action="enhance_screenshot",
            success=True, duration_ms=duration_ms, admin_initiated=is_admin,
            metadata={"room_id": request.room_id, "custom_prompt": request.custom_prompt, "full_prompt": prompt},
        )
    except Exception as e:
        gemini_breaker.record_failure()
        duration_ms = int((time.time() - start) * 1000)
        log_usage(
            org_id=org_id, service_category="gemini", action="enhance_screenshot",
            success=False, duration_ms=duration_ms, error_message=str(e), admin_initiated=is_admin,
            metadata={"room_id": request.room_id, "custom_prompt": request.custom_prompt, "full_prompt": prompt},
        )
        logger.error(f"Screenshot enhancement failed: {e}")
        log_exception(e, "enhance.enhance_screenshot", org_id=org_id, endpoint="POST /enhance/screenshot")
        raise HTTPException(502, f"Enhancement failed: {str(e)}")

    log_activity("org", org_id, "enhance_screenshot", "room", resource_id=request.room_id)
    warning = get_allowance_warning(org_id, "gemini") if not is_admin else None

    return EnhanceResponse(
        image_base64=base64.b64encode(result_bytes).decode("ascii"),
        allowance_warning=warning,
    )


@router.post("/wall-color", response_model=WallColorResponse)
async def generate_wall_color(request: WallColorRequest, token: dict = Depends(verify_token_full)):
    """Generate a wall color variant of the room's background image."""
    org_id = token["org_id"]
    is_admin = token["is_admin_impersonating"]

    allowed, msg = check_allowance(org_id, "gemini", is_admin)
    if not allowed:
        raise HTTPException(429, msg)

    db = get_houses_db()

    row = db.execute("""
        SELECT r.background_image_path FROM rooms r
        JOIN houses h ON r.house_id = h.id
        WHERE r.id = ? AND h.org_id = ?
    """, [request.room_id, org_id]).fetchone()

    if not row or not row[0]:
        raise HTTPException(404, "Room background not found")

    bg_bytes = r2.download_bytes(row[0])
    if not bg_bytes:
        raise HTTPException(404, "Background image not found in storage")

    if not request.color_name and not request.color_hex:
        raise HTTPException(400, "At least one of color_name or color_hex is required")

    if request.color_name and request.color_hex:
        prompt = WALL_COLOR_PROMPT_BOTH.format(
            color_name=request.color_name, color_hex=request.color_hex
        )
    elif request.color_hex:
        prompt = WALL_COLOR_PROMPT_HEX_ONLY.format(color_hex=request.color_hex)
    else:
        prompt = WALL_COLOR_PROMPT_NAME_ONLY.format(color_name=request.color_name)

    if not gemini_breaker.can_execute():
        raise HTTPException(503, "Gemini service is temporarily unavailable. Please try again in a few minutes.")

    start = time.time()
    try:
        result_bytes = await edit_image(bg_bytes, prompt, mime_type="image/jpeg")
        gemini_breaker.record_success()
        duration_ms = int((time.time() - start) * 1000)
        log_usage(
            org_id=org_id, service_category="gemini", action="wall_color",
            success=True, duration_ms=duration_ms, admin_initiated=is_admin,
            metadata={"room_id": request.room_id, "color_name": request.color_name, "color_hex": request.color_hex},
        )
    except Exception as e:
        gemini_breaker.record_failure()
        duration_ms = int((time.time() - start) * 1000)
        log_usage(
            org_id=org_id, service_category="gemini", action="wall_color",
            success=False, duration_ms=duration_ms, error_message=str(e), admin_initiated=is_admin,
            metadata={"room_id": request.room_id, "color_name": request.color_name, "color_hex": request.color_hex},
        )
        logger.error(f"Wall color generation failed: {e}")
        log_exception(e, "enhance.wall_color", org_id=org_id, endpoint="POST /enhance/wall-color")
        raise HTTPException(502, f"Wall color generation failed: {str(e)}")

    log_activity("org", org_id, "edit_wall_color", "room", resource_id=request.room_id,
                 details={"color_name": request.color_name, "color_hex": request.color_hex})
    variant_id = str(uuid4())
    variant_key = f"rooms/wall-colors/{request.room_id}/{variant_id}.png"
    r2.upload_bytes(variant_key, result_bytes, "image/png")

    wc_row = db.execute(
        "SELECT wall_colors FROM rooms WHERE id = ?", [request.room_id]
    ).fetchone()
    wall_colors = json.loads(wc_row[0]) if wc_row and wc_row[0] else {"activeVariantId": "original", "variants": []}

    variant_data = {
        "id": variant_id,
        "colorName": request.color_name,
        "colorHex": request.color_hex,
        "imagePath": variant_key,
        "imageUrl": r2.get_public_url(variant_key),
    }
    wall_colors["variants"].append(variant_data)
    wall_colors["activeVariantId"] = variant_id

    db.execute(
        "UPDATE rooms SET wall_colors = ? WHERE id = ?",
        [json.dumps(wall_colors), request.room_id]
    )

    warning = get_allowance_warning(org_id, "gemini") if not is_admin else None

    return WallColorResponse(
        variant_id=variant_id,
        image_base64=base64.b64encode(result_bytes).decode("ascii"),
        image_url=r2.get_public_url(variant_key),
        allowance_warning=warning,
    )


@router.delete("/wall-color/{room_id}/{variant_id}")
async def delete_wall_color(room_id: str, variant_id: str, org_id: str = Depends(verify_token)):
    """Delete a wall color variant."""
    db = get_houses_db()

    row = db.execute("""
        SELECT r.wall_colors FROM rooms r
        JOIN houses h ON r.house_id = h.id
        WHERE r.id = ? AND h.org_id = ?
    """, [room_id, org_id]).fetchone()

    if not row:
        raise HTTPException(404, "Room not found")

    wall_colors = json.loads(row[0]) if row[0] else {"activeVariantId": "original", "variants": []}

    variant = next((v for v in wall_colors["variants"] if v["id"] == variant_id), None)
    if not variant:
        raise HTTPException(404, "Variant not found")

    r2.delete_object(variant["imagePath"])

    wall_colors["variants"] = [v for v in wall_colors["variants"] if v["id"] != variant_id]
    if wall_colors["activeVariantId"] == variant_id:
        wall_colors["activeVariantId"] = "original"

    db.execute(
        "UPDATE rooms SET wall_colors = ? WHERE id = ?",
        [json.dumps(wall_colors), room_id]
    )

    log_activity("org", org_id, "delete_wall_color", "room", resource_id=room_id, details={"variant_id": variant_id})
    return {"success": True, "activeVariantId": wall_colors["activeVariantId"]}


@router.get("/status")
async def enhance_status():
    """Check if Gemini API is configured."""
    import os
    key = os.environ.get("GOOGLE_API_KEY", "")
    model = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-3-pro-image-preview")
    return {
        "configured": bool(key),
        "model": model
    }
