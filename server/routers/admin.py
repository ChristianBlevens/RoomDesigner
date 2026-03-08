"""
Admin panel API router.
All endpoints require admin JWT token.
Provides full CRUD access to all org data for support and diagnostics.
"""

import json
import logging
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Query

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_auth_db, get_houses_db, get_furniture_db
from routers.auth import verify_admin
from model_processor import ModelProcessor
from moge_client import process_image_with_modal, MoGeError
import r2

logger = logging.getLogger(__name__)

router = APIRouter()


# ============ Orgs ============

@router.get("/orgs")
def list_orgs(
    q: Optional[str] = Query(None),
    is_admin: bool = Depends(verify_admin)
):
    auth_db = get_auth_db()
    houses_db = get_houses_db()
    furniture_db = get_furniture_db()

    if q:
        orgs = auth_db.execute(
            "SELECT id, username, created_at FROM orgs WHERE username ILIKE ?",
            [f"%{q}%"]
        ).fetchall()
    else:
        orgs = auth_db.execute(
            "SELECT id, username, created_at FROM orgs ORDER BY created_at DESC"
        ).fetchall()

    result = []
    for org in orgs:
        org_id = org[0]
        house_count = houses_db.execute(
            "SELECT COUNT(*) FROM houses WHERE org_id = ?", [org_id]
        ).fetchone()[0]
        furniture_count = furniture_db.execute(
            "SELECT COUNT(*) FROM furniture WHERE org_id = ?", [org_id]
        ).fetchone()[0]
        result.append({
            "id": org_id,
            "username": org[1],
            "createdAt": str(org[2]) if org[2] else None,
            "houseCount": house_count,
            "furnitureCount": furniture_count,
        })

    return result


@router.delete("/orgs/{org_id}")
def delete_org(org_id: str, is_admin: bool = Depends(verify_admin)):
    auth_db = get_auth_db()
    houses_db = get_houses_db()
    furniture_db = get_furniture_db()

    # Verify org exists
    org = auth_db.execute("SELECT id FROM orgs WHERE id = ?", [org_id]).fetchone()
    if not org:
        raise HTTPException(404, "Org not found")

    # Delete all furniture R2 assets and records
    furn_rows = furniture_db.execute(
        "SELECT id, image_path, preview_3d_path, model_path FROM furniture WHERE org_id = ?",
        [org_id]
    ).fetchall()
    r2_keys = []
    for row in furn_rows:
        for path in row[1:]:
            if path:
                r2_keys.append(path)
    furniture_db.execute("DELETE FROM meshy_tasks WHERE furniture_id IN (SELECT id FROM furniture WHERE org_id = ?)", [org_id])
    furniture_db.execute("DELETE FROM furniture WHERE org_id = ?", [org_id])

    # Delete all rooms R2 assets and records
    room_rows = houses_db.execute("""
        SELECT r.id, r.background_image_path, r.wall_colors FROM rooms r
        JOIN houses h ON r.house_id = h.id
        WHERE h.org_id = ?
    """, [org_id]).fetchall()
    for row in room_rows:
        room_id = row[0]
        if row[1]:
            r2_keys.append(row[1])
        r2_keys.append(f"rooms/meshes/{room_id}.glb")
        if row[2]:
            wc = json.loads(row[2])
            for variant in wc.get("variants", []):
                if variant.get("imagePath"):
                    r2_keys.append(variant["imagePath"])

    layout_rows = houses_db.execute("""
        SELECT screenshot_path FROM layouts
        WHERE room_id IN (
            SELECT id FROM rooms WHERE house_id IN (
                SELECT id FROM houses WHERE org_id = ?
            )
        )
    """, [org_id]).fetchall()
    for lr in layout_rows:
        if lr[0]:
            r2_keys.append(lr[0])
    houses_db.execute("""
        DELETE FROM layouts
        WHERE room_id IN (
            SELECT id FROM rooms WHERE house_id IN (
                SELECT id FROM houses WHERE org_id = ?
            )
        )
    """, [org_id])
    houses_db.execute("""
        DELETE FROM rooms WHERE house_id IN (SELECT id FROM houses WHERE org_id = ?)
    """, [org_id])
    houses_db.execute("DELETE FROM houses WHERE org_id = ?", [org_id])

    # Delete org
    auth_db.execute("DELETE FROM orgs WHERE id = ?", [org_id])

    # Batch delete R2 objects
    if r2_keys:
        r2.delete_objects(r2_keys)

    logger.info(f"Admin deleted org {org_id} with {len(furn_rows)} furniture, {len(room_rows)} rooms")
    return {"status": "deleted", "r2_objects_deleted": len(r2_keys)}


