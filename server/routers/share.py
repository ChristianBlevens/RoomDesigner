"""Shareable house view: public share page and owner-mode data endpoint."""

import os
import secrets
import json
import base64
import logging
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db, get_furniture_db
from routers.auth import verify_token
import r2

logger = logging.getLogger(__name__)
router = APIRouter()

FRONTEND_DIR = Path(__file__).parent.parent.parent


def _get_org_id_from_request(request: Request) -> Optional[str]:
    """Try to extract org_id from Authorization header. Returns None if invalid/missing."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header[7:]
    try:
        import jwt
        from db.connection import get_auth_db
        auth_db = get_auth_db()
        secret_row = auth_db.execute(
            "SELECT value FROM settings WHERE key = 'jwt_secret'"
        ).fetchone()
        if not secret_row:
            return None
        payload = jwt.decode(token, secret_row[0], algorithms=["HS256"])
        if payload.get("admin"):
            return None
        jti = payload.get("jti")
        if jti:
            revoked = auth_db.execute(
                "SELECT jti FROM revoked_tokens WHERE jti = ?", [jti]
            ).fetchone()
            if revoked:
                return None
        return payload.get("org_id")
    except Exception:
        return None


# ============ Public Endpoints ============

@router.get("/share/{token}")
async def serve_share_page(token: str, request: Request):
    """Serve the share HTML page with correct base path for static assets."""
    share_path = FRONTEND_DIR / "share.html"
    if not share_path.exists():
        raise HTTPException(404, "Share page not found")

    db = get_houses_db()
    row = db.execute(
        "SELECT id FROM houses WHERE share_token = ?", [token]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Share link not found or has been revoked")

    # Derive base path from SERVER_BASE_URL (handles /room/ prefix behind nginx)
    server_url = os.environ.get("SERVER_BASE_URL", "")
    if server_url:
        from urllib.parse import urlparse
        base_href = urlparse(server_url).path.rstrip("/") + "/"
    else:
        base_href = "/"

    html = share_path.read_text()
    html = html.replace("<head>", f'<head>\n  <base href="{base_href}">', 1)
    return HTMLResponse(html)


@router.get("/api/share/{token}")
async def get_share_data(token: str, request: Request):
    """Return house + rooms + manifest data for the share page."""
    db = get_houses_db()
    furniture_db = get_furniture_db()

    house_row = db.execute(
        "SELECT id, org_id, name, start_date, end_date FROM houses WHERE share_token = ?",
        [token]
    ).fetchone()
    if not house_row:
        raise HTTPException(404, "Share link not found or has been revoked")

    house_id = house_row[0]
    house_org_id = house_row[1]

    # Detect owner mode
    request_org_id = _get_org_id_from_request(request)
    is_owner = request_org_id == house_org_id if request_org_id else False

    # Fetch rooms
    room_rows = db.execute("""
        SELECT id, name, background_image_path, placed_furniture,
               moge_data, lighting_settings, room_scale, final_image_path,
               wall_colors, original_background_key
        FROM rooms WHERE house_id = ? ORDER BY created_at
    """, [house_id]).fetchall()

    # Collect all entry IDs from placed furniture across rooms
    all_entry_ids = set()
    rooms_placed = []
    for room_row in room_rows:
        pf = json.loads(room_row[3]) if room_row[3] else []
        rooms_placed.append(pf)
        for item in pf:
            if item.get("entryId"):
                all_entry_ids.add(item["entryId"])

    # Fetch furniture entries
    furniture_map = {}
    if all_entry_ids:
        placeholders = ",".join(["?" for _ in all_entry_ids])
        furn_rows = furniture_db.execute(f"""
            SELECT id, name, category, dimension_x, dimension_y, dimension_z,
                   location, condition, condition_notes, model_path
            FROM furniture WHERE id IN ({placeholders})
        """, list(all_entry_ids)).fetchall()
        for fr in furn_rows:
            furniture_map[fr[0]] = {
                "name": fr[1],
                "category": fr[2],
                "dimensions": {
                    "width": fr[3],
                    "height": fr[4],
                    "depth": fr[5]
                } if fr[3] is not None else None,
                "location": fr[6],
                "condition": fr[7],
                "conditionNotes": fr[8],
                "hasModel": bool(fr[9])
            }

    # Build room data
    rooms_data = []
    inventory_counts = {}

    for i, room_row in enumerate(room_rows):
        room_id = room_row[0]
        pf = rooms_placed[i]
        final_image_path = room_row[7]
        bg_path = room_row[2]
        original_bg_key = room_row[9]

        # Build furniture list for this room
        room_furniture = []
        for item in pf:
            entry_id = item.get("entryId")
            entry = furniture_map.get(entry_id)
            if entry:
                room_furniture.append({
                    "entryId": entry_id,
                    "name": entry["name"],
                    "category": entry["category"],
                    "dimensions": entry["dimensions"],
                    "location": entry["location"],
                    "condition": entry["condition"],
                })
                # Count for inventory
                key = entry_id
                if key not in inventory_counts:
                    inventory_counts[key] = 0
                inventory_counts[key] += 1

        room_data = {
            "id": room_id,
            "name": room_row[1],
            "finalImageUrl": r2.get_public_url(final_image_path) if final_image_path else None,
            "backgroundImageUrl": r2.get_public_url(bg_path) if bg_path else None,
            "originalBackgroundUrl": r2.get_public_url(original_bg_key) if original_bg_key else None,
            "furniture": room_furniture,
        }

        # Owner mode: include data needed for screenshot capture
        if is_owner:
            moge_data = json.loads(room_row[4]) if room_row[4] else None
            lighting_settings = json.loads(room_row[5]) if room_row[5] else None
            room_scale = room_row[6] if room_row[6] is not None else 1.0
            wall_colors = json.loads(room_row[8]) if room_row[8] else None

            # Resolve wall color variant URLs
            if wall_colors and wall_colors.get("variants"):
                for variant in wall_colors["variants"]:
                    if variant.get("imagePath") and not variant.get("imageUrl"):
                        variant["imageUrl"] = r2.get_public_url(variant["imagePath"])

            room_data["placedFurniture"] = pf
            room_data["mogeData"] = moge_data
            room_data["lightingSettings"] = lighting_settings
            room_data["roomScale"] = room_scale
            room_data["wallColors"] = wall_colors

            # Include model URLs for furniture entries (needed for screenshot rendering)
            for furn_item in room_furniture:
                entry = furniture_map.get(furn_item["entryId"])
                if entry and entry["hasModel"]:
                    furn_item["modelUrl"] = r2.get_public_url(
                        f"furniture/models/{furn_item['entryId']}.glb"
                    )

        rooms_data.append(room_data)

    # Build aggregated inventory
    inventory = []
    for entry_id, count in sorted(inventory_counts.items(),
                                   key=lambda x: (furniture_map.get(x[0], {}).get("category") or "",
                                                  furniture_map.get(x[0], {}).get("name") or "")):
        entry = furniture_map.get(entry_id)
        if entry:
            inventory.append({
                "name": entry["name"],
                "category": entry["category"],
                "totalInHouse": count,
                "location": entry["location"],
                "condition": entry["condition"],
            })

    return {
        "house": {
            "name": house_row[2],
            "startDate": str(house_row[3]),
            "endDate": str(house_row[4]),
        },
        "isOwner": is_owner,
        "rooms": rooms_data,
        "inventory": inventory,
    }


# ============ Protected Endpoints ============

@router.post("/api/houses/{house_id}/share")
def generate_share_token(house_id: str, org_id: str = Depends(verify_token)):
    """Generate or return existing share token for a house."""
    db = get_houses_db()
    row = db.execute(
        "SELECT share_token FROM houses WHERE id = ? AND org_id = ?",
        [house_id, org_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "House not found")

    token = row[0]
    if not token:
        for _ in range(10):
            token = secrets.token_urlsafe(9)
            existing = db.execute(
                "SELECT id FROM houses WHERE share_token = ?", [token]
            ).fetchone()
            if not existing:
                break
        else:
            raise HTTPException(500, "Failed to generate unique share token")

        db.execute(
            "UPDATE houses SET share_token = ? WHERE id = ?",
            [token, house_id]
        )

    return {"shareToken": token, "shareUrl": f"/share/{token}"}


@router.delete("/api/houses/{house_id}/share")
def revoke_share_token(house_id: str, org_id: str = Depends(verify_token)):
    """Revoke share token for a house."""
    db = get_houses_db()
    row = db.execute(
        "SELECT id FROM houses WHERE id = ? AND org_id = ?",
        [house_id, org_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "House not found")

    db.execute(
        "UPDATE houses SET share_token = NULL WHERE id = ?",
        [house_id]
    )
    return {"status": "revoked"}


class FinalImageRequest(BaseModel):
    image_base64: str


@router.post("/api/rooms/{room_id}/final-image")
def upload_final_image(room_id: str, request: FinalImageRequest, org_id: str = Depends(verify_token)):
    """Upload or replace the final image for a room."""
    db = get_houses_db()

    # Verify ownership
    room_row = db.execute("SELECT house_id FROM rooms WHERE id = ?", [room_id]).fetchone()
    if not room_row:
        raise HTTPException(404, "Room not found")
    house_row = db.execute(
        "SELECT id FROM houses WHERE id = ? AND org_id = ?",
        [room_row[0], org_id]
    ).fetchone()
    if not house_row:
        raise HTTPException(404, "House not found")

    try:
        image_b64 = request.image_base64
        if "base64," in image_b64:
            image_b64 = image_b64.split("base64,")[1]
        image_bytes = base64.b64decode(image_b64)
    except Exception as e:
        raise HTTPException(400, f"Invalid image: {str(e)}")

    r2_key = f"rooms/final/{room_id}.png"
    r2.upload_bytes(r2_key, image_bytes, "image/png")

    db.execute(
        "UPDATE rooms SET final_image_path = ? WHERE id = ?",
        [r2_key, room_id]
    )

    return {"finalImageUrl": r2.get_public_url(r2_key)}


@router.delete("/api/rooms/{room_id}/final-image")
def delete_final_image(room_id: str, org_id: str = Depends(verify_token)):
    """Delete the final image for a room."""
    db = get_houses_db()

    room_row = db.execute("SELECT house_id, final_image_path FROM rooms WHERE id = ?", [room_id]).fetchone()
    if not room_row:
        raise HTTPException(404, "Room not found")
    house_row = db.execute(
        "SELECT id FROM houses WHERE id = ? AND org_id = ?",
        [room_row[0], org_id]
    ).fetchone()
    if not house_row:
        raise HTTPException(404, "House not found")

    if room_row[1]:
        r2.delete_object(room_row[1])

    db.execute(
        "UPDATE rooms SET final_image_path = NULL WHERE id = ?",
        [room_id]
    )

    return {"status": "deleted"}
