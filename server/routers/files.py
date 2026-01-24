from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db, get_furniture_db
from config import (FURNITURE_IMAGES, FURNITURE_THUMBNAILS, FURNITURE_MODELS,
                    ROOM_BACKGROUNDS, ROOM_MESHES)
from utils import IMAGE_EXTENSIONS
from routers.rooms import download_mesh

router = APIRouter()


def find_file(directory: Path, base_name: str, extensions: list) -> Path | None:
    for ext in extensions:
        path = directory / f"{base_name}.{ext}"
        if path.exists():
            return path
    return None


async def save_image_file(
    file: UploadFile,
    directory: Path,
    file_id: str,
    db,
    table: str,
    column: str
) -> dict:
    """Save an image file, cleaning up old versions and updating database."""
    ext = file.filename.split('.')[-1].lower() if '.' in file.filename else 'jpg'
    if ext not in IMAGE_EXTENSIONS:
        ext = 'jpg'

    # Remove any existing files with different extensions
    for old_ext in IMAGE_EXTENSIONS:
        old_path = directory / f"{file_id}.{old_ext}"
        old_path.unlink(missing_ok=True)

    path = directory / f"{file_id}.{ext}"
    content = await file.read()
    path.write_bytes(content)

    db.execute(f"UPDATE {table} SET {column} = ? WHERE id = ?", [str(path), file_id])

    return {"status": "uploaded", "path": str(path)}

# ============ Furniture Files ============

@router.post("/furniture/{furniture_id}/image")
async def upload_furniture_image(furniture_id: str, file: UploadFile = File(...)):
    db = get_furniture_db()
    return await save_image_file(file, FURNITURE_IMAGES, furniture_id, db, "furniture", "image_path")

@router.get("/furniture/{furniture_id}/image")
def get_furniture_image(furniture_id: str):
    path = find_file(FURNITURE_IMAGES, furniture_id, IMAGE_EXTENSIONS)
    if not path:
        raise HTTPException(404, "Image not found")
    return FileResponse(path)

@router.post("/furniture/{furniture_id}/thumbnail")
async def upload_furniture_thumbnail(furniture_id: str, file: UploadFile = File(...)):
    db = get_furniture_db()
    return await save_image_file(file, FURNITURE_THUMBNAILS, furniture_id, db, "furniture", "thumbnail_path")

@router.get("/furniture/{furniture_id}/thumbnail")
def get_furniture_thumbnail(furniture_id: str):
    path = find_file(FURNITURE_THUMBNAILS, furniture_id, IMAGE_EXTENSIONS)
    if not path:
        raise HTTPException(404, "Thumbnail not found")
    return FileResponse(path)

@router.post("/furniture/{furniture_id}/model")
async def upload_furniture_model(furniture_id: str, file: UploadFile = File(...)):
    path = FURNITURE_MODELS / f"{furniture_id}.zip"
    content = await file.read()
    path.write_bytes(content)

    db = get_furniture_db()
    db.execute("UPDATE furniture SET model_path = ? WHERE id = ?", [str(path), furniture_id])

    return {"status": "uploaded", "path": str(path)}

@router.get("/furniture/{furniture_id}/model")
def get_furniture_model(furniture_id: str):
    path = FURNITURE_MODELS / f"{furniture_id}.zip"
    if not path.exists():
        raise HTTPException(404, "Model not found")
    return FileResponse(path, media_type="application/zip")

# ============ Room Files ============

@router.post("/room/{room_id}/background")
async def upload_room_background(room_id: str, file: UploadFile = File(...)):
    db = get_houses_db()
    return await save_image_file(file, ROOM_BACKGROUNDS, room_id, db, "rooms", "background_image_path")

@router.get("/room/{room_id}/background")
def get_room_background(room_id: str):
    path = find_file(ROOM_BACKGROUNDS, room_id, IMAGE_EXTENSIONS)
    if not path:
        raise HTTPException(404, "Background not found")
    return FileResponse(path)

@router.post("/room/{room_id}/mesh")
async def save_room_mesh(room_id: str, data: dict):
    """Download MoGe mesh from temporary HuggingFace URL and save locally."""
    mesh_url = data.get("mesh_url")
    if not mesh_url:
        raise HTTPException(400, "mesh_url required")

    local_url = await download_mesh(room_id, mesh_url)
    return {"local_url": local_url}

@router.get("/room/{room_id}/mesh")
def get_room_mesh(room_id: str):
    path = ROOM_MESHES / f"{room_id}.glb"
    if not path.exists():
        raise HTTPException(404, "Mesh not found")
    return FileResponse(path, media_type="model/gltf-binary")
