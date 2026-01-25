from fastapi import APIRouter, HTTPException, BackgroundTasks, UploadFile, File, Form
from typing import List
import uuid
import json
import sys
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db
from models.room import RoomCreate, RoomUpdate, RoomResponse
from config import ROOM_BACKGROUNDS, ROOM_MESHES
from utils import cleanup_entity_files, IMAGE_EXTENSIONS
from mesh_optimizer import optimize_room_mesh
from moge_client import process_image_with_modal, MoGeError

logger = logging.getLogger(__name__)

ROOM_SELECT = """
    SELECT id, house_id, name, status, error_message, background_image_path,
           placed_furniture, moge_data, lighting_settings
    FROM rooms
"""

router = APIRouter()


async def process_room_geometry(room_id: str, image_bytes: bytes):
    """
    Background task: Call Modal, optimize mesh, update room status.
    """
    db = get_houses_db()

    try:
        logger.info(f"Processing room {room_id} with Modal...")
        result = await process_image_with_modal(image_bytes)

        logger.info(f"Optimizing mesh for room {room_id}...")
        optimized_mesh = optimize_room_mesh(result["mesh_bytes"])

        ROOM_MESHES.mkdir(parents=True, exist_ok=True)
        mesh_path = ROOM_MESHES / f"{room_id}.glb"
        mesh_path.write_bytes(optimized_mesh)

        mesh_url = f"/api/files/room/{room_id}/mesh"

        image_size = result["imageSize"]
        image_aspect = image_size["width"] / image_size["height"]

        moge_data = {
            "meshUrl": mesh_url,
            "cameraFov": result["camera"]["fov"],
            "imageAspect": image_aspect
        }

        db.execute(
            "UPDATE rooms SET status = ?, moge_data = ?, error_message = NULL WHERE id = ?",
            ["ready", json.dumps(moge_data), room_id]
        )

        logger.info(f"Room {room_id} ready")

    except MoGeError as e:
        logger.error(f"Room {room_id} failed: {e}")
        db.execute(
            "UPDATE rooms SET status = ?, error_message = ? WHERE id = ?",
            ["failed", str(e), room_id]
        )
    except Exception as e:
        logger.error(f"Room {room_id} failed unexpectedly: {e}")
        db.execute(
            "UPDATE rooms SET status = ?, error_message = ? WHERE id = ?",
            ["failed", f"Unexpected error: {str(e)}", room_id]
        )


def row_to_response(row) -> RoomResponse:
    room_id = row[0]
    status = row[3] or "ready"
    error_message = row[4]
    background_path = row[5]
    placed_furniture = json.loads(row[6]) if row[6] else []
    moge_data = json.loads(row[7]) if row[7] else None
    lighting_settings = json.loads(row[8]) if row[8] else None

    background_url = f"/api/files/room/{room_id}/background" if background_path else None

    return RoomResponse(
        id=room_id,
        houseId=row[1],
        name=row[2],
        status=status,
        errorMessage=error_message,
        backgroundImageUrl=background_url,
        placedFurniture=placed_furniture,
        mogeData=moge_data,
        lightingSettings=lighting_settings
    )


@router.get("/", response_model=List[RoomResponse])
def get_all_rooms():
    db = get_houses_db()
    rows = db.execute(ROOM_SELECT).fetchall()
    return [row_to_response(row) for row in rows]


@router.get("/house/{house_id}", response_model=List[RoomResponse])
def get_rooms_by_house(house_id: str):
    db = get_houses_db()
    rows = db.execute(f"{ROOM_SELECT} WHERE house_id = ?", [house_id]).fetchall()
    return [row_to_response(row) for row in rows]


@router.get("/orphans", response_model=List[RoomResponse])
def get_orphan_rooms():
    db = get_houses_db()
    rows = db.execute(f"{ROOM_SELECT} WHERE house_id IS NULL OR house_id = ''").fetchall()
    return [row_to_response(row) for row in rows]


