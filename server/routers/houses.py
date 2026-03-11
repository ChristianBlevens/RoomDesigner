from fastapi import APIRouter, HTTPException, Depends
from typing import List
import uuid
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db
from models.house import HouseCreate, HouseUpdate, HouseResponse
from routers.auth import verify_token
import r2

router = APIRouter()

@router.get("/", response_model=List[HouseResponse])
def get_all_houses(org_id: str = Depends(verify_token)):
    db = get_houses_db()
    rows = db.execute("""
        SELECT id, name, start_date, end_date, created_at, share_token
        FROM houses WHERE org_id = ? ORDER BY start_date
    """, [org_id]).fetchall()
    return [
        HouseResponse(
            id=row[0], name=row[1],
            startDate=str(row[2]), endDate=str(row[3]),
            createdAt=str(row[4]) if row[4] else None,
            shareToken=row[5]
        ) for row in rows
    ]

@router.get("/{house_id}", response_model=HouseResponse)
def get_house(house_id: str, org_id: str = Depends(verify_token)):
    db = get_houses_db()
    row = db.execute(
        "SELECT id, name, start_date, end_date, created_at, share_token FROM houses WHERE id = ? AND org_id = ?",
        [house_id, org_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "House not found")
    return HouseResponse(
        id=row[0], name=row[1],
        startDate=str(row[2]), endDate=str(row[3]),
        createdAt=str(row[4]) if row[4] else None,
        shareToken=row[5]
    )

@router.post("/", response_model=HouseResponse)
def create_house(house: HouseCreate, org_id: str = Depends(verify_token)):
    db = get_houses_db()
    house_id = house.id or str(uuid.uuid4())
    db.execute(
        "INSERT INTO houses (id, org_id, name, start_date, end_date) VALUES (?, ?, ?, ?, ?)",
        [house_id, org_id, house.name, house.start_date, house.end_date]
    )
    return get_house(house_id, org_id)

@router.put("/{house_id}", response_model=HouseResponse)
def update_house(house_id: str, house: HouseUpdate, org_id: str = Depends(verify_token)):
    db = get_houses_db()
    existing = db.execute(
        "SELECT id FROM houses WHERE id = ? AND org_id = ?", [house_id, org_id]
    ).fetchone()
    if not existing:
        raise HTTPException(404, "House not found")

    updates = []
    values = []
    if house.name is not None:
        updates.append("name = ?")
        values.append(house.name)
    if house.start_date is not None:
        updates.append("start_date = ?")
        values.append(house.start_date)
    if house.end_date is not None:
        updates.append("end_date = ?")
        values.append(house.end_date)

    if updates:
        values.append(house_id)
        db.execute(f"UPDATE houses SET {', '.join(updates)} WHERE id = ?", values)

    return get_house(house_id, org_id)

@router.delete("/{house_id}")
def delete_house(house_id: str, org_id: str = Depends(verify_token)):
    db = get_houses_db()
    existing = db.execute(
        "SELECT id FROM houses WHERE id = ? AND org_id = ?", [house_id, org_id]
    ).fetchone()
    if not existing:
        raise HTTPException(404, "House not found")

    layout_rows = db.execute("""
        SELECT screenshot_path FROM layouts
        WHERE room_id IN (SELECT id FROM rooms WHERE house_id = ?)
    """, [house_id]).fetchall()
    layout_r2_keys = [lr[0] for lr in layout_rows if lr[0]]

    # Collect wall color variant R2 keys, original backgrounds, and final images
    import json
    wc_rows = db.execute("""
        SELECT wall_colors, original_background_key, final_image_path FROM rooms
        WHERE house_id = ? AND (wall_colors IS NOT NULL OR original_background_key IS NOT NULL OR final_image_path IS NOT NULL)
    """, [house_id]).fetchall()
    wc_r2_keys = []
    for wc_row in wc_rows:
        if wc_row[0]:
            wc = json.loads(wc_row[0])
            for variant in wc.get("variants", []):
                if variant.get("imagePath"):
                    wc_r2_keys.append(variant["imagePath"])
        if wc_row[1]:
            wc_r2_keys.append(wc_row[1])
        if wc_row[2]:
            wc_r2_keys.append(wc_row[2])

    db.execute("""
        DELETE FROM layouts
        WHERE room_id IN (SELECT id FROM rooms WHERE house_id = ?)
    """, [house_id])
    db.execute("DELETE FROM rooms WHERE house_id = ?", [house_id])
    db.execute("DELETE FROM houses WHERE id = ?", [house_id])

    all_keys = layout_r2_keys + wc_r2_keys
    if all_keys:
        r2.delete_objects(all_keys)

    return {"status": "deleted"}
