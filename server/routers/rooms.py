from fastapi import APIRouter, HTTPException
from typing import List
import uuid
import json
import sys
import httpx
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db
from models.room import RoomCreate, RoomUpdate, RoomResponse
from config import ROOM_BACKGROUNDS, ROOM_MESHES
from utils import cleanup_entity_files
from mesh_optimizer import optimize_room_mesh

logger = logging.getLogger(__name__)

ROOM_SELECT = """
    SELECT id, house_id, name, background_image_path,
           placed_furniture, moge_data, lighting_settings
    FROM rooms
"""


async def download_mesh(room_id: str, mesh_url: str) -> str:
    """Download mesh from remote URL, optimize it, and save locally. Returns local URL."""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(mesh_url)
            if response.status_code != 200:
                raise HTTPException(502, f"Failed to download mesh: {response.status_code}")
            mesh_data = response.content
    except httpx.RequestError as e:
        raise HTTPException(502, f"Failed to download mesh: {str(e)}")

    # Optimize mesh for furniture placement (decimation + normal smoothing)
    try:
        optimized_data = optimize_room_mesh(mesh_data)
        logger.info(f"Optimized room mesh for {room_id}")
    except Exception as e:
        logger.warning(f"Mesh optimization failed, using original: {e}")
        optimized_data = mesh_data

    path = ROOM_MESHES / f"{room_id}.glb"
    path.write_bytes(optimized_data)

    return f"/api/files/room/{room_id}/mesh"

router = APIRouter()

def row_to_response(row) -> RoomResponse:
    room_id = row[0]
    background_path = row[3]
    placed_furniture = json.loads(row[4]) if row[4] else []
    moge_data = json.loads(row[5]) if row[5] else None
    lighting_settings = json.loads(row[6]) if row[6] else None

    background_url = f"/api/files/room/{room_id}/background" if background_path else None

    return RoomResponse(
        id=room_id,
        houseId=row[1],
        name=row[2],
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
async def create_room(room: RoomCreate):
    db = get_houses_db()
    room_id = room.id or str(uuid.uuid4())

    # If remoteMeshUrl provided, download mesh first (atomic - if this fails, room not created)
    moge_data = room.mogeData
    if room.remoteMeshUrl:
        local_mesh_url = await download_mesh(room_id, room.remoteMeshUrl)
        # Update mogeData with local mesh URL
        if moge_data:
            moge_data_dict = moge_data.model_dump()
            moge_data_dict['meshUrl'] = local_mesh_url
            moge_data = type(moge_data)(**moge_data_dict)

    placed_furniture_json = json.dumps([f.model_dump() for f in room.placedFurniture]) if room.placedFurniture else None
    moge_data_json = json.dumps(moge_data.model_dump()) if moge_data else None
    lighting_json = json.dumps(room.lightingSettings.model_dump()) if room.lightingSettings else None

    db.execute("""
        INSERT INTO rooms (id, house_id, name, placed_furniture, moge_data, lighting_settings)
        VALUES (?, ?, ?, ?, ?, ?)
    """, [room_id, room.houseId, room.name, placed_furniture_json, moge_data_json, lighting_json])

    return get_room(room_id)

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