@router.get("/{room_id}", response_model=RoomResponse)
def get_room(room_id: str):
    db = get_houses_db()
    row = db.execute(f"{ROOM_SELECT} WHERE id = ?", [room_id]).fetchone()
    if not row:
        raise HTTPException(404, "Room not found")
    return row_to_response(row)


@router.post("/", response_model=RoomResponse)
async def create_room(
    background_tasks: BackgroundTasks,
    houseId: str = Form(...),
    name: str = Form(...),
    image: UploadFile = File(...)
):
    """
    Create a new room with background image.

    Room is created immediately with status="processing".
    Mesh generation happens in background via Modal.
    Poll GET /rooms/{id} to check when status="ready".
    """
    db = get_houses_db()

    house = db.execute("SELECT id FROM houses WHERE id = ?", [houseId]).fetchone()
    if not house:
        raise HTTPException(status_code=404, detail="House not found")

    room_id = str(uuid.uuid4())

    image_bytes = await image.read()
    ROOM_BACKGROUNDS.mkdir(parents=True, exist_ok=True)

    ext = "jpg"
    if image.content_type == "image/png":
        ext = "png"
    elif image.content_type == "image/webp":
        ext = "webp"

    image_path = ROOM_BACKGROUNDS / f"{room_id}.{ext}"
    image_path.write_bytes(image_bytes)

    background_url = f"/api/files/room/{room_id}/background"

    db.execute(
        """
        INSERT INTO rooms (id, house_id, name, status, background_image_path, placed_furniture, moge_data, lighting_settings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [room_id, houseId, name, "processing", str(image_path), "[]", None, None]
    )

    background_tasks.add_task(process_room_geometry, room_id, image_bytes)

    return RoomResponse(
        id=room_id,
        houseId=houseId,
        name=name,
        status="processing",
        backgroundImageUrl=background_url,
        placedFurniture=[],
        mogeData=None,
        lightingSettings=None
    )


@router.post("/{room_id}/retry", response_model=dict)
async def retry_room_processing(room_id: str, background_tasks: BackgroundTasks):
    """
    Retry mesh generation for a failed room.
    """
    db = get_houses_db()

    row = db.execute(
        "SELECT status, background_image_path FROM rooms WHERE id = ?",
        [room_id]
    ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Room not found")

    if row[0] != "failed":
        raise HTTPException(status_code=400, detail="Room is not in failed state")

    image_path = None
    for ext in IMAGE_EXTENSIONS:
        candidate = ROOM_BACKGROUNDS / f"{room_id}.{ext}"
        if candidate.exists():
            image_path = candidate
            break

    if not image_path:
        raise HTTPException(status_code=500, detail="Background image not found")

    image_bytes = image_path.read_bytes()

    db.execute(
        "UPDATE rooms SET status = ?, error_message = NULL WHERE id = ?",
        ["processing", room_id]
    )

    background_tasks.add_task(process_room_geometry, room_id, image_bytes)

    return {"status": "processing", "message": "Retry started"}


@router.put("/{room_id}", response_model=RoomResponse)
def update_room(room_id: str, room: RoomUpdate):
    db = get_houses_db()
    existing = db.execute("SELECT id FROM rooms WHERE id = ?", [room_id]).fetchone()
    if not existing:
        raise HTTPException(404, "Room not found")

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

    if updates:
        values.append(room_id)
        db.execute(f"UPDATE rooms SET {', '.join(updates)} WHERE id = ?", values)

    return get_room(room_id)


@router.delete("/{room_id}")
def delete_room(room_id: str):
    db = get_houses_db()
    db.execute("DELETE FROM rooms WHERE id = ?", [room_id])

    cleanup_entity_files(
        room_id,
        image_dirs=[ROOM_BACKGROUNDS],
        other_files=[ROOM_MESHES / f"{room_id}.glb"]
    )

    return {"status": "deleted"}
