from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pathlib import Path
import httpx
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db, get_furniture_db
from config import (FURNITURE_IMAGES, FURNITURE_THUMBNAILS, FURNITURE_MODELS,
                    ROOM_BACKGROUNDS, ROOM_MESHES)

router = APIRouter()

def find_file(directory: Path, base_name: str, extensions: list) -> Path | None:
    for ext in extensions:
        path = directory / f"{base_name}.{ext}"
        if path.exists():
            return path
    return None

IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']

# ============ Furniture Files ============

@router.post("/furniture/{furniture_id}/image")
async def upload_furniture_image(furniture_id: str, file: UploadFile = File(...)):
    ext = file.filename.split('.')[-1].lower() if '.' in file.filename else 'jpg'
    if ext not in IMAGE_EXTENSIONS:
        ext = 'jpg'

    # Remove any existing images with different extensions
    for old_ext in IMAGE_EXTENSIONS:
        old_path = FURNITURE_IMAGES / f"{furniture_id}.{old_ext}"
        old_path.unlink(missing_ok=True)

    path = FURNITURE_IMAGES / f"{furniture_id}.{ext}"
    content = await file.read()
    path.write_bytes(content)

    db = get_furniture_db()
    db.execute("UPDATE furniture SET image_path = ? WHERE id = ?", [str(path), furniture_id])

    return {"status": "uploaded", "path": str(path)}

@router.get("/furniture/{furniture_id}/image")
def get_furniture_image(furniture_id: str):
    path = find_file(FURNITURE_IMAGES, furniture_id, IMAGE_EXTENSIONS)
    if not path:
        raise HTTPException(404, "Image not found")
    return FileResponse(path)

@router.post("/furniture/{furniture_id}/thumbnail")
async def upload_furniture_thumbnail(furniture_id: str, file: UploadFile = File(...)):
    ext = file.filename.split('.')[-1].lower() if '.' in file.filename else 'jpg'
    if ext not in IMAGE_EXTENSIONS:
        ext = 'jpg'

    # Remove any existing thumbnails with different extensions
    for old_ext in IMAGE_EXTENSIONS:
        old_path = FURNITURE_THUMBNAILS / f"{furniture_id}.{old_ext}"
        old_path.unlink(missing_ok=True)

    path = FURNITURE_THUMBNAILS / f"{furniture_id}.{ext}"
    content = await file.read()
    path.write_bytes(content)

    db = get_furniture_db()
    db.execute("UPDATE furniture SET thumbnail_path = ? WHERE id = ?", [str(path), furniture_id])

    return {"status": "uploaded", "path": str(path)}

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
    ext = file.filename.split('.')[-1].lower() if '.' in file.filename else 'jpg'
    if ext not in IMAGE_EXTENSIONS:
        ext = 'jpg'

    # Remove any existing backgrounds with different extensions
    for old_ext in IMAGE_EXTENSIONS:
        old_path = ROOM_BACKGROUNDS / f"{room_id}.{old_ext}"
        old_path.unlink(missing_ok=True)

    path = ROOM_BACKGROUNDS / f"{room_id}.{ext}"
    content = await file.read()
    path.write_bytes(content)

    db = get_houses_db()
    db.execute("UPDATE rooms SET background_image_path = ? WHERE id = ?", [str(path), room_id])

    return {"status": "uploaded", "path": str(path)}

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

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(mesh_url)
            if response.status_code != 200:
                raise HTTPException(502, f"Failed to download mesh: {response.status_code}")
            mesh_data = response.content
    except httpx.RequestError as e:
        raise HTTPException(502, f"Failed to download mesh: {str(e)}")

    path = ROOM_MESHES / f"{room_id}.glb"
    path.write_bytes(mesh_data)

    local_url = f"/api/files/room/{room_id}/mesh"
    return {"local_url": local_url}

@router.get("/room/{room_id}/mesh")
def get_room_mesh(room_id: str):
    path = ROOM_MESHES / f"{room_id}.glb"
    if not path.exists():
        raise HTTPException(404, "Mesh not found")
    return FileResponse(path, media_type="model/gltf-binary")
