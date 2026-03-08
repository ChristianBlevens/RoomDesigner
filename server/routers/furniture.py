from fastapi import APIRouter, HTTPException, Depends
from typing import List, Dict, Optional
from pydantic import BaseModel
import uuid
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_furniture_db
from models.furniture import FurnitureCreate, FurnitureUpdate, FurnitureResponse
from routers.auth import verify_token
import r2

router = APIRouter()

FURNITURE_SELECT = """
    SELECT id, name, category, tags, quantity,
           dimension_x, dimension_y, dimension_z,
           image_path, preview_3d_path, model_path
    FROM furniture
"""

def _file_url(db_path: str) -> str | None:
    """Build public URL for a furniture file stored in R2."""
    if not db_path:
        return None
    return r2.get_public_url(db_path)


def row_to_response(row) -> FurnitureResponse:
    furn_id = row[0]
    tags = json.loads(row[3]) if row[3] else None

    return FurnitureResponse(
        id=furn_id,
        name=row[1],
        category=row[2],
        tags=tags,
        quantity=row[4] or 1,
        dimensionX=row[5],
        dimensionY=row[6],
        dimensionZ=row[7],
        imageUrl=_file_url(row[8]),
        preview3dUrl=_file_url(row[9]),
        modelUrl=_file_url(row[10])
    )

@router.get("/", response_model=List[FurnitureResponse])
def get_all_furniture(org_id: str = Depends(verify_token)):
    db = get_furniture_db()
    rows = db.execute(f"{FURNITURE_SELECT} WHERE org_id = ?", [org_id]).fetchall()
    return [row_to_response(row) for row in rows]

@router.get("/categories")
def get_categories(org_id: str = Depends(verify_token)):
    db = get_furniture_db()
    rows = db.execute(
        "SELECT DISTINCT category FROM furniture WHERE category IS NOT NULL AND org_id = ?",
        [org_id]
    ).fetchall()
    return sorted([row[0] for row in rows])

@router.get("/tags")
def get_tags(org_id: str = Depends(verify_token)):
    db = get_furniture_db()
    rows = db.execute(
        "SELECT tags FROM furniture WHERE tags IS NOT NULL AND org_id = ?",
        [org_id]
    ).fetchall()
    all_tags = set()
    for row in rows:
        tags = json.loads(row[0]) if row[0] else []
        all_tags.update(tags)
    return sorted(list(all_tags))