# ============ Houses ============

@router.get("/houses")
def list_houses(
    q: Optional[str] = Query(None),
    org_id: Optional[str] = Query(None),
    start_after: Optional[str] = Query(None),
    end_before: Optional[str] = Query(None),
    is_admin: bool = Depends(verify_admin)
):
    db = get_houses_db()
    auth_db = get_auth_db()

    query = """
        SELECT h.id, h.org_id, h.name, h.start_date, h.end_date, h.created_at,
               (SELECT COUNT(*) FROM rooms r WHERE r.house_id = h.id) as room_count
        FROM houses h
        WHERE 1=1
    """
    params = []

    if org_id:
        query += " AND h.org_id = ?"
        params.append(org_id)
    if q:
        query += " AND h.name ILIKE ?"
        params.append(f"%{q}%")
    if start_after:
        query += " AND h.start_date >= ?"
        params.append(start_after)
    if end_before:
        query += " AND h.end_date <= ?"
        params.append(end_before)

    query += " ORDER BY h.start_date DESC"
    rows = db.execute(query, params).fetchall()

    # Build org username lookup
    org_ids = list(set(row[1] for row in rows))
    org_names = {}
    for oid in org_ids:
        org_row = auth_db.execute("SELECT username FROM orgs WHERE id = ?", [oid]).fetchone()
        org_names[oid] = org_row[0] if org_row else "Unknown"

    return [{
        "id": row[0],
        "orgId": row[1],
        "orgUsername": org_names.get(row[1], "Unknown"),
        "name": row[2],
        "startDate": str(row[3]) if row[3] else None,
        "endDate": str(row[4]) if row[4] else None,
        "createdAt": str(row[5]) if row[5] else None,
        "roomCount": row[6],
    } for row in rows]


