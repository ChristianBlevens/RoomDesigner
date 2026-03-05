import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Depends
from fastapi.responses import RedirectResponse

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db, get_furniture_db
from utils import IMAGE_EXTENSIONS
from model_processor import ModelProcessor
from routers.auth import verify_token
import r2

router = APIRouter()


def verify_furniture_ownership(furniture_id: str, org_id: str):
    db = get_furniture_db()
    row = db.execute(
        "SELECT id FROM furniture WHERE id = ? AND org_id = ?", [furniture_id, org_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Furniture not found")


def verify_room_ownership(room_id: str, org_id: str):
    db = get_houses_db()
    row = db.execute("SELECT house_id FROM rooms WHERE id = ?", [room_id]).fetchone()
    if not row:
        raise HTTPException(404, "Room not found")
    house = db.execute(
        "SELECT id FROM houses WHERE id = ? AND org_id = ?", [row[0], org_id]
    ).fetchone()
    if not house:
        raise HTTPException(404, "Room not found")


async def save_image_file(
    file: UploadFile,
    r2_prefix: str,
    file_id: str,
    db,
    table: str,
    column: str
) -> dict:
    """Save an image file to R2."""
    ext = file.filename.split('.')[-1].lower() if '.' in file.filename else 'jpg'
    if ext not in IMAGE_EXTENSIONS:
        ext = 'jpg'

    content = await file.read()

    for old_ext in IMAGE_EXTENSIONS:
        r2.delete_object(f"{r2_prefix}/{file_id}.{old_ext}")
    key = f"{r2_prefix}/{file_id}.{ext}"
    url = r2.upload_bytes(key, content, r2.get_content_type(ext))
    db.execute(f"UPDATE {table} SET {column} = ? WHERE id = ?", [key, file_id])
    return {"status": "uploaded", "url": url}


# ============ Furniture Files ============

@router.post("/furniture/{furniture_id}/image")
async def upload_furniture_image(
    furniture_id: str, file: UploadFile = File(...), org_id: str = Depends(verify_token)
):
    verify_furniture_ownership(furniture_id, org_id)
    db = get_furniture_db()
    return await save_image_file(
        file, "furniture/images", furniture_id, db, "furniture", "image_path"
    )

@router.get("/furniture/{furniture_id}/image")
def get_furniture_image(furniture_id: str):
    db = get_furniture_db()
    row = db.execute("SELECT image_path FROM furniture WHERE id = ?", [furniture_id]).fetchone()
    if not row or not row[0]:
        raise HTTPException(404, "Image not found")
    return RedirectResponse(r2.get_public_url(row[0]), status_code=302)

@router.post("/furniture/{furniture_id}/preview3d")
async def upload_furniture_preview3d(
    furniture_id: str, file: UploadFile = File(...), org_id: str = Depends(verify_token)
):
    verify_furniture_ownership(furniture_id, org_id)
    db = get_furniture_db()
    return await save_image_file(
        file, "furniture/previews_3d", furniture_id, db, "furniture", "preview_3d_path"
    )

@router.get("/furniture/{furniture_id}/preview3d")
def get_furniture_preview3d(furniture_id: str):
    db = get_furniture_db()
    row = db.execute("SELECT preview_3d_path FROM furniture WHERE id = ?", [furniture_id]).fetchone()
    if not row or not row[0]:
        raise HTTPException(404, "3D preview not found")
    return RedirectResponse(r2.get_public_url(row[0]), status_code=302)

@router.post("/furniture/{furniture_id}/model")
async def upload_furniture_model(
    furniture_id: str,
    file: UploadFile = File(...),
    org_id: str = Depends(verify_token)
):
    """Upload a furniture model (GLB file). Processes to fix bounds, recenter origin, generate 3D preview."""
    verify_furniture_ownership(furniture_id, org_id)
    content = await file.read()

    processor = ModelProcessor()
    result = processor.process_glb(
        content, origin_placement='bottom-center', generate_preview=True
    )

    db = get_furniture_db()

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
        db.execute("UPDATE furniture SET model_path = ? WHERE id = ?", [model_key, furniture_id])

    return {"status": "uploaded", "url": r2.get_public_url(model_key)}

@router.get("/furniture/{furniture_id}/model")
def get_furniture_model(furniture_id: str):
    db = get_furniture_db()
    row = db.execute("SELECT model_path FROM furniture WHERE id = ?", [furniture_id]).fetchone()
    if not row or not row[0]:
        raise HTTPException(404, "Model not found")
    return RedirectResponse(r2.get_public_url(row[0]), status_code=302)

# ============ Room Files ============

@router.post("/room/{room_id}/background")
async def upload_room_background(
    room_id: str, file: UploadFile = File(...), org_id: str = Depends(verify_token)
):
    verify_room_ownership(room_id, org_id)
    db = get_houses_db()
    return await save_image_file(
        file, "rooms/backgrounds", room_id, db, "rooms", "background_image_path"
    )

@router.get("/room/{room_id}/background")
def get_room_background(room_id: str):
    db = get_houses_db()
    row = db.execute(
        "SELECT background_image_path FROM rooms WHERE id = ?", [room_id]
    ).fetchone()
    if not row or not row[0]:
        raise HTTPException(404, "Background not found")
    return RedirectResponse(r2.get_public_url(row[0]), status_code=302)

@router.get("/room/{room_id}/mesh")
def get_room_mesh(room_id: str):
    mesh_key = f"rooms/meshes/{room_id}.glb"
    if r2.object_exists(mesh_key):
        return RedirectResponse(r2.get_public_url(mesh_key), status_code=302)
    raise HTTPException(404, "Mesh not found")
