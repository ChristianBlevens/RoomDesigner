from fastapi import APIRouter, HTTPException
from typing import List
import uuid
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db
from models.house import HouseCreate, HouseUpdate, HouseResponse

router = APIRouter()

@router.get("/", response_model=List[HouseResponse])
def get_all_houses():
    db = get_houses_db()
    rows = db.execute("""
        SELECT id, name, start_date, end_date, created_at
        FROM houses ORDER BY start_date
    """).fetchall()
    return [
        HouseResponse(
            id=row[0], name=row[1],
            startDate=str(row[2]), endDate=str(row[3]),
            createdAt=str(row[4]) if row[4] else None
        ) for row in rows
    ]

@router.get("/{house_id}", response_model=HouseResponse)
def get_house(house_id: str):
    db = get_houses_db()
    row = db.execute(
        "SELECT id, name, start_date, end_date, created_at FROM houses WHERE id = ?",
        [house_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "House not found")
    return HouseResponse(
        id=row[0], name=row[1],
        startDate=str(row[2]), endDate=str(row[3]),
        createdAt=str(row[4]) if row[4] else None
    )

@router.post("/", response_model=HouseResponse)
def create_house(house: HouseCreate):
    db = get_houses_db()
    house_id = house.id or str(uuid.uuid4())
    db.execute(
        "INSERT INTO houses (id, name, start_date, end_date) VALUES (?, ?, ?, ?)",
        [house_id, house.name, house.start_date, house.end_date]
    )
    return get_house(house_id)

@router.put("/{house_id}", response_model=HouseResponse)
def update_house(house_id: str, house: HouseUpdate):
    db = get_houses_db()
    existing = db.execute("SELECT id FROM houses WHERE id = ?", [house_id]).fetchone()
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

    return get_house(house_id)

@router.delete("/{house_id}")
def delete_house(house_id: str):
    db = get_houses_db()
    # Delete rooms first (cascade)
    db.execute("DELETE FROM rooms WHERE house_id = ?", [house_id])
    db.execute("DELETE FROM houses WHERE id = ?", [house_id])
    return {"status": "deleted"}
