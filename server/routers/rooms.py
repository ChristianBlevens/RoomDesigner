from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Depends
from typing import List
import uuid
import json
import sys
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db
from models.room import RoomUpdate, RoomResponse
from moge_client import process_image_with_modal, MoGeError
from routers.auth import verify_token, verify_token_full
from usage import check_allowance, log_usage, get_allowance_warning
from errors import log_exception
from activity import log_activity, diff_room_state
from circuit_breaker import moge_breaker, gemini_breaker
import time
import r2

logger = logging.getLogger(__name__)

ROOM_SELECT = """
    SELECT id, house_id, name, status, error_message, background_image_path,
           placed_furniture, moge_data, lighting_settings, room_scale, meter_stick,
           wall_colors, original_background_key, final_image_path
    FROM rooms
"""

router = APIRouter()


def verify_house_ownership(house_id: str, org_id: str):
    """Verify that the house belongs to the org."""
    db = get_houses_db()
    row = db.execute(
        "SELECT id FROM houses WHERE id = ? AND org_id = ?", [house_id, org_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "House not found")


def verify_room_ownership(room_id: str, org_id: str):
    """Verify that the room belongs to a house owned by the org. Returns house_id."""
    db = get_houses_db()
    row = db.execute("SELECT house_id FROM rooms WHERE id = ?", [room_id]).fetchone()
    if not row:
        raise HTTPException(404, "Room not found")
    verify_house_ownership(row[0], org_id)
    return row[0]


def row_to_response(row) -> RoomResponse:
    room_id = row[0]
    status = row[3] or "ready"
    error_message = row[4]
    background_path = row[5]
    placed_furniture = json.loads(row[6]) if row[6] else []
    moge_data = json.loads(row[7]) if row[7] else None
    lighting_settings = json.loads(row[8]) if row[8] else None
    room_scale = row[9] if row[9] is not None else 1.0
    meter_stick = json.loads(row[10]) if row[10] else None
    wall_colors = json.loads(row[11]) if row[11] else None
    original_bg_key = row[12] if len(row) > 12 else None
    final_image_path = row[13] if len(row) > 13 else None

    # Resolve R2 URLs for wall color variants
    if wall_colors and wall_colors.get("variants"):
        for variant in wall_colors["variants"]:
            if variant.get("imagePath") and not variant.get("imageUrl"):
                variant["imageUrl"] = r2.get_public_url(variant["imagePath"])

    background_url = r2.get_public_url(background_path) if background_path else None
    original_bg_url = r2.get_public_url(original_bg_key) if original_bg_key else None
    final_image_url = r2.get_public_url(final_image_path) if final_image_path else None

    return RoomResponse(
        id=room_id,
        houseId=row[1],
        name=row[2],
        status=status,
        errorMessage=error_message,
        backgroundImageUrl=background_url,
        originalBackgroundUrl=original_bg_url,
        finalImageUrl=final_image_url,
        placedFurniture=placed_furniture,
        mogeData=moge_data,
        lightingSettings=lighting_settings,
        roomScale=room_scale,
        meterStick=meter_stick,
        wallColors=wall_colors
    )


@router.get("/", response_model=List[RoomResponse])
def get_all_rooms(org_id: str = Depends(verify_token)):
    db = get_houses_db()
    rows = db.execute(f"""
        {ROOM_SELECT} WHERE house_id IN (SELECT id FROM houses WHERE org_id = ?)
    """, [org_id]).fetchall()
    return [row_to_response(row) for row in rows]


@router.get("/house/{house_id}", response_model=List[RoomResponse])
def get_rooms_by_house(house_id: str, org_id: str = Depends(verify_token)):
    verify_house_ownership(house_id, org_id)
    db = get_houses_db()
    rows = db.execute(f"{ROOM_SELECT} WHERE house_id = ?", [house_id]).fetchall()
    return [row_to_response(row) for row in rows]


@router.get("/orphans", response_model=List[RoomResponse])
def get_orphan_rooms(org_id: str = Depends(verify_token)):
    db = get_houses_db()
    rows = db.execute(f"""
        {ROOM_SELECT} WHERE (house_id IS NULL OR house_id = '')
        AND id IN (
            SELECT r.id FROM rooms r
            LEFT JOIN houses h ON r.house_id = h.id
            WHERE h.id IS NULL OR h.org_id = ?
        )
    """, [org_id]).fetchall()
    return [row_to_response(row) for row in rows]


@router.get("/{room_id}", response_model=RoomResponse)
def get_room(room_id: str, org_id: str = Depends(verify_token)):
    verify_room_ownership(room_id, org_id)
    db = get_houses_db()
    row = db.execute(f"{ROOM_SELECT} WHERE id = ?", [room_id]).fetchone()
    if not row:
        raise HTTPException(404, "Room not found")
    return row_to_response(row)


@router.post("/", response_model=RoomResponse)
async def create_room(
    houseId: str = Form(...),
    name: str = Form(...),
    image: UploadFile = File(...),
    clearFurniture: str = Form("false"),
    floorHint: str = Form(""),
    token: dict = Depends(verify_token_full)
):
    """
    Create a new room with background image.
    Optionally clears furniture from image via Gemini before MoGe-2 processing.
    Synchronous: waits for processing (30-90 seconds depending on clearing).
    """
    org_id = token["org_id"]
    is_admin = token["is_admin_impersonating"]

    # Check modal allowance for MoGe
    allowed, msg = check_allowance(org_id, "modal", is_admin)
    if not allowed:
        raise HTTPException(429, msg)

    should_clear = clearFurniture.lower() == "true"
    if should_clear:
        # Also need gemini allowance for clearing
        allowed_g, msg_g = check_allowance(org_id, "gemini", is_admin)
        if not allowed_g:
            raise HTTPException(429, msg_g)

    verify_house_ownership(houseId, org_id)
    db = get_houses_db()

    room_id = str(uuid.uuid4())

    # Validate image upload
    ALLOWED_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'image/gif'}
    MAX_IMAGE_SIZE = 20 * 1024 * 1024
    if image.content_type and image.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(400, "Only image files (JPEG, PNG, WebP, GIF) are allowed")
    image_bytes = await image.read()
    if len(image_bytes) > MAX_IMAGE_SIZE:
        raise HTTPException(400, f"File size exceeds {MAX_IMAGE_SIZE // (1024*1024)}MB limit")

    ext = "jpg"
    if image.content_type == "image/png":
        ext = "png"
    elif image.content_type == "image/webp":
        ext = "webp"

    original_bg_key = None
    moge_input_bytes = image_bytes

    if should_clear:
        original_bg_key = f"rooms/backgrounds/originals/{room_id}.{ext}"
        r2.upload_bytes(original_bg_key, image_bytes, image.content_type or "image/jpeg")

        logger.info(f"Clearing furniture from room {room_id} via Gemini...")
        if not gemini_breaker.can_execute():
            raise HTTPException(status_code=503, detail="Gemini service is temporarily unavailable. Please try again in a few minutes.")
        from gemini_client import edit_image
        from routers.enhance import ROOM_CLEAR_PROMPT
        clear_prompt = ROOM_CLEAR_PROMPT
        if floorHint.strip():
            clear_prompt += f" The floor beneath the furniture is {floorHint.strip()}."

        start_clear = time.time()
        try:
            cleared_bytes = await edit_image(image_bytes, clear_prompt, mime_type=image.content_type or "image/jpeg")
            duration_ms = int((time.time() - start_clear) * 1000)
            log_usage(
                org_id=org_id, service_category="gemini", action="room_clear",
                success=True, duration_ms=duration_ms, admin_initiated=is_admin,
                metadata={"room_id": room_id, "floor_hint": floorHint.strip(), "full_prompt": clear_prompt},
            )
            gemini_breaker.record_success()
            moge_input_bytes = cleared_bytes
            image_bytes = cleared_bytes
        except Exception as e:
            gemini_breaker.record_failure()
            duration_ms = int((time.time() - start_clear) * 1000)
            log_usage(
                org_id=org_id, service_category="gemini", action="room_clear",
                success=False, duration_ms=duration_ms, error_message=str(e), admin_initiated=is_admin,
                metadata={"room_id": room_id, "floor_hint": floorHint.strip(), "full_prompt": clear_prompt},
            )
            logger.error(f"Room {room_id} furniture clearing failed: {e}")
            log_exception(e, "rooms.create_room", org_id=org_id, endpoint="POST /rooms", metadata={"room_id": room_id, "action": "clear_furniture"})
            r2.delete_object(original_bg_key)
            raise HTTPException(status_code=502, detail=f"Furniture clearing failed: {str(e)}")

    logger.info(f"Processing room {room_id} with Modal...")
    if not moge_breaker.can_execute():
        raise HTTPException(status_code=503, detail="MoGe-2 service is temporarily unavailable. Please try again in a few minutes.")
    start_moge = time.time()
    try:
        result = await process_image_with_modal(moge_input_bytes)
        moge_breaker.record_success()
        duration_ms = int((time.time() - start_moge) * 1000)
        log_usage(
            org_id=org_id, service_category="modal", action="room_create",
            success=True, duration_ms=duration_ms, admin_initiated=is_admin,
            metadata={"room_id": room_id, "house_id": houseId, "clear_furniture": should_clear},
        )
    except MoGeError as e:
        moge_breaker.record_failure()
        duration_ms = int((time.time() - start_moge) * 1000)
        log_usage(
            org_id=org_id, service_category="modal", action="room_create",
            success=False, duration_ms=duration_ms, error_message=str(e), admin_initiated=is_admin,
            metadata={"room_id": room_id, "house_id": houseId, "clear_furniture": should_clear},
        )
        logger.error(f"Room {room_id} mesh generation failed: {e}")
        log_exception(e, "rooms.create_room", org_id=org_id, endpoint="POST /rooms", metadata={"room_id": room_id, "action": "moge"})
        if original_bg_key:
            r2.delete_object(original_bg_key)
        raise HTTPException(status_code=502, detail=f"Mesh generation failed: {str(e)}")

    mesh_key = f"rooms/meshes/{room_id}.glb"
    r2.upload_bytes(mesh_key, result["mesh_bytes"], "model/gltf-binary")

    bg_key = f"rooms/backgrounds/{room_id}.{ext}"
    r2.upload_bytes(bg_key, image_bytes, image.content_type or "image/jpeg")

    mesh_url = r2.get_public_url(mesh_key)

    image_size = result["imageSize"]
    image_aspect = image_size["width"] / image_size["height"]
    moge_data = {
        "meshUrl": mesh_url,
        "cameraFov": result["camera"]["fov"],
        "imageAspect": image_aspect
    }

    db.execute(
        """
        INSERT INTO rooms (id, house_id, name, status, background_image_path,
                           original_background_key, placed_furniture, moge_data, lighting_settings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [room_id, houseId, name, "ready", bg_key, original_bg_key, "[]", json.dumps(moge_data), None]
    )

    logger.info(f"Room {room_id} created successfully" + (" (furniture cleared)" if should_clear else ""))
    log_activity("org", org_id, "create_room", "room", resource_id=room_id, resource_name=name,
                 details={"house_id": houseId, "clear_furniture": should_clear})

    return RoomResponse(
        id=room_id,
        houseId=houseId,
        name=name,
        status="ready",
        backgroundImageUrl=r2.get_public_url(bg_key),
        originalBackgroundUrl=r2.get_public_url(original_bg_key) if original_bg_key else None,
        placedFurniture=[],
        mogeData=moge_data,
        lightingSettings=None
    )


@router.put("/{room_id}", response_model=RoomResponse)
def update_room(room_id: str, room: RoomUpdate, org_id: str = Depends(verify_token)):
    verify_room_ownership(room_id, org_id)
    db = get_houses_db()

    # Fetch current state for diff-based activity logging
    old_row = db.execute(
        "SELECT placed_furniture, lighting_settings, room_scale, meter_stick FROM rooms WHERE id = ?",
        [room_id]
    ).fetchone()
    old_state = {}
    if old_row:
        old_state = {
            'placed_furniture': json.loads(old_row[0]) if old_row[0] else [],
            'lighting_settings': json.loads(old_row[1]) if old_row[1] else None,
            'room_scale': old_row[2],
            'meter_stick': json.loads(old_row[3]) if old_row[3] else None,
        }

    updates = []
    values = []

    if room.name is not None:
        updates.append("name = ?")
        values.append(room.name)
    if room.placedFurniture is not None:
        updates.append("placed_furniture = ?")
        values.append(json.dumps([f.model_dump() for f in room.placedFurniture]))
    if room.mogeData is not None:
        updates.append("moge_data = ?")
        values.append(json.dumps(room.mogeData.model_dump()))
    if room.lightingSettings is not None:
        updates.append("lighting_settings = ?")
        values.append(json.dumps(room.lightingSettings.model_dump()))
    if room.roomScale is not None:
        updates.append("room_scale = ?")
        values.append(room.roomScale)
    if 'meterStick' in room.model_fields_set:
        updates.append("meter_stick = ?")
        values.append(json.dumps(room.meterStick) if room.meterStick else None)

    if updates:
        values.append(room_id)
        db.execute(f"UPDATE rooms SET {', '.join(updates)} WHERE id = ?", values)

    # Diff-based activity logging
    new_state = {
        'placed_furniture': [f.model_dump() for f in room.placedFurniture] if room.placedFurniture is not None else None,
        'lighting_settings': room.lightingSettings.model_dump() if room.lightingSettings is not None else None,
        'room_scale': room.roomScale,
        'meter_stick': room.meterStick,
    }
    # Only diff fields that were actually sent
    diff_old = {}
    diff_new = {}
    if room.placedFurniture is not None:
        diff_old['placed_furniture'] = old_state.get('placed_furniture', [])
        diff_new['placed_furniture'] = new_state['placed_furniture']
    if room.lightingSettings is not None:
        diff_old['lighting_settings'] = old_state.get('lighting_settings')
        diff_new['lighting_settings'] = new_state['lighting_settings']
    if room.roomScale is not None:
        diff_old['room_scale'] = old_state.get('room_scale')
        diff_new['room_scale'] = new_state['room_scale']
    if 'meterStick' in room.model_fields_set:
        diff_old['meter_stick'] = old_state.get('meter_stick')
        diff_new['meter_stick'] = new_state['meter_stick']

    if diff_old or diff_new:
        changes = diff_room_state(diff_old, diff_new)
        for change in changes:
            log_activity("org", org_id, change['action'], "room", resource_id=room_id, details=change.get('details'))

    if room.name is not None:
        log_activity("org", org_id, "rename_room", "room", resource_id=room_id, details={"name": room.name})

    return get_room(room_id, org_id)


@router.delete("/{room_id}")
def delete_room(room_id: str, org_id: str = Depends(verify_token)):
    verify_room_ownership(room_id, org_id)
    db = get_houses_db()

    row = db.execute(
        "SELECT background_image_path, wall_colors, original_background_key, final_image_path FROM rooms WHERE id = ?",
        [room_id]
    ).fetchone()

    layout_rows = db.execute(
        "SELECT screenshot_path FROM layouts WHERE room_id = ?", [room_id]
    ).fetchall()

    db.execute("BEGIN TRANSACTION")
    try:
        db.execute("DELETE FROM layouts WHERE room_id = ?", [room_id])
        db.execute("DELETE FROM rooms WHERE id = ?", [room_id])
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise

    keys_to_delete = [f"rooms/meshes/{room_id}.glb"]
    if row and row[0]:
        keys_to_delete.append(row[0])
    # Original background (pre-clearing)
    if row and row[2]:
        keys_to_delete.append(row[2])
    # Final image
    if row and row[3]:
        keys_to_delete.append(row[3])
    for lr in layout_rows:
        if lr[0]:
            keys_to_delete.append(lr[0])

    # Clean up wall color variant images from R2
    if row and row[1]:
        wall_colors = json.loads(row[1])
        for variant in wall_colors.get("variants", []):
            if variant.get("imagePath"):
                keys_to_delete.append(variant["imagePath"])

    r2.delete_objects(keys_to_delete)

    log_activity("org", org_id, "delete_room", "room", resource_id=room_id)
    return {"status": "deleted"}
