from fastapi import APIRouter, HTTPException
from typing import List
import uuid
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_furniture_db
from models.furniture import FurnitureCreate, FurnitureUpdate, FurnitureResponse
from config import FURNITURE_IMAGES, FURNITURE_PREVIEWS_3D, FURNITURE_MODELS
from utils import cleanup_entity_files

router = APIRouter()

FURNITURE_SELECT = """
    SELECT id, name, category, tags, quantity,
           dimension_x, dimension_y, dimension_z,
           image_path, preview_3d_path, model_path
    FROM furniture
"""

def row_to_response(row) -> FurnitureResponse:
    furn_id = row[0]
    tags = json.loads(row[3]) if row[3] else None

    image_url = f"/api/files/furniture/{furn_id}/image" if row[8] else None
    preview_3d_url = f"/api/files/furniture/{furn_id}/preview3d" if row[9] else None
    model_url = f"/api/files/furniture/{furn_id}/model" if row[10] else None

    return FurnitureResponse(
        id=furn_id,
        name=row[1],
        category=row[2],
        tags=tags,
        quantity=row[4] or 1,
        dimensionX=row[5],
        dimensionY=row[6],
        dimensionZ=row[7],
        imageUrl=image_url,
        preview3dUrl=preview_3d_url,
        modelUrl=model_url
    )

@router.get("/", response_model=List[FurnitureResponse])
def get_all_furniture():
    db = get_furniture_db()
    rows = db.execute(FURNITURE_SELECT).fetchall()
    return [row_to_response(row) for row in rows]

@router.get("/categories")
def get_categories():
    db = get_furniture_db()
    rows = db.execute("SELECT DISTINCT category FROM furniture WHERE category IS NOT NULL").fetchall()
    return sorted([row[0] for row in rows])

@router.get("/tags")
def get_tags():
    db = get_furniture_db()
    rows = db.execute("SELECT tags FROM furniture WHERE tags IS NOT NULL").fetchall()
    all_tags = set()
    for row in rows:
        tags = json.loads(row[0]) if row[0] else []
        all_tags.update(tags)
    return sorted(list(all_tags))

@router.get("/{furniture_id}", response_model=FurnitureResponse)
def get_furniture(furniture_id: str):
    db = get_furniture_db()
    row = db.execute(f"{FURNITURE_SELECT} WHERE id = ?", [furniture_id]).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")
    return row_to_response(row)

@router.post("/", response_model=FurnitureResponse)
def create_furniture(furniture: FurnitureCreate):
    db = get_furniture_db()
    furn_id = furniture.id or str(uuid.uuid4())
    tags_json = json.dumps(furniture.tags) if furniture.tags else None

    db.execute("""
        INSERT INTO furniture (id, name, category, tags, quantity, dimension_x, dimension_y, dimension_z)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, [furn_id, furniture.name, furniture.category, tags_json,
          furniture.quantity, furniture.dimensionX, furniture.dimensionY, furniture.dimensionZ])

    return get_furniture(furn_id)

@router.put("/{furniture_id}", response_model=FurnitureResponse)
def update_furniture(furniture_id: str, furniture: FurnitureUpdate):
    db = get_furniture_db()
    existing = db.execute("SELECT id FROM furniture WHERE id = ?", [furniture_id]).fetchone()
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
    if furniture.dimensionX is not None:
        updates.append("dimension_x = ?")
        values.append(furniture.dimensionX)
    if furniture.dimensionY is not None:
        updates.append("dimension_y = ?")
        values.append(furniture.dimensionY)
    if furniture.dimensionZ is not None:
        updates.append("dimension_z = ?")
        values.append(furniture.dimensionZ)

    if updates:
        values.append(furniture_id)
        db.execute(f"UPDATE furniture SET {', '.join(updates)} WHERE id = ?", values)

    return get_furniture(furniture_id)

@router.delete("/{furniture_id}")
def delete_furniture(furniture_id: str):
    db = get_furniture_db()
    db.execute("DELETE FROM furniture WHERE id = ?", [furniture_id])

    cleanup_entity_files(
        furniture_id,
        image_dirs=[FURNITURE_IMAGES, FURNITURE_PREVIEWS_3D],
        other_files=[FURNITURE_MODELS / f"{furniture_id}.zip"]
    )

    return {"status": "deleted"}