@router.get("/houses/{house_id}")
def get_house(house_id: str, is_admin: bool = Depends(verify_admin)):
    db = get_houses_db()
    row = db.execute(
        "SELECT id, org_id, name, start_date, end_date FROM houses WHERE id = ?",
        [house_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "House not found")

    rooms = db.execute("""
        SELECT id, name, status, error_message, background_image_path
        FROM rooms WHERE house_id = ?
    """, [house_id]).fetchall()

    return {
        "id": row[0],
        "orgId": row[1],
        "name": row[2],
        "startDate": str(row[3]) if row[3] else None,
        "endDate": str(row[4]) if row[4] else None,
        "rooms": [{
            "id": r[0],
            "name": r[1],
            "status": r[2],
            "errorMessage": r[3],
            "backgroundUrl": r2.get_public_url(r[4]) if r[4] else None,
        } for r in rooms]
    }


@router.put("/houses/{house_id}")
def update_house(house_id: str, body: dict, is_admin: bool = Depends(verify_admin)):
    db = get_houses_db()
    row = db.execute("SELECT id FROM houses WHERE id = ?", [house_id]).fetchone()
    if not row:
        raise HTTPException(404, "House not found")

    updates = []
    values = []
    if "name" in body:
        updates.append("name = ?")
        values.append(body["name"])
    if "startDate" in body:
        updates.append("start_date = ?")
        values.append(body["startDate"])
    if "endDate" in body:
        updates.append("end_date = ?")
        values.append(body["endDate"])

    if updates:
        values.append(house_id)
        db.execute(f"UPDATE houses SET {', '.join(updates)} WHERE id = ?", values)

    return {"status": "updated"}


@router.delete("/houses/{house_id}")
def delete_house(house_id: str, is_admin: bool = Depends(verify_admin)):
    db = get_houses_db()
    row = db.execute("SELECT id FROM houses WHERE id = ?", [house_id]).fetchone()
    if not row:
        raise HTTPException(404, "House not found")

    # Collect R2 keys from rooms
    rooms = db.execute(
        "SELECT id, background_image_path, wall_colors FROM rooms WHERE house_id = ?", [house_id]
    ).fetchall()
    r2_keys = []
    for room in rooms:
        if room[1]:
            r2_keys.append(room[1])
        r2_keys.append(f"rooms/meshes/{room[0]}.glb")
        if room[2]:
            wc = json.loads(room[2])
            for variant in wc.get("variants", []):
                if variant.get("imagePath"):
                    r2_keys.append(variant["imagePath"])

    layout_rows = db.execute("""
        SELECT screenshot_path FROM layouts
        WHERE room_id IN (SELECT id FROM rooms WHERE house_id = ?)
    """, [house_id]).fetchall()
    for lr in layout_rows:
        if lr[0]:
            r2_keys.append(lr[0])
    db.execute("""
        DELETE FROM layouts
        WHERE room_id IN (SELECT id FROM rooms WHERE house_id = ?)
    """, [house_id])
    db.execute("DELETE FROM rooms WHERE house_id = ?", [house_id])
    db.execute("DELETE FROM houses WHERE id = ?", [house_id])

    if r2_keys:
        r2.delete_objects(r2_keys)

    return {"status": "deleted", "r2_objects_deleted": len(r2_keys)}


# ============ Rooms ============

@router.get("/rooms")
def list_rooms(
    q: Optional[str] = Query(None),
    org_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    is_admin: bool = Depends(verify_admin)
):
    db = get_houses_db()
    auth_db = get_auth_db()

    query = """
        SELECT r.id, r.house_id, r.name, r.status, r.error_message,
               r.background_image_path, r.moge_data, r.placed_furniture,
               h.name as house_name, h.org_id
        FROM rooms r
        JOIN houses h ON r.house_id = h.id
        WHERE 1=1
    """
    params = []

    if org_id:
        query += " AND h.org_id = ?"
        params.append(org_id)
    if q:
        query += " AND (r.name ILIKE ? OR h.name ILIKE ?)"
        params.extend([f"%{q}%", f"%{q}%"])
    if status:
        query += " AND r.status = ?"
        params.append(status)

    query += " ORDER BY r.created_at DESC"
    rows = db.execute(query, params).fetchall()

    # Org username lookup
    org_ids = list(set(row[9] for row in rows))
    org_names = {}
    for oid in org_ids:
        org_row = auth_db.execute("SELECT username FROM orgs WHERE id = ?", [oid]).fetchone()
        org_names[oid] = org_row[0] if org_row else "Unknown"

    return [{
        "id": row[0],
        "houseId": row[1],
        "name": row[2],
        "status": row[3],
        "errorMessage": row[4],
        "backgroundUrl": r2.get_public_url(row[5]) if row[5] else None,
        "hasMogeData": row[6] is not None,
        "furnitureCount": len(json.loads(row[7])) if row[7] else 0,
        "houseName": row[8],
        "orgId": row[9],
        "orgUsername": org_names.get(row[9], "Unknown"),
    } for row in rows]


@router.get("/rooms/{room_id}")
def get_room(room_id: str, is_admin: bool = Depends(verify_admin)):
    db = get_houses_db()
    row = db.execute("""
        SELECT r.id, r.house_id, r.name, r.status, r.error_message,
               r.background_image_path, r.moge_data, r.placed_furniture,
               r.lighting_settings, r.room_scale,
               h.name as house_name, h.org_id
        FROM rooms r
        JOIN houses h ON r.house_id = h.id
        WHERE r.id = ?
    """, [room_id]).fetchone()

    if not row:
        raise HTTPException(404, "Room not found")

    moge_data = json.loads(row[6]) if row[6] else None
    placed = json.loads(row[7]) if row[7] else []
    lighting = json.loads(row[8]) if row[8] else None

    return {
        "id": row[0],
        "houseId": row[1],
        "name": row[2],
        "status": row[3],
        "errorMessage": row[4],
        "backgroundUrl": r2.get_public_url(row[5]) if row[5] else None,
        "mogeData": moge_data,
        "placedFurniture": placed,
        "lightingSettings": lighting,
        "roomScale": row[9] if row[9] is not None else 1.0,
        "houseName": row[10],
        "orgId": row[11],
        "meshUrl": r2.get_public_url(f"rooms/meshes/{row[0]}.glb"),
    }


@router.delete("/rooms/{room_id}")
def delete_room(room_id: str, is_admin: bool = Depends(verify_admin)):
    db = get_houses_db()
    row = db.execute(
        "SELECT id, background_image_path, wall_colors FROM rooms WHERE id = ?", [room_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Room not found")

    r2_keys = [f"rooms/meshes/{room_id}.glb"]
    if row[1]:
        r2_keys.append(row[1])
    if row[2]:
        wc = json.loads(row[2])
        for variant in wc.get("variants", []):
            if variant.get("imagePath"):
                r2_keys.append(variant["imagePath"])

    layout_rows = db.execute(
        "SELECT screenshot_path FROM layouts WHERE room_id = ?", [room_id]
    ).fetchall()
    for lr in layout_rows:
        if lr[0]:
            r2_keys.append(lr[0])
    db.execute("DELETE FROM layouts WHERE room_id = ?", [room_id])
    db.execute("DELETE FROM rooms WHERE id = ?", [room_id])
    r2.delete_objects(r2_keys)

    return {"status": "deleted"}


@router.post("/rooms/{room_id}/regenerate-mesh")
async def regenerate_mesh(room_id: str, is_admin: bool = Depends(verify_admin)):
    """Re-run MoGe-2 on the room's existing background image."""
    db = get_houses_db()
    row = db.execute(
        "SELECT background_image_path FROM rooms WHERE id = ?", [room_id]
    ).fetchone()
    if not row or not row[0]:
        raise HTTPException(404, "Room has no background image")

    # Download background from R2
    image_bytes = r2.download_bytes(row[0])
    if not image_bytes:
        raise HTTPException(404, "Background image not found in storage")

    # Process with MoGe-2
    try:
        result = await process_image_with_modal(image_bytes)
    except MoGeError as e:
        raise HTTPException(502, f"Mesh generation failed: {str(e)}")

    # Upload new mesh to R2
    mesh_key = f"rooms/meshes/{room_id}.glb"
    r2.upload_bytes(mesh_key, result["mesh_bytes"], "model/gltf-binary")

    # Update moge_data
    image_size = result["imageSize"]
    image_aspect = image_size["width"] / image_size["height"]
    moge_data = {
        "meshUrl": r2.get_public_url(mesh_key),
        "cameraFov": result["camera"]["fov"],
        "imageAspect": image_aspect
    }
    db.execute(
        "UPDATE rooms SET moge_data = ?, status = 'ready', error_message = NULL WHERE id = ?",
        [json.dumps(moge_data), room_id]
    )

    logger.info(f"Admin regenerated mesh for room {room_id}")
    return {"status": "regenerated", "mogeData": moge_data}


@router.post("/rooms/{room_id}/reupload-background")
async def reupload_background(
    room_id: str,
    file: UploadFile = File(...),
    is_admin: bool = Depends(verify_admin)
):
    db = get_houses_db()
    row = db.execute("SELECT id FROM rooms WHERE id = ?", [room_id]).fetchone()
    if not row:
        raise HTTPException(404, "Room not found")

    content = await file.read()
    ext = file.filename.split('.')[-1].lower() if '.' in file.filename else 'jpg'
    bg_key = f"rooms/backgrounds/{room_id}.{ext}"
    r2.upload_bytes(bg_key, content, file.content_type or "image/jpeg")
    db.execute("UPDATE rooms SET background_image_path = ? WHERE id = ?", [bg_key, room_id])

    return {"status": "uploaded", "url": r2.get_public_url(bg_key)}


# ============ Furniture ============

@router.get("/furniture")
def list_furniture(
    q: Optional[str] = Query(None),
    org_id: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    has_model: Optional[bool] = Query(None),
    has_image: Optional[bool] = Query(None),
    is_admin: bool = Depends(verify_admin)
):
    db = get_furniture_db()
    auth_db = get_auth_db()

    query = """
        SELECT id, org_id, name, category, tags, quantity,
               dimension_x, dimension_y, dimension_z,
               image_path, preview_3d_path, model_path
        FROM furniture WHERE 1=1
    """
    params = []

    if org_id:
        query += " AND org_id = ?"
        params.append(org_id)
    if q:
        query += " AND name ILIKE ?"
        params.append(f"%{q}%")
    if category:
        query += " AND category = ?"
        params.append(category)
    if has_model is True:
        query += " AND model_path IS NOT NULL"
    elif has_model is False:
        query += " AND model_path IS NULL"
    if has_image is True:
        query += " AND image_path IS NOT NULL"
    elif has_image is False:
        query += " AND image_path IS NULL"

    query += " ORDER BY created_at DESC"
    rows = db.execute(query, params).fetchall()

    # Org username lookup
    org_ids = list(set(row[1] for row in rows))
    org_names = {}
    for oid in org_ids:
        org_row = auth_db.execute("SELECT username FROM orgs WHERE id = ?", [oid]).fetchone()
        org_names[oid] = org_row[0] if org_row else "Unknown"

    return [{
        "id": row[0],
        "orgId": row[1],
        "orgUsername": org_names.get(row[1], "Unknown"),
        "name": row[2],
        "category": row[3],
        "tags": json.loads(row[4]) if row[4] else None,
        "quantity": row[5] or 1,
        "dimensionX": row[6],
        "dimensionY": row[7],
        "dimensionZ": row[8],
        "imageUrl": r2.get_public_url(row[9]) if row[9] else None,
        "preview3dUrl": r2.get_public_url(row[10]) if row[10] else None,
        "modelUrl": r2.get_public_url(row[11]) if row[11] else None,
        "hasImage": row[9] is not None,
        "hasModel": row[11] is not None,
    } for row in rows]


@router.get("/furniture/{furniture_id}")
def get_furniture(furniture_id: str, is_admin: bool = Depends(verify_admin)):
    db = get_furniture_db()
    row = db.execute("""
        SELECT id, org_id, name, category, tags, quantity,
               dimension_x, dimension_y, dimension_z,
               image_path, preview_3d_path, model_path
        FROM furniture WHERE id = ?
    """, [furniture_id]).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")

    return {
        "id": row[0],
        "orgId": row[1],
        "name": row[2],
        "category": row[3],
        "tags": json.loads(row[4]) if row[4] else None,
        "quantity": row[5] or 1,
        "dimensionX": row[6],
        "dimensionY": row[7],
        "dimensionZ": row[8],
        "imageUrl": r2.get_public_url(row[9]) if row[9] else None,
        "preview3dUrl": r2.get_public_url(row[10]) if row[10] else None,
        "modelUrl": r2.get_public_url(row[11]) if row[11] else None,
    }


@router.put("/furniture/{furniture_id}")
def update_furniture(furniture_id: str, body: dict, is_admin: bool = Depends(verify_admin)):
    db = get_furniture_db()
    row = db.execute("SELECT id FROM furniture WHERE id = ?", [furniture_id]).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")

    field_map = {
        "name": "name",
        "category": "category",
        "quantity": "quantity",
        "dimensionX": "dimension_x",
        "dimensionY": "dimension_y",
        "dimensionZ": "dimension_z",
    }

    updates = []
    values = []
    for json_key, db_col in field_map.items():
        if json_key in body:
            updates.append(f"{db_col} = ?")
            values.append(body[json_key])
    if "tags" in body:
        updates.append("tags = ?")
        values.append(json.dumps(body["tags"]) if body["tags"] else None)

    if updates:
        values.append(furniture_id)
        db.execute(f"UPDATE furniture SET {', '.join(updates)} WHERE id = ?", values)

    return {"status": "updated"}


@router.delete("/furniture/{furniture_id}")
def delete_furniture(furniture_id: str, is_admin: bool = Depends(verify_admin)):
    db = get_furniture_db()
    row = db.execute(
        "SELECT image_path, preview_3d_path, model_path FROM furniture WHERE id = ?",
        [furniture_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")

    r2_keys = [p for p in row if p]
    db.execute("DELETE FROM meshy_tasks WHERE furniture_id = ?", [furniture_id])
    db.execute("DELETE FROM furniture WHERE id = ?", [furniture_id])

    if r2_keys:
        r2.delete_objects(r2_keys)

    return {"status": "deleted"}


@router.delete("/furniture/{furniture_id}/image")
def delete_furniture_image(furniture_id: str, is_admin: bool = Depends(verify_admin)):
    db = get_furniture_db()
    row = db.execute("SELECT image_path FROM furniture WHERE id = ?", [furniture_id]).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")
    if row[0]:
        r2.delete_object(row[0])
    db.execute("UPDATE furniture SET image_path = NULL WHERE id = ?", [furniture_id])
    return {"status": "deleted"}


@router.delete("/furniture/{furniture_id}/model")
def delete_furniture_model(furniture_id: str, is_admin: bool = Depends(verify_admin)):
    db = get_furniture_db()
    row = db.execute(
        "SELECT model_path, preview_3d_path FROM furniture WHERE id = ?", [furniture_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")
    r2_keys = [p for p in row if p]
    if r2_keys:
        r2.delete_objects(r2_keys)
    db.execute(
        "UPDATE furniture SET model_path = NULL, preview_3d_path = NULL WHERE id = ?",
        [furniture_id]
    )
    return {"status": "deleted"}


@router.post("/furniture/{furniture_id}/reupload-image")
async def reupload_furniture_image(
    furniture_id: str,
    file: UploadFile = File(...),
    is_admin: bool = Depends(verify_admin)
):
    db = get_furniture_db()
    row = db.execute("SELECT id FROM furniture WHERE id = ?", [furniture_id]).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")

    content = await file.read()
    ext = file.filename.split('.')[-1].lower() if '.' in file.filename else 'jpg'
    key = f"furniture/images/{furniture_id}.{ext}"
    r2.upload_bytes(key, content, file.content_type or "image/jpeg")
    db.execute("UPDATE furniture SET image_path = ? WHERE id = ?", [key, furniture_id])

    return {"status": "uploaded", "url": r2.get_public_url(key)}


@router.post("/furniture/{furniture_id}/reupload-model")
async def reupload_furniture_model(
    furniture_id: str,
    file: UploadFile = File(...),
    is_admin: bool = Depends(verify_admin)
):
    db = get_furniture_db()
    row = db.execute("SELECT image_path FROM furniture WHERE id = ?", [furniture_id]).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")

    content = await file.read()
    has_image = row[0] is not None

    processor = ModelProcessor()
    result = processor.process_glb(
        content, origin_placement='bottom-center', generate_preview=not has_image
    )

    model_key = f"furniture/models/{furniture_id}.glb"
    r2.upload_bytes(model_key, result['glb'], 'model/gltf-binary')

    preview_key = None
    if result['preview']:
        preview_key = f"furniture/previews_3d/{furniture_id}.png"
        r2.upload_bytes(preview_key, result['preview'], 'image/png')

    if preview_key:
        db.execute(
            "UPDATE furniture SET model_path = ?, preview_3d_path = ? WHERE id = ?",
            [model_key, preview_key, furniture_id]
        )
    else:
        db.execute(
            "UPDATE furniture SET model_path = ? WHERE id = ?",
            [model_key, furniture_id]
        )

    return {"status": "uploaded", "url": r2.get_public_url(model_key)}


@router.post("/furniture/{furniture_id}/regenerate-model")
async def regenerate_model(furniture_id: str, is_admin: bool = Depends(verify_admin)):
    """Trigger Meshy.ai 3D generation for this furniture item."""
    from routers.meshy import create_task, count_active_tasks, MAX_CONCURRENT_TASKS

    db = get_furniture_db()
    row = db.execute(
        "SELECT image_path FROM furniture WHERE id = ?", [furniture_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")
    if not row[0]:
        raise HTTPException(400, "Furniture has no image to generate from")

    active = count_active_tasks()
    if active >= MAX_CONCURRENT_TASKS:
        raise HTTPException(429, f"Max concurrent tasks ({MAX_CONCURRENT_TASKS}) reached")

    task_id = create_task(furniture_id)
    return {"status": "started", "taskId": task_id}


# ============ Meshy Tasks ============

@router.get("/meshy-tasks")
def list_meshy_tasks(
    status: Optional[str] = Query(None),
    org_id: Optional[str] = Query(None),
    is_admin: bool = Depends(verify_admin)
):
    db = get_furniture_db()
    auth_db = get_auth_db()

    query = """
        SELECT t.id, t.furniture_id, t.status, t.progress, t.retry_count,
               t.error_message, t.created_at, t.updated_at,
               f.name as furniture_name, f.org_id
        FROM meshy_tasks t
        LEFT JOIN furniture f ON t.furniture_id = f.id
        WHERE 1=1
    """
    params = []

    if status:
        query += " AND t.status = ?"
        params.append(status)
    if org_id:
        query += " AND f.org_id = ?"
        params.append(org_id)

    query += " ORDER BY t.created_at DESC"
    rows = db.execute(query, params).fetchall()

    # Org username lookup
    org_ids = list(set(row[9] for row in rows if row[9]))
    org_names = {}
    for oid in org_ids:
        org_row = auth_db.execute("SELECT username FROM orgs WHERE id = ?", [oid]).fetchone()
        org_names[oid] = org_row[0] if org_row else "Unknown"

    return [{
        "id": row[0],
        "furnitureId": row[1],
        "status": row[2],
        "progress": row[3],
        "retryCount": row[4],
        "errorMessage": row[5],
        "createdAt": str(row[6]) if row[6] else None,
        "updatedAt": str(row[7]) if row[7] else None,
        "furnitureName": row[8] or "Unknown",
        "orgId": row[9],
        "orgUsername": org_names.get(row[9], "Unknown"),
    } for row in rows]


# ============ R2 Cleanup ============

@router.post("/r2/scan")
def scan_r2_orphans(is_admin: bool = Depends(verify_admin)):
    """Scan R2 for objects not referenced by any DB record."""
    houses_db = get_houses_db()
    furniture_db = get_furniture_db()

    # Collect all expected R2 keys from DB
    expected = set()

    # Room backgrounds
    rows = houses_db.execute(
        "SELECT background_image_path FROM rooms WHERE background_image_path IS NOT NULL"
    ).fetchall()
    for row in rows:
        if row[0]:
            expected.add(row[0])

    # Room meshes (implicit key for rooms with moge_data)
    rows = houses_db.execute(
        "SELECT id FROM rooms WHERE moge_data IS NOT NULL"
    ).fetchall()
    for row in rows:
        expected.add(f"rooms/meshes/{row[0]}.glb")

    # Layout screenshots
    rows = houses_db.execute(
        "SELECT screenshot_path FROM layouts WHERE screenshot_path IS NOT NULL"
    ).fetchall()
    for row in rows:
        if row[0]:
            expected.add(row[0])

    # Furniture assets
    rows = furniture_db.execute(
        "SELECT image_path, preview_3d_path, model_path FROM furniture"
    ).fetchall()
    for row in rows:
        for path in row:
            if path:
                expected.add(path)

    # List all R2 objects
    client = r2.get_client()
    all_keys = set()
    paginator = client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=r2.R2_BUCKET_NAME):
        for obj in page.get('Contents', []):
            all_keys.add(obj['Key'])

    orphaned = sorted(all_keys - expected)

    logger.info(f"R2 scan: {len(all_keys)} total, {len(expected)} expected, {len(orphaned)} orphaned")
    return {
        "totalR2": len(all_keys),
        "totalExpected": len(expected),
        "orphanedCount": len(orphaned),
        "orphanedKeys": orphaned,
    }


@router.post("/r2/cleanup")
def cleanup_r2_orphans(is_admin: bool = Depends(verify_admin)):
    """Delete orphaned R2 objects (runs scan then deletes)."""
    scan = scan_r2_orphans(is_admin)
    keys = scan["orphanedKeys"]

    if keys:
        r2.delete_objects(keys)
        logger.info(f"R2 cleanup: deleted {len(keys)} orphaned objects")

    return {"deletedCount": len(keys)}


@router.delete("/meshy-tasks/{task_id}")
def delete_meshy_task(task_id: str, is_admin: bool = Depends(verify_admin)):
    db = get_furniture_db()
    row = db.execute("SELECT id FROM meshy_tasks WHERE id = ?", [task_id]).fetchone()
    if not row:
        raise HTTPException(404, "Task not found")
    db.execute("DELETE FROM meshy_tasks WHERE id = ?", [task_id])
    return {"status": "deleted"}
