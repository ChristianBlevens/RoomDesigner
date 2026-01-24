import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.connection import get_houses_db, get_furniture_db
from config import (FURNITURE_IMAGES, FURNITURE_PREVIEWS_3D, FURNITURE_MODELS,
                    ROOM_BACKGROUNDS, ROOM_MESHES)
from utils import IMAGE_EXTENSIONS
from routers.rooms import download_mesh
from model_processor import ModelProcessor

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

@router.post("/furniture/{furniture_id}/preview3d")
async def upload_furniture_preview3d(furniture_id: str, file: UploadFile = File(...)):
    db = get_furniture_db()
    return await save_image_file(file, FURNITURE_PREVIEWS_3D, furniture_id, db, "furniture", "preview_3d_path")

@router.get("/furniture/{furniture_id}/preview3d")
def get_furniture_preview3d(furniture_id: str):
    path = find_file(FURNITURE_PREVIEWS_3D, furniture_id, IMAGE_EXTENSIONS)
    if not path:
        raise HTTPException(404, "3D preview not found")
    return FileResponse(path)

@router.post("/furniture/{furniture_id}/model")
async def upload_furniture_model(
    furniture_id: str,
    file: UploadFile = File(...)
):
    """
    Upload a furniture model (GLB file).
    Processes the model to fix bounds, recenter origin, and generate 3D preview.
    """
    content = await file.read()

    # Process the model and generate 3D preview
    processor = ModelProcessor()
    result = processor.process_glb(
        content,
        origin_placement='bottom-center',
        generate_preview=True
    )

    # Save processed GLB
    FURNITURE_MODELS.mkdir(parents=True, exist_ok=True)
    model_path = FURNITURE_MODELS / f"{furniture_id}.glb"
    model_path.write_bytes(result['glb'])

    # Save 3D preview
    preview_3d_path = None
    if result['preview']:
        FURNITURE_PREVIEWS_3D.mkdir(parents=True, exist_ok=True)
        preview_3d_path = FURNITURE_PREVIEWS_3D / f"{furniture_id}.png"
        preview_3d_path.write_bytes(result['preview'])

    # Update database
    db = get_furniture_db()
    if preview_3d_path:
        db.execute(
            "UPDATE furniture SET model_path = ?, preview_3d_path = ? WHERE id = ?",
            [str(model_path), str(preview_3d_path), furniture_id]
        )
    else:
        db.execute("UPDATE furniture SET model_path = ? WHERE id = ?", [str(model_path), furniture_id])

    return {"status": "uploaded", "path": str(model_path)}

@router.get("/furniture/{furniture_id}/model")
def get_furniture_model(furniture_id: str):
    # Try GLB first (new format), fall back to ZIP (legacy)
    glb_path = FURNITURE_MODELS / f"{furniture_id}.glb"
    if glb_path.exists():
        return FileResponse(glb_path, media_type="model/gltf-binary")

    zip_path = FURNITURE_MODELS / f"{furniture_id}.zip"
    if zip_path.exists():
        return FileResponse(zip_path, media_type="application/zip")

    raise HTTPException(404, "Model not found")

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
