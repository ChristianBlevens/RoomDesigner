"""
Meshy.ai API router for image-to-3D model generation.
Handles task creation, status polling, and model download.
"""

import os
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel
import httpx

from config import FURNITURE_MODELS, FURNITURE_THUMBNAILS
from model_processor import ModelProcessor, generate_thumbnail_async

router = APIRouter()

# API Configuration
MESHY_API_KEY = os.environ.get("MESHY_API_KEY")
MESHY_API_BASE = "https://api.meshy.ai/openapi/v1"


class GenerateRequest(BaseModel):
    image_url: str


class DownloadRequest(BaseModel):
    glb_url: str


def get_meshy_headers():
    """Get headers for Meshy API requests."""
    if not MESHY_API_KEY:
        raise HTTPException(status_code=500, detail="MESHY_API_KEY environment variable not configured")
    return {
        "Authorization": f"Bearer {MESHY_API_KEY}",
        "Content-Type": "application/json"
    }


@router.post("/generate/{furniture_id}")
async def generate_model(furniture_id: str, request: GenerateRequest):
    """
    Start image-to-3D generation task with Meshy.ai.
    Returns the task_id for polling.
    """
    headers = get_meshy_headers()

    payload = {
        "image_url": request.image_url,
        "should_remesh": True,
        "enable_pbr": False
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.post(
                f"{MESHY_API_BASE}/image-to-3d",
                headers=headers,
                json=payload
            )

            if response.status_code != 200 and response.status_code != 202:
                # Try to parse JSON error for cleaner message
                try:
                    error_json = response.json()
                    error_msg = error_json.get("message", response.text)
                    # Check for subscription-related errors
                    if "free plan" in error_msg.lower() or "upgrade" in error_msg.lower():
                        raise HTTPException(
                            status_code=402,
                            detail="Meshy.ai requires a paid subscription. Please upgrade at https://www.meshy.ai/settings/subscription"
                        )
                except (ValueError, KeyError):
                    error_msg = response.text
                raise HTTPException(
                    status_code=502,
                    detail=f"Meshy API error: {error_msg}"
                )

            result = response.json()
            task_id = result.get("result")

            if not task_id:
                raise HTTPException(
                    status_code=502,
                    detail="Meshy API did not return a task ID"
                )

            return {"task_id": task_id}

        except httpx.TimeoutException:
            raise HTTPException(
                status_code=504,
                detail="Meshy API request timed out"
            )
        except httpx.RequestError as e:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to connect to Meshy API: {str(e)}"
            )


@router.get("/status/{task_id}")
async def get_task_status(task_id: str):
    """
    Poll Meshy task status.
    Returns status, progress percentage, and model URLs when complete.
    """
    headers = get_meshy_headers()

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.get(
                f"{MESHY_API_BASE}/image-to-3d/{task_id}",
                headers=headers
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"Meshy API error: {response.text}"
                )

            data = response.json()

            return {
                "status": data.get("status"),
                "progress": data.get("progress", 0),
                "model_urls": data.get("model_urls"),
                "message": data.get("message")
            }

        except httpx.TimeoutException:
            raise HTTPException(
                status_code=504,
                detail="Meshy API request timed out"
            )


@router.post("/download/{furniture_id}")
async def download_model(
    furniture_id: str,
    request: DownloadRequest,
    background_tasks: BackgroundTasks
):
    """
    Download the generated GLB model from Meshy's temporary URL,
    process it (fix bounds, recenter), save to storage.
    Thumbnail generation happens async in background.
    """
    glb_url = request.glb_url

    if not glb_url:
        raise HTTPException(status_code=400, detail="No GLB URL provided")

    # Download GLB from Meshy
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            response = await client.get(glb_url)

            if response.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to download model from Meshy: {response.status_code}"
                )

            glb_content = response.content

        except httpx.TimeoutException:
            raise HTTPException(
                status_code=504,
                detail="Model download timed out"
            )
        except httpx.RequestError as e:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to download model: {str(e)}"
            )

    # Process the model (fix bounds, recenter)
    processor = ModelProcessor()
    result = processor.process_glb(
        glb_content,
        origin_placement='bottom-center',
        generate_thumbnail=False
    )

    # Save processed GLB directly
    FURNITURE_MODELS.mkdir(parents=True, exist_ok=True)
    model_path = FURNITURE_MODELS / f"{furniture_id}.glb"
    model_path.write_bytes(result['glb'])

    # Update database to set model_path
    from db.connection import get_furniture_db
    conn = get_furniture_db()
    conn.execute(
        "UPDATE furniture SET model_path = ? WHERE id = ?",
        [str(model_path), furniture_id]
    )

    # Queue async thumbnail generation (runs in background, limited concurrency)
    thumbnail_path = FURNITURE_THUMBNAILS / f"{furniture_id}.png"
    background_tasks.add_task(
        generate_thumbnail_async,
        model_path,
        thumbnail_path,
        furniture_id
    )

    return {
        "success": True,
        "model_url": f"/api/files/furniture/{furniture_id}/model"
    }
