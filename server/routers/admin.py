"""
Admin panel API router.
All endpoints require admin JWT token.
Provides full CRUD access to all org data for support and diagnostics.
"""

import json
import logging
import uuid
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Query
import bcrypt

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_auth_db, get_houses_db, get_furniture_db
from routers.auth import verify_admin, create_impersonation_token
from usage import DEFAULT_ALLOWANCES, create_default_allowances
from activity import log_activity
from model_processor import ModelProcessor
from moge_client import process_image_with_modal, MoGeError
from circuit_breaker import moge_breaker
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
            "SELECT id, username, created_at, demo_mode, last_login, login_count FROM orgs WHERE username ILIKE ?",
            [f"%{q}%"]
        ).fetchall()
    else:
        orgs = auth_db.execute(
            "SELECT id, username, created_at, demo_mode, last_login, login_count FROM orgs ORDER BY created_at DESC"
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
            "demoMode": bool(org[3]),
            "lastLogin": str(org[4]) if org[4] else None,
            "loginCount": org[5] or 0,
            "houseCount": house_count,
            "furnitureCount": furniture_count,
        })

    return result


@router.post("/orgs")
def create_org(body: dict, is_admin: bool = Depends(verify_admin)):
    """Create a new org account (admin only)."""
    username = body.get("username", "").strip()
    password = body.get("password", "")
    demo_mode = body.get("demo_mode", False)

    if not username or len(username) < 2:
        raise HTTPException(400, "Username must be at least 2 characters")
    if len(password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    auth_db = get_auth_db()
    existing = auth_db.execute(
        "SELECT id FROM orgs WHERE username = ?", [username]
    ).fetchone()
    if existing:
        raise HTTPException(409, "Username already taken")

    org_id = str(uuid.uuid4())
    password_hash = bcrypt.hashpw(
        password.encode('utf-8'), bcrypt.gensalt()
    ).decode('utf-8')

    auth_db.execute(
        "INSERT INTO orgs (id, username, password_hash, demo_mode) VALUES (?, ?, ?, ?)",
        [org_id, username, password_hash, demo_mode]
    )

    create_default_allowances(org_id)

    log_activity("admin", "admin", "admin_create_org", "org", resource_id=org_id, resource_name=username,
                 details={"demo_mode": demo_mode})
    return {"id": org_id, "username": username, "demo_mode": demo_mode}


@router.post("/impersonate/{org_id}")
def impersonate_org(org_id: str, is_admin: bool = Depends(verify_admin)):
    """Generate an impersonation token for the given org."""
    auth_db = get_auth_db()
    row = auth_db.execute(
        "SELECT id, username, demo_mode FROM orgs WHERE id = ?", [org_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Org not found")

    token = create_impersonation_token(org_id)

    log_activity("admin", "admin", "admin_impersonate", "org", resource_id=org_id, resource_name=row[1])
    return {
        "token": token,
        "org_id": row[0],
        "username": row[1],
        "demo_mode": bool(row[2]) if row[2] is not None else False
    }


@router.put("/orgs/{org_id}/demo-mode")
def set_demo_mode(org_id: str, body: dict, is_admin: bool = Depends(verify_admin)):
    """Toggle demo mode for an org."""
    demo_mode = body.get("demo_mode", False)
    auth_db = get_auth_db()
    row = auth_db.execute("SELECT id FROM orgs WHERE id = ?", [org_id]).fetchone()
    if not row:
        raise HTTPException(404, "Org not found")
    auth_db.execute(
        "UPDATE orgs SET demo_mode = ? WHERE id = ?",
        [demo_mode, org_id]
    )
    log_activity("admin", "admin", "admin_toggle_demo", "org", resource_id=org_id, details={"demo_mode": demo_mode})
    return {"status": "updated", "demo_mode": demo_mode}


@router.put("/orgs/{org_id}/password")
def reset_org_password(org_id: str, body: dict, is_admin: bool = Depends(verify_admin)):
    """Reset an org's password (admin only)."""
    password = body.get("password", "")
    if len(password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    auth_db = get_auth_db()
    row = auth_db.execute("SELECT id FROM orgs WHERE id = ?", [org_id]).fetchone()
    if not row:
        raise HTTPException(404, "Org not found")

    password_hash = bcrypt.hashpw(
        password.encode('utf-8'), bcrypt.gensalt()
    ).decode('utf-8')
    auth_db.execute(
        "UPDATE orgs SET password_hash = ? WHERE id = ?",
        [password_hash, org_id]
    )
    log_activity("admin", "admin", "admin_reset_password", "org", resource_id=org_id)
    return {"status": "updated"}


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
    furniture_db.execute("BEGIN TRANSACTION")
    try:
        furniture_db.execute("DELETE FROM meshy_tasks WHERE furniture_id IN (SELECT id FROM furniture WHERE org_id = ?)", [org_id])
        furniture_db.execute("DELETE FROM furniture WHERE org_id = ?", [org_id])
        furniture_db.execute("COMMIT")
    except Exception:
        furniture_db.execute("ROLLBACK")
        raise

    # Delete all rooms R2 assets and records
    room_rows = houses_db.execute("""
        SELECT r.id, r.background_image_path, r.wall_colors, r.original_background_key, r.final_image_path FROM rooms r
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
        if row[3]:
            r2_keys.append(row[3])
        if row[4]:
            r2_keys.append(row[4])

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
    houses_db.execute("BEGIN TRANSACTION")
    try:
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
        houses_db.execute("COMMIT")
    except Exception:
        houses_db.execute("ROLLBACK")
        raise

    # Delete org-related auth.db records
    auth_db.execute("BEGIN TRANSACTION")
    try:
        auth_db.execute("DELETE FROM usage_log WHERE org_id = ?", [org_id])
        auth_db.execute("DELETE FROM feedback WHERE org_id = ?", [org_id])
        auth_db.execute("DELETE FROM org_allowances WHERE org_id = ?", [org_id])
        auth_db.execute("DELETE FROM activity_log WHERE actor_id = ?", [org_id])
        auth_db.execute("DELETE FROM error_log WHERE org_id = ?", [org_id])
        auth_db.execute("DELETE FROM orgs WHERE id = ?", [org_id])
        auth_db.execute("COMMIT")
    except Exception:
        auth_db.execute("ROLLBACK")
        raise

    # Batch delete R2 objects
    if r2_keys:
        r2.delete_objects(r2_keys)

    logger.info(f"Admin deleted org {org_id} with {len(furn_rows)} furniture, {len(room_rows)} rooms")
    log_activity("admin", "admin", "admin_delete_org", "org", resource_id=org_id,
                 details={"furniture_count": len(furn_rows), "room_count": len(room_rows), "r2_keys": len(r2_keys)})
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
        "SELECT id, background_image_path, wall_colors, original_background_key, final_image_path FROM rooms WHERE house_id = ?",
        [house_id]
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
        if room[3]:
            r2_keys.append(room[3])
        if room[4]:
            r2_keys.append(room[4])

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

    log_activity("admin", "admin", "admin_delete_house", "house", resource_id=house_id,
                 details={"room_count": len(rooms)})
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
        "SELECT id, background_image_path, wall_colors, original_background_key, final_image_path FROM rooms WHERE id = ?",
        [room_id]
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
    if row[3]:
        r2_keys.append(row[3])
    if row[4]:
        r2_keys.append(row[4])

    layout_rows = db.execute(
        "SELECT screenshot_path FROM layouts WHERE room_id = ?", [room_id]
    ).fetchall()
    for lr in layout_rows:
        if lr[0]:
            r2_keys.append(lr[0])
    db.execute("DELETE FROM layouts WHERE room_id = ?", [room_id])
    db.execute("DELETE FROM rooms WHERE id = ?", [room_id])
    r2.delete_objects(r2_keys)

    log_activity("admin", "admin", "admin_delete_room", "room", resource_id=room_id)
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
    if not moge_breaker.can_execute():
        raise HTTPException(503, "MoGe-2 service is temporarily unavailable. Please try again in a few minutes.")
    try:
        result = await process_image_with_modal(image_bytes)
        moge_breaker.record_success()
    except MoGeError as e:
        moge_breaker.record_failure()
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

    log_activity("admin", "admin", "admin_delete_furniture", "furniture", resource_id=furniture_id)
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


# ============ Unified Tasks ============

@router.get("/tasks")
def list_tasks(
    status: Optional[str] = Query(None),
    org_id: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    is_admin: bool = Depends(verify_admin)
):
    """Unified tasks view: async 3D tasks + recent sync calls."""
    from datetime import datetime, timedelta

    db = get_furniture_db()
    auth_db = get_auth_db()
    now = datetime.now()
    stuck_threshold = now - timedelta(minutes=10)

    # --- Async tasks (Meshy/TRELLIS) ---
    task_query = """
        SELECT t.id, t.furniture_id, t.status, t.progress, t.retry_count,
               t.error_message, t.created_at, t.updated_at,
               f.name as furniture_name, f.org_id
        FROM meshy_tasks t
        LEFT JOIN furniture f ON t.furniture_id = f.id
        WHERE 1=1
    """
    task_params = []
    if status:
        task_query += " AND t.status = ?"
        task_params.append(status)
    if org_id:
        task_query += " AND f.org_id = ?"
        task_params.append(org_id)
    task_query += " ORDER BY t.created_at DESC"
    task_rows = db.execute(task_query, task_params).fetchall()

    org_ids = list(set(row[9] for row in task_rows if row[9]))

    # --- Recent sync calls (last 5 minutes from usage_log) ---
    sync_cutoff = now - timedelta(minutes=5)
    sync_query = """
        SELECT id, org_id, service_category, action, success, duration_ms, error_message, created_at
        FROM usage_log WHERE created_at >= ?
    """
    sync_params = [sync_cutoff]
    if org_id:
        sync_query += " AND org_id = ?"
        sync_params.append(org_id)
    if service:
        sync_query += " AND service_category = ?"
        sync_params.append(service)
    sync_query += " ORDER BY created_at DESC LIMIT 50"
    sync_rows = auth_db.execute(sync_query, sync_params).fetchall()

    sync_org_ids = [row[1] for row in sync_rows if row[1]]
    all_org_ids = list(set(org_ids + sync_org_ids))

    org_names = {}
    for oid in all_org_ids:
        org_row = auth_db.execute("SELECT username FROM orgs WHERE id = ?", [oid]).fetchone()
        org_names[oid] = org_row[0] if org_row else "Unknown"

    async_tasks = []
    for row in task_rows:
        updated = row[7]
        is_stuck = False
        if updated and row[2] in ('pending', 'creating', 'polling', 'downloading'):
            if isinstance(updated, str):
                updated_dt = datetime.fromisoformat(updated)
            else:
                updated_dt = updated
            is_stuck = updated_dt < stuck_threshold
        async_tasks.append({
            "id": row[0], "furnitureId": row[1], "status": row[2],
            "progress": row[3], "retryCount": row[4], "errorMessage": row[5],
            "createdAt": str(row[6]) if row[6] else None,
            "updatedAt": str(row[7]) if row[7] else None,
            "furnitureName": row[8] or "Unknown",
            "orgId": row[9], "orgUsername": org_names.get(row[9], "Unknown"),
            "stuck": is_stuck,
        })

    recent_calls = [{
        "id": row[0], "orgId": row[1], "orgUsername": org_names.get(row[1], "Unknown"),
        "service": row[2], "action": row[3],
        "success": bool(row[4]), "durationMs": row[5],
        "errorMessage": row[6],
        "createdAt": str(row[7]) if row[7] else None,
    } for row in sync_rows]

    return {"asyncTasks": async_tasks, "recentCalls": recent_calls}


# ============ R2 Cleanup ============

@router.post("/r2/scan")
def scan_r2_orphans(is_admin: bool = Depends(verify_admin)):
    """Scan R2 for objects not referenced by any DB record."""
    houses_db = get_houses_db()
    furniture_db = get_furniture_db()

    # Collect all expected R2 keys from DB
    expected = set()

    # Room backgrounds, original backgrounds, wall color variants, final images
    rows = houses_db.execute(
        "SELECT background_image_path, original_background_key, wall_colors, final_image_path FROM rooms"
    ).fetchall()
    for row in rows:
        if row[0]:
            expected.add(row[0])
        if row[1]:
            expected.add(row[1])
        if row[2]:
            wc = json.loads(row[2])
            for variant in wc.get("variants", []):
                if variant.get("imagePath"):
                    expected.add(variant["imagePath"])
        if row[3]:
            expected.add(row[3])

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


# ============ Usage Tracking ============

@router.get("/usage")
def get_usage_log(
    org_id: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None, alias="from"),
    to_date: Optional[str] = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    is_admin: bool = Depends(verify_admin),
):
    """Get paginated usage log with filters."""
    db = get_auth_db()

    conditions = []
    params = []

    if org_id:
        conditions.append("u.org_id = ?")
        params.append(org_id)
    if service:
        conditions.append("u.service_category = ?")
        params.append(service)
    if action:
        conditions.append("u.action = ?")
        params.append(action)
    if from_date:
        conditions.append("u.created_at >= ?")
        params.append(from_date)
    if to_date:
        conditions.append("u.created_at <= ?")
        params.append(to_date + " 23:59:59")

    where = " AND ".join(conditions) if conditions else "1=1"
    offset = (page - 1) * limit

    count = db.execute(
        f"SELECT COUNT(*) FROM usage_log u WHERE {where}", params
    ).fetchone()[0]

    rows = db.execute(
        f"""SELECT u.id, u.org_id, u.service_category, u.action, u.success,
                   u.duration_ms, u.error_message, u.admin_initiated, u.metadata, u.created_at,
                   COALESCE(o.username, u.org_id) as org_username
            FROM usage_log u
            LEFT JOIN orgs o ON u.org_id = o.id
            WHERE {where}
            ORDER BY u.created_at DESC
            LIMIT ? OFFSET ?""",
        params + [limit, offset]
    ).fetchall()

    return {
        "total": count,
        "page": page,
        "limit": limit,
        "rows": [
            {
                "id": r[0], "orgId": r[1], "serviceCategory": r[2], "action": r[3],
                "success": r[4], "durationMs": r[5], "errorMessage": r[6],
                "adminInitiated": r[7], "metadata": json.loads(r[8]) if r[8] else None,
                "createdAt": str(r[9]), "orgUsername": r[10],
            }
            for r in rows
        ],
    }


@router.get("/usage/summary")
def get_usage_summary(
    org_id: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None, alias="from"),
    to_date: Optional[str] = Query(None, alias="to"),
    is_admin: bool = Depends(verify_admin),
):
    """Get usage aggregated by org x service x day."""
    db = get_auth_db()

    conditions = []
    params = []

    if org_id:
        conditions.append("u.org_id = ?")
        params.append(org_id)
    if from_date:
        conditions.append("u.created_at >= ?")
        params.append(from_date)
    if to_date:
        conditions.append("u.created_at <= ?")
        params.append(to_date + " 23:59:59")

    where = " AND ".join(conditions) if conditions else "1=1"

    rows = db.execute(
        f"""SELECT u.org_id, COALESCE(o.username, u.org_id) as org_username,
                   u.service_category,
                   CAST(u.created_at AS DATE) as day,
                   COUNT(*) as total_calls,
                   SUM(CASE WHEN u.success THEN 1 ELSE 0 END) as success_count,
                   SUM(CASE WHEN NOT u.success THEN 1 ELSE 0 END) as fail_count
            FROM usage_log u
            LEFT JOIN orgs o ON u.org_id = o.id
            WHERE {where}
            GROUP BY u.org_id, o.username, u.service_category, CAST(u.created_at AS DATE)
            ORDER BY day DESC, org_username, u.service_category""",
        params
    ).fetchall()

    return [
        {
            "orgId": r[0], "orgUsername": r[1], "serviceCategory": r[2],
            "day": str(r[3]), "totalCalls": r[4], "successCount": r[5], "failCount": r[6],
        }
        for r in rows
    ]


# ============ Allowances ============

@router.get("/allowances/{org_id}")
def get_org_allowances(org_id: str, is_admin: bool = Depends(verify_admin)):
    """Get allowances and today's usage for an org."""
    from usage import get_usage_today

    db = get_auth_db()
    rows = db.execute(
        "SELECT service_category, daily_limit FROM org_allowances WHERE org_id = ?",
        [org_id]
    ).fetchall()

    allowances = {}
    for r in rows:
        allowances[r[0]] = {
            "dailyLimit": r[1],
            "usedToday": get_usage_today(org_id, r[0]),
        }

    # Fill in defaults for any missing categories
    for cat in DEFAULT_ALLOWANCES:
        if cat not in allowances:
            allowances[cat] = {
                "dailyLimit": None,
                "usedToday": get_usage_today(org_id, cat),
            }

    return allowances


@router.put("/allowances/{org_id}")
def update_org_allowances(org_id: str, body: dict, is_admin: bool = Depends(verify_admin)):
    """Set daily limits per service category. Body: {service_category: daily_limit_or_null}"""
    db = get_auth_db()
    for service_category, daily_limit in body.items():
        if service_category not in DEFAULT_ALLOWANCES:
            continue
        db.execute(
            """INSERT INTO org_allowances (org_id, service_category, daily_limit)
               VALUES (?, ?, ?)
               ON CONFLICT (org_id, service_category)
               DO UPDATE SET daily_limit = ?""",
            [org_id, service_category, daily_limit, daily_limit]
        )
    log_activity("admin", "admin", "admin_update_allowances", "org", resource_id=org_id, details=body)
    return {"status": "saved"}


# ============ Feedback (Admin) ============

@router.get("/feedback")
def list_feedback(
    org_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    is_admin: bool = Depends(verify_admin),
):
    """Get all feedback, optionally filtered."""
    db = get_auth_db()

    conditions = []
    params = []
    if org_id:
        conditions.append("f.org_id = ?")
        params.append(org_id)
    if status:
        conditions.append("f.status = ?")
        params.append(status)

    where = " AND ".join(conditions) if conditions else "1=1"

    rows = db.execute(
        f"""SELECT f.id, f.org_id, COALESCE(o.username, f.org_id) as org_username,
                   f.message, f.status, f.admin_notes, f.created_at, f.updated_at
            FROM feedback f
            LEFT JOIN orgs o ON f.org_id = o.id
            WHERE {where}
            ORDER BY f.created_at DESC""",
        params
    ).fetchall()

    return [
        {
            "id": r[0], "orgId": r[1], "orgUsername": r[2], "message": r[3],
            "status": r[4], "adminNotes": r[5], "createdAt": str(r[6]), "updatedAt": str(r[7]),
        }
        for r in rows
    ]


@router.put("/feedback/{feedback_id}")
def update_feedback(feedback_id: str, body: dict, is_admin: bool = Depends(verify_admin)):
    """Update feedback status and/or admin notes."""
    db = get_auth_db()

    updates = ["updated_at = CURRENT_TIMESTAMP"]
    values = []

    if "status" in body:
        updates.append("status = ?")
        values.append(body["status"])
    if "admin_notes" in body:
        updates.append("admin_notes = ?")
        values.append(body["admin_notes"])

    if len(values) == 0:
        raise HTTPException(400, "No fields to update")

    values.append(feedback_id)
    db.execute(f"UPDATE feedback SET {', '.join(updates)} WHERE id = ?", values)
    log_activity("admin", "admin", "admin_update_feedback", "feedback", resource_id=feedback_id,
                 details={k: body[k] for k in ["status", "admin_notes"] if k in body})
    return {"status": "saved"}


# ── Error Log ──────────────────────────────────────────────────────────

@router.get("/errors")
def list_errors(
    error_type: Optional[str] = None,
    source: Optional[str] = None,
    limit: int = Query(50, le=200),
    offset: int = 0,
    is_admin: bool = Depends(verify_admin),
):
    db = get_auth_db()
    where = []
    params = []
    if error_type:
        where.append("error_type = ?")
        params.append(error_type)
    if source:
        where.append("source LIKE ?")
        params.append(f"%{source}%")
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    count = db.execute(f"SELECT COUNT(*) FROM error_log {clause}", params).fetchone()[0]
    rows = db.execute(
        f"SELECT id, error_type, source, message, traceback, org_id, endpoint, metadata, created_at "
        f"FROM error_log {clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        params + [limit, offset]
    ).fetchall()
    return {
        "total": count,
        "errors": [
            {
                "id": r[0], "error_type": r[1], "source": r[2], "message": r[3],
                "traceback": r[4], "org_id": r[5], "endpoint": r[6],
                "metadata": json.loads(r[7]) if r[7] else None,
                "created_at": str(r[8]) if r[8] else None,
            }
            for r in rows
        ],
    }


@router.delete("/errors")
def clear_old_errors(days: int = Query(30, ge=1), is_admin: bool = Depends(verify_admin)):
    db = get_auth_db()
    result = db.execute(
        "DELETE FROM error_log WHERE created_at < CURRENT_TIMESTAMP - INTERVAL ? DAY",
        [days]
    )
    return {"status": "cleaned", "days_threshold": days}


# ── Activity Log ───────────────────────────────────────────────────────

@router.get("/activity")
def list_activity(
    actor_type: Optional[str] = None,
    actor_id: Optional[str] = None,
    action: Optional[str] = None,
    resource_type: Optional[str] = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
    is_admin: bool = Depends(verify_admin),
):
    db = get_auth_db()
    where = []
    params = []
    if actor_type:
        where.append("actor_type = ?")
        params.append(actor_type)
    if actor_id:
        where.append("actor_id = ?")
        params.append(actor_id)
    if action:
        where.append("action LIKE ?")
        params.append(f"%{action}%")
    if resource_type:
        where.append("resource_type = ?")
        params.append(resource_type)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    count = db.execute(f"SELECT COUNT(*) FROM activity_log {clause}", params).fetchone()[0]
    rows = db.execute(
        f"SELECT id, actor_type, actor_id, action, resource_type, resource_id, resource_name, details, created_at "
        f"FROM activity_log {clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        params + [limit, offset]
    ).fetchall()
    return {
        "total": count,
        "activities": [
            {
                "id": r[0], "actor_type": r[1], "actor_id": r[2], "action": r[3],
                "resource_type": r[4], "resource_id": r[5], "resource_name": r[6],
                "details": json.loads(r[7]) if r[7] else None,
                "created_at": str(r[8]) if r[8] else None,
            }
            for r in rows
        ],
    }


@router.delete("/activity")
def clear_old_activity(days: int = Query(90, ge=1), is_admin: bool = Depends(verify_admin)):
    db = get_auth_db()
    db.execute(
        "DELETE FROM activity_log WHERE created_at < CURRENT_TIMESTAMP - INTERVAL ? DAY",
        [days]
    )
    return {"status": "cleaned", "days_threshold": days}


# ── Usage Reports ──────────────────────────────────────────────────────

@router.get("/reports/{org_id}")
def generate_usage_report(
    org_id: str,
    period: str = Query("monthly", pattern="^(weekly|monthly|yearly)$"),
    date: Optional[str] = Query(None),
    is_admin: bool = Depends(verify_admin),
):
    """Generate a usage report for an org."""
    from datetime import datetime, timedelta

    auth_db = get_auth_db()

    org_row = auth_db.execute("SELECT username FROM orgs WHERE id = ?", [org_id]).fetchone()
    if not org_row:
        raise HTTPException(404, "Org not found")

    ref_date = datetime.strptime(date, "%Y-%m-%d") if date else datetime.now()

    if period == "weekly":
        start = ref_date - timedelta(days=6)
        end = ref_date
    elif period == "monthly":
        start = ref_date.replace(day=1)
        next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        end = next_month - timedelta(days=1)
    else:  # yearly
        start = ref_date.replace(month=1, day=1)
        end = ref_date.replace(month=12, day=31)

    start_str = start.strftime("%Y-%m-%d 00:00:00")
    end_str = end.strftime("%Y-%m-%d 23:59:59")

    rows = auth_db.execute("""
        SELECT service_category, action, success, duration_ms, created_at
        FROM usage_log WHERE org_id = ? AND created_at BETWEEN ? AND ?
        ORDER BY created_at
    """, [org_id, start_str, end_str]).fetchall()

    by_service = {}
    by_day = {}
    for r in rows:
        svc = r[0]
        if svc not in by_service:
            by_service[svc] = {"total": 0, "success": 0, "failed": 0, "totalDurationMs": 0, "actions": {}}
        s = by_service[svc]
        s["total"] += 1
        if r[2]:
            s["success"] += 1
        else:
            s["failed"] += 1
        if r[3]:
            s["totalDurationMs"] += r[3]

        action = r[1]
        if action not in s["actions"]:
            s["actions"][action] = 0
        s["actions"][action] += 1

        day = str(r[4])[:10]
        if day not in by_day:
            by_day[day] = 0
        by_day[day] += 1

    peak_day = max(by_day, key=by_day.get) if by_day else None

    allowances = auth_db.execute(
        "SELECT service_category, daily_limit FROM org_allowances WHERE org_id = ?", [org_id]
    ).fetchall()

    return {
        "orgId": org_id,
        "orgUsername": org_row[0],
        "period": period,
        "startDate": start.strftime("%Y-%m-%d"),
        "endDate": end.strftime("%Y-%m-%d"),
        "byService": by_service,
        "byDay": by_day,
        "peakDay": peak_day,
        "peakDayCount": by_day.get(peak_day, 0) if peak_day else 0,
        "totalCalls": sum(s["total"] for s in by_service.values()),
        "allowances": {a[0]: a[1] for a in allowances},
    }


@router.get("/reports/{org_id}/csv")
def generate_usage_report_csv(
    org_id: str,
    period: str = Query("monthly", pattern="^(weekly|monthly|yearly)$"),
    date: Optional[str] = Query(None),
    is_admin: bool = Depends(verify_admin),
):
    """Generate a CSV usage report for an org."""
    from datetime import datetime, timedelta
    from fastapi.responses import Response

    auth_db = get_auth_db()

    org_row = auth_db.execute("SELECT username FROM orgs WHERE id = ?", [org_id]).fetchone()
    if not org_row:
        raise HTTPException(404, "Org not found")

    ref_date = datetime.strptime(date, "%Y-%m-%d") if date else datetime.now()

    if period == "weekly":
        start = ref_date - timedelta(days=6)
        end = ref_date
    elif period == "monthly":
        start = ref_date.replace(day=1)
        next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        end = next_month - timedelta(days=1)
    else:
        start = ref_date.replace(month=1, day=1)
        end = ref_date.replace(month=12, day=31)

    start_str = start.strftime("%Y-%m-%d 00:00:00")
    end_str = end.strftime("%Y-%m-%d 23:59:59")

    rows = auth_db.execute("""
        SELECT service_category, action, success, duration_ms, error_message, admin_initiated, created_at
        FROM usage_log WHERE org_id = ? AND created_at BETWEEN ? AND ?
        ORDER BY created_at
    """, [org_id, start_str, end_str]).fetchall()

    lines = ["Date,Service,Action,Success,Duration(ms),Admin,Error"]
    for r in rows:
        error = (r[4] or "").replace(",", ";").replace("\n", " ")[:100]
        lines.append(f"{r[6]},{r[0]},{r[1]},{r[2]},{r[3] or ''},{r[5]},{error}")

    csv_content = "\n".join(lines)
    filename = f"usage_{org_row[0]}_{period}_{start.strftime('%Y%m%d')}.csv"

    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
