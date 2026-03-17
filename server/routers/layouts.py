from fastapi import APIRouter, HTTPException, Depends
from typing import List
import uuid
import json
import base64
import logging
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db
from models.layout import LayoutCreate, LayoutResponse
from routers.auth import verify_token
from routers.rooms import verify_room_ownership
from activity import log_activity
import r2

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_LAYOUTS_PER_ROOM = 10

LAYOUT_SELECT = """
    SELECT id, room_id, name, placed_furniture, screenshot_path, created_at
    FROM layouts
"""


def row_to_response(row) -> LayoutResponse:
    return LayoutResponse(
        id=row[0],
        roomId=row[1],
        name=row[2],
        placedFurniture=json.loads(row[3]) if row[3] else [],
        screenshotUrl=r2.get_public_url(row[4]) if row[4] else None,
        createdAt=str(row[5]) if row[5] else None
    )


@router.get("/rooms/{room_id}/layouts", response_model=List[LayoutResponse])
def get_layouts(room_id: str, org_id: str = Depends(verify_token)):
    verify_room_ownership(room_id, org_id)
    db = get_houses_db()
    rows = db.execute(
        f"{LAYOUT_SELECT} WHERE room_id = ? ORDER BY created_at DESC", [room_id]
    ).fetchall()
    return [row_to_response(row) for row in rows]


@router.post("/rooms/{room_id}/layouts", response_model=LayoutResponse)
def create_layout(room_id: str, layout: LayoutCreate, org_id: str = Depends(verify_token)):
    verify_room_ownership(room_id, org_id)
    db = get_houses_db()

    count = db.execute(
        "SELECT COUNT(*) FROM layouts WHERE room_id = ?", [room_id]
    ).fetchone()[0]
    if count >= MAX_LAYOUTS_PER_ROOM:
        raise HTTPException(400, f"Maximum {MAX_LAYOUTS_PER_ROOM} layouts per room")

    layout_id = str(uuid.uuid4())
    screenshot_path = None

    if layout.screenshot:
        try:
            image_data = base64.b64decode(layout.screenshot)
            screenshot_path = f"rooms/layouts/{layout_id}.png"
            r2.upload_bytes(screenshot_path, image_data, "image/png")
        except Exception as e:
            logger.warning(f"Failed to upload layout screenshot: {e}")

    db.execute(
        """
        INSERT INTO layouts (id, room_id, name, placed_furniture, screenshot_path)
        VALUES (?, ?, ?, ?, ?)
        """,
        [layout_id, room_id, layout.name,
         json.dumps(layout.placedFurniture), screenshot_path]
    )

    log_activity("org", org_id, "create_layout", "layout", resource_id=layout_id, resource_name=layout.name,
                 details={"room_id": room_id})
    row = db.execute(f"{LAYOUT_SELECT} WHERE id = ?", [layout_id]).fetchone()
    return row_to_response(row)


@router.get("/rooms/{room_id}/layouts/{layout_id}", response_model=LayoutResponse)
def get_layout(room_id: str, layout_id: str, org_id: str = Depends(verify_token)):
    verify_room_ownership(room_id, org_id)
    db = get_houses_db()
    row = db.execute(
        f"{LAYOUT_SELECT} WHERE id = ? AND room_id = ?", [layout_id, room_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Layout not found")
    return row_to_response(row)


@router.delete("/rooms/{room_id}/layouts/{layout_id}")
def delete_layout(room_id: str, layout_id: str, org_id: str = Depends(verify_token)):
    verify_room_ownership(room_id, org_id)
    db = get_houses_db()

    row = db.execute(
        "SELECT screenshot_path FROM layouts WHERE id = ? AND room_id = ?",
        [layout_id, room_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Layout not found")

    db.execute("DELETE FROM layouts WHERE id = ?", [layout_id])

    if row[0]:
        r2.delete_object(row[0])

    log_activity("org", org_id, "delete_layout", "layout", resource_id=layout_id, details={"room_id": room_id})
    return {"status": "deleted"}
