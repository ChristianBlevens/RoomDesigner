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
from routers.auth import verify_token
import r2

logger = logging.getLogger(__name__)

ROOM_SELECT = """
    SELECT id, house_id, name, status, error_message, background_image_path,
           placed_furniture, moge_data, lighting_settings, room_scale, meter_stick,
           wall_colors, original_background_key
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

    # Resolve R2 URLs for wall color variants
    if wall_colors and wall_colors.get("variants"):
        for variant in wall_colors["variants"]:
            if variant.get("imagePath") and not variant.get("imageUrl"):
                variant["imageUrl"] = r2.get_public_url(variant["imagePath"])

    background_url = r2.get_public_url(background_path) if background_path else None
    original_bg_url = r2.get_public_url(original_bg_key) if original_bg_key else None

    return RoomResponse(
        id=room_id,
        houseId=row[1],
        name=row[2],
        status=status,
        errorMessage=error_message,
        backgroundImageUrl=background_url,
        originalBackgroundUrl=original_bg_url,
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
    org_id: str = Depends(verify_token)
):
    """
    Create a new room with background image.
    Optionally clears furniture from image via Gemini before MoGe-2 processing.
    Synchronous: waits for processing (30-90 seconds depending on clearing).
    """
    verify_house_ownership(houseId, org_id)
    db = get_houses_db()

    room_id = str(uuid.uuid4())
    image_bytes = await image.read()
    should_clear = clearFurniture.lower() == "true"

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
        try:
            from gemini_client import edit_image
            from routers.enhance import ROOM_CLEAR_PROMPT
            clear_prompt = ROOM_CLEAR_PROMPT
            if floorHint.strip():
                clear_prompt += f" The floor beneath the furniture is {floorHint.strip()}."
            cleared_bytes = await edit_image(image_bytes, clear_prompt, mime_type=image.content_type or "image/jpeg")
            moge_input_bytes = cleared_bytes
            image_bytes = cleared_bytes
        except Exception as e:
            logger.error(f"Room {room_id} furniture clearing failed: {e}")
            r2.delete_object(original_bg_key)
            raise HTTPException(status_code=502, detail=f"Furniture clearing failed: {str(e)}")

    logger.info(f"Processing room {room_id} with Modal...")
    try:
        result = await process_image_with_modal(moge_input_bytes)
    except MoGeError as e:
        logger.error(f"Room {room_id} mesh generation failed: {e}")
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

    return get_room(room_id, org_id)


@router.delete("/{room_id}")
def delete_room(room_id: str, org_id: str = Depends(verify_token)):
    verify_room_ownership(room_id, org_id)
    db = get_houses_db()

    row = db.execute(
        "SELECT background_image_path, wall_colors, original_background_key FROM rooms WHERE id = ?", [room_id]
    ).fetchone()

    layout_rows = db.execute(
        "SELECT screenshot_path FROM layouts WHERE room_id = ?", [room_id]
    ).fetchall()
    db.execute("DELETE FROM layouts WHERE room_id = ?", [room_id])
    db.execute("DELETE FROM rooms WHERE id = ?", [room_id])

    keys_to_delete = [f"rooms/meshes/{room_id}.glb"]
    if row and row[0]:
        keys_to_delete.append(row[0])
    # Original background (pre-clearing)
    if row and row[2]:
        keys_to_delete.append(row[2])
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

    return {"status": "deleted"}