@router.get("/{furniture_id}", response_model=FurnitureResponse)
def get_furniture(furniture_id: str, org_id: str = Depends(verify_token)):
    db = get_furniture_db()
    row = db.execute(
        f"{FURNITURE_SELECT} WHERE id = ? AND org_id = ?", [furniture_id, org_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")
    return row_to_response(row)

@router.post("/", response_model=FurnitureResponse)
def create_furniture(furniture: FurnitureCreate, org_id: str = Depends(verify_token)):
    db = get_furniture_db()
    furn_id = furniture.id or str(uuid.uuid4())
    tags_json = json.dumps(furniture.tags) if furniture.tags else None

    db.execute("""
        INSERT INTO furniture (id, org_id, name, category, tags, quantity, dimension_x, dimension_y, dimension_z)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, [furn_id, org_id, furniture.name, furniture.category, tags_json,
          furniture.quantity, furniture.dimensionX, furniture.dimensionY, furniture.dimensionZ])

    return get_furniture(furn_id, org_id)

@router.put("/{furniture_id}", response_model=FurnitureResponse)
def update_furniture(furniture_id: str, furniture: FurnitureUpdate, org_id: str = Depends(verify_token)):
    db = get_furniture_db()
    existing = db.execute(
        "SELECT id FROM furniture WHERE id = ? AND org_id = ?", [furniture_id, org_id]
    ).fetchone()
    if not existing:
        raise HTTPException(404, "Furniture not found")

    updates = []
    values = []

    if furniture.name is not None:
        updates.append("name = ?")
        values.append(furniture.name)
    if furniture.category is not None:
        updates.append("category = ?")
        values.append(furniture.category)
    if furniture.tags is not None:
        updates.append("tags = ?")
        values.append(json.dumps(furniture.tags))
    if furniture.quantity is not None:
        updates.append("quantity = ?")
        values.append(furniture.quantity)
    updates.append("dimension_x = ?")
    values.append(furniture.dimensionX)
    updates.append("dimension_y = ?")
    values.append(furniture.dimensionY)
    updates.append("dimension_z = ?")
    values.append(furniture.dimensionZ)

    if updates:
        values.append(furniture_id)
        db.execute(f"UPDATE furniture SET {', '.join(updates)} WHERE id = ?", values)

    return get_furniture(furniture_id, org_id)

@router.delete("/{furniture_id}")
def delete_furniture(furniture_id: str, org_id: str = Depends(verify_token)):
    db = get_furniture_db()
    existing = db.execute(
        "SELECT id FROM furniture WHERE id = ? AND org_id = ?", [furniture_id, org_id]
    ).fetchone()
    if not existing:
        raise HTTPException(404, "Furniture not found")
    db.execute("DELETE FROM furniture WHERE id = ?", [furniture_id])

    keys = [f"furniture/models/{furniture_id}.glb"]
    for ext in ['jpg', 'jpeg', 'png', 'webp']:
        keys.append(f"furniture/images/{furniture_id}.{ext}")
        keys.append(f"furniture/previews_3d/{furniture_id}.{ext}")
    r2.delete_objects(keys)

    return {"status": "deleted"}


# Batch availability models and endpoint

class AvailabilityRequest(BaseModel):
    entryIds: List[str]
    currentHouseId: Optional[str] = None
    currentRoomId: Optional[str] = None

class AvailabilityEntry(BaseModel):
    available: int
    total: int

@router.post("/availability", response_model=Dict[str, AvailabilityEntry])
def get_batch_availability(request: AvailabilityRequest, org_id: str = Depends(verify_token)):
    """
    Calculate availability for multiple furniture entries in a single request.
    Availability = total quantity - used in overlapping houses (excluding current room).
    """
    from db.connection import get_houses_db

    furniture_db = get_furniture_db()
    houses_db = get_houses_db()

    result = {}

    if not request.entryIds:
        return result

    placeholders = ','.join(['?' for _ in request.entryIds])
    rows = furniture_db.execute(
        f"SELECT id, quantity FROM furniture WHERE id IN ({placeholders}) AND org_id = ?",
        request.entryIds + [org_id]
    ).fetchall()

    quantities = {row[0]: row[1] or 1 for row in rows}

    if not request.currentHouseId:
        for entry_id in request.entryIds:
            total = quantities.get(entry_id, 0)
            result[entry_id] = AvailabilityEntry(available=total, total=total)
        return result

    current_house = houses_db.execute(
        "SELECT start_date, end_date FROM houses WHERE id = ? AND org_id = ?",
        [request.currentHouseId, org_id]
    ).fetchone()

    if not current_house:
        for entry_id in request.entryIds:
            total = quantities.get(entry_id, 0)
            result[entry_id] = AvailabilityEntry(available=total, total=total)
        return result

    house_start, house_end = current_house

    overlapping_houses = houses_db.execute(
        """
        SELECT id FROM houses
        WHERE org_id = ? AND start_date <= ? AND end_date >= ?
        """,
        [org_id, house_end, house_start]
    ).fetchall()

    overlapping_house_ids = [h[0] for h in overlapping_houses]

    if not overlapping_house_ids:
        for entry_id in request.entryIds:
            total = quantities.get(entry_id, 0)
            result[entry_id] = AvailabilityEntry(available=total, total=total)
        return result

    house_placeholders = ','.join(['?' for _ in overlapping_house_ids])
    rooms_query = f"""
        SELECT id, placed_furniture FROM rooms
        WHERE house_id IN ({house_placeholders})
    """
    rooms_params = list(overlapping_house_ids)

    if request.currentRoomId:
        rooms_query += " AND id != ?"
        rooms_params.append(request.currentRoomId)

    rooms = houses_db.execute(rooms_query, rooms_params).fetchall()

    placed_counts = {entry_id: 0 for entry_id in request.entryIds}

    for room_row in rooms:
        placed_furniture_json = room_row[1]
        if placed_furniture_json:
            placed_furniture = json.loads(placed_furniture_json)
            for furn in placed_furniture:
                entry_id = furn.get('entryId')
                if entry_id in placed_counts:
                    placed_counts[entry_id] += 1

    for entry_id in request.entryIds:
        total = quantities.get(entry_id, 0)
        used = placed_counts.get(entry_id, 0)
        available = max(0, total - used)
        result[entry_id] = AvailabilityEntry(available=available, total=total)

    return result
