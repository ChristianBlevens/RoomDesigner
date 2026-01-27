"""
Meshy.ai API router for image-to-3D model generation.
Server-side task management with background polling, persistence, and retry logic.
"""

import os
import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4
from typing import Optional
from dataclasses import dataclass

from fastapi import APIRouter, HTTPException
import httpx

from config import FURNITURE_MODELS, FURNITURE_PREVIEWS_3D
from model_processor import ModelProcessor
from db.connection import get_furniture_db

logger = logging.getLogger(__name__)

router = APIRouter()

# API Configuration
MESHY_API_KEY = os.environ.get("MESHY_API_KEY")
MESHY_API_BASE = "https://api.meshy.ai/openapi/v1"

# Task limits
MAX_CONCURRENT_TASKS = 10
MAX_RETRIES = 2  # 3 total attempts
POLL_INTERVAL = 5  # seconds
TASK_CLEANUP_AGE = 10  # seconds after completion/failure

# Background polling task reference
_polling_task: Optional[asyncio.Task] = None


@dataclass
class MeshyTask:
    """Task data from database."""
    id: str
    furniture_id: str
    meshy_task_id: Optional[str]
    status: str
    progress: int
    retry_count: int
    error_message: Optional[str]
    glb_url: Optional[str]
    created_at: datetime
    updated_at: datetime


class MeshyError(Exception):
    """Base exception for Meshy operations."""
    pass


class RetryableError(MeshyError):
    """Error that should trigger a retry."""
    pass


class PermanentError(MeshyError):
    """Error that should not be retried."""
    pass


# ============ Database Operations ============

def get_task(task_id: str) -> Optional[MeshyTask]:
    """Get a task by ID."""
    conn = get_furniture_db()
    row = conn.execute(
        "SELECT * FROM meshy_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        return None
    return MeshyTask(*row)


def get_active_tasks() -> list[MeshyTask]:
    """Get all tasks that need processing."""
    conn = get_furniture_db()
    rows = conn.execute(
        "SELECT * FROM meshy_tasks WHERE status IN ('pending', 'creating', 'polling', 'downloading')"
    ).fetchall()
    return [MeshyTask(*row) for row in rows]


def get_all_tasks() -> list[dict]:
    """Get all non-purged tasks with furniture names for client display."""
    conn = get_furniture_db()
    rows = conn.execute("""
        SELECT t.id, t.furniture_id, t.status, t.progress, t.error_message,
               COALESCE(f.name, 'Unknown') as furniture_name
        FROM meshy_tasks t
        LEFT JOIN furniture f ON t.furniture_id = f.id
        ORDER BY t.created_at DESC
    """).fetchall()
    return [
        {
            "id": row[0],
            "furniture_id": row[1],
            "status": row[2],
            "progress": row[3],
            "error_message": row[4],
            "furniture_name": row[5]
        }
        for row in rows
    ]


def count_active_tasks() -> int:
    """Count tasks that are actively using Meshy API slots."""
    conn = get_furniture_db()
    result = conn.execute(
        "SELECT COUNT(*) FROM meshy_tasks WHERE status IN ('pending', 'creating', 'polling', 'downloading')"
    ).fetchone()
    return result[0] if result else 0


def create_task(furniture_id: str) -> str:
    """Create a new task and return its ID."""
    task_id = str(uuid4())
    conn = get_furniture_db()
    conn.execute(
        """INSERT INTO meshy_tasks (id, furniture_id, status, progress, retry_count, created_at, updated_at)
           VALUES (?, ?, 'pending', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""",
        [task_id, furniture_id]
    )
    return task_id


def update_task(task_id: str, **kwargs):
    """Update task fields."""
    if not kwargs:
        return

    # Build SET clause
    set_parts = ["updated_at = CURRENT_TIMESTAMP"]
    values = []
    for key, value in kwargs.items():
        set_parts.append(f"{key} = ?")
        values.append(value)
    values.append(task_id)

    conn = get_furniture_db()
    conn.execute(
        f"UPDATE meshy_tasks SET {', '.join(set_parts)} WHERE id = ?",
        values
    )


def delete_task(task_id: str):
    """Delete a task."""
    conn = get_furniture_db()
    conn.execute("DELETE FROM meshy_tasks WHERE id = ?", [task_id])


def cleanup_old_tasks():
    """Remove completed/failed tasks older than TASK_CLEANUP_AGE seconds."""
    conn = get_furniture_db()
    cutoff = datetime.now() - timedelta(seconds=TASK_CLEANUP_AGE)
    conn.execute(
        """DELETE FROM meshy_tasks
           WHERE status IN ('completed', 'failed')
           AND updated_at < ?""",
        [cutoff]
    )


# ============ Meshy API Operations ============

def get_meshy_headers() -> dict:
    """Get headers for Meshy API requests."""
    if not MESHY_API_KEY:
        raise PermanentError("MESHY_API_KEY environment variable not configured")
    return {
        "Authorization": f"Bearer {MESHY_API_KEY}",
        "Content-Type": "application/json"
    }


async def create_meshy_task(furniture_id: str) -> str:
    """Create a Meshy.ai generation task and return the meshy_task_id."""
    headers = get_meshy_headers()

    # Build image URL - need the server's external URL
    base_url = os.environ.get("SERVER_BASE_URL", "http://localhost:8000")
    image_url = f"{base_url}/api/files/furniture/{furniture_id}/image"

    payload = {
        "image_url": image_url,
        "should_remesh": True,
        "enable_pbr": False,
        "target_polycount": 10000
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.post(
                f"{MESHY_API_BASE}/image-to-3d",
                headers=headers,
                json=payload
            )

            if response.status_code in (200, 202):
                result = response.json()
                meshy_task_id = result.get("result")
                if not meshy_task_id:
                    raise PermanentError("Meshy API did not return a task ID")
                return meshy_task_id

            # Handle errors
            try:
                error_json = response.json()
                error_msg = error_json.get("message", response.text)
            except Exception:
                error_msg = response.text

            # Check for permanent errors (4xx)
            if 400 <= response.status_code < 500:
                if "free plan" in error_msg.lower() or "upgrade" in error_msg.lower():
                    raise PermanentError("Meshy.ai requires a paid subscription")
                raise PermanentError(f"Meshy API error: {error_msg}")

            # 5xx errors are retryable
            raise RetryableError(f"Meshy API error ({response.status_code}): {error_msg}")

        except httpx.TimeoutException:
            raise RetryableError("Meshy API request timed out")
        except httpx.RequestError as e:
            raise RetryableError(f"Failed to connect to Meshy API: {str(e)}")


async def poll_meshy_status(meshy_task_id: str) -> dict:
    """Poll Meshy for task status. Returns dict with status, progress, glb_url, message."""
    headers = get_meshy_headers()

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.get(
                f"{MESHY_API_BASE}/image-to-3d/{meshy_task_id}",
                headers=headers
            )

            if response.status_code != 200:
                raise RetryableError(f"Meshy status check failed: {response.status_code}")

            data = response.json()

            return {
                "status": data.get("status"),
                "progress": data.get("progress", 0),
                "glb_url": data.get("model_urls", {}).get("glb"),
                "message": data.get("message")
            }

        except httpx.TimeoutException:
            raise RetryableError("Meshy status check timed out")
        except httpx.RequestError as e:
            raise RetryableError(f"Meshy status check failed: {str(e)}")


async def download_and_process_glb(task: MeshyTask):
    """Download GLB from Meshy and process it."""
    if not task.glb_url:
        raise PermanentError("No GLB URL available")

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            response = await client.get(task.glb_url)

            if response.status_code != 200:
                raise RetryableError(f"Failed to download model: {response.status_code}")

            glb_content = response.content

        except httpx.TimeoutException:
            raise RetryableError("Model download timed out")
        except httpx.RequestError as e:
            raise RetryableError(f"Model download failed: {str(e)}")

    # Process the model (CPU-intensive, run in thread pool)
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        _process_glb_sync,
        glb_content,
        task.furniture_id
    )

    return result


def _process_glb_sync(glb_content: bytes, furniture_id: str) -> dict:
    """Synchronous GLB processing (for thread pool)."""
    processor = ModelProcessor()
    result = processor.process_glb(
        glb_content,
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

    # Update furniture database
    conn = get_furniture_db()
    if preview_3d_path:
        conn.execute(
            "UPDATE furniture SET model_path = ?, preview_3d_path = ? WHERE id = ?",
            [str(model_path), str(preview_3d_path), furniture_id]
        )
    else:
        conn.execute(
            "UPDATE furniture SET model_path = ? WHERE id = ?",
            [str(model_path), furniture_id]
        )

    return {"model_path": str(model_path), "preview_path": str(preview_3d_path) if preview_3d_path else None}


# ============ Background Polling Loop ============

async def process_task(task: MeshyTask):
    """Process a single task based on its current state."""
    try:
        if task.status == 'pending':
            # Create Meshy task
            update_task(task.id, status='creating')
            meshy_task_id = await create_meshy_task(task.furniture_id)
            update_task(task.id, meshy_task_id=meshy_task_id, status='polling')
            logger.info(f"Created Meshy task {meshy_task_id} for furniture {task.furniture_id}")

        elif task.status == 'creating':
            # Interrupted during creation - restart
            update_task(task.id, status='pending')

        elif task.status == 'polling':
            # Poll Meshy for status
            result = await poll_meshy_status(task.meshy_task_id)
            update_task(task.id, progress=result['progress'])

            if result['status'] == 'SUCCEEDED':
                update_task(task.id, status='downloading', glb_url=result['glb_url'])
                logger.info(f"Meshy task {task.meshy_task_id} completed, downloading...")
            elif result['status'] == 'FAILED':
                raise PermanentError(result.get('message', 'Generation failed'))

        elif task.status == 'downloading':
            # Download and process GLB
            await download_and_process_glb(task)
            update_task(task.id, status='completed', progress=100)
            logger.info(f"Completed processing for furniture {task.furniture_id}")

    except RetryableError as e:
        handle_task_error(task, e, retryable=True)
    except PermanentError as e:
        handle_task_error(task, e, retryable=False)
    except Exception as e:
        logger.exception(f"Unexpected error processing task {task.id}")
        handle_task_error(task, e, retryable=True)


def handle_task_error(task: MeshyTask, error: Exception, retryable: bool):
    """Handle task error with retry logic."""
    error_msg = str(error)

    if retryable and task.retry_count < MAX_RETRIES:
        # Retry: reset to pending, increment counter
        logger.warning(f"Task {task.id} failed (attempt {task.retry_count + 1}/{MAX_RETRIES + 1}): {error_msg}")
        update_task(task.id, status='pending', retry_count=task.retry_count + 1)
    else:
        # Give up: mark as failed
        logger.error(f"Task {task.id} permanently failed: {error_msg}")
        update_task(task.id, status='failed', error_message=error_msg)


async def polling_loop():
    """Main background polling loop."""
    logger.info("Starting Meshy polling loop")

    while True:
        try:
            # Get all active tasks
            tasks = get_active_tasks()

            # Process each task
            for task in tasks:
                try:
                    await process_task(task)
                except Exception as e:
                    logger.exception(f"Error processing task {task.id}: {e}")

            # Cleanup old completed/failed tasks
            cleanup_old_tasks()

        except Exception as e:
            logger.exception(f"Error in polling loop: {e}")

        await asyncio.sleep(POLL_INTERVAL)


def start_polling():
    """Start the background polling loop."""
    global _polling_task
    if _polling_task is None or _polling_task.done():
        _polling_task = asyncio.create_task(polling_loop())
        logger.info("Meshy polling task started")


def stop_polling():
    """Stop the background polling loop."""
    global _polling_task
    if _polling_task and not _polling_task.done():
        _polling_task.cancel()
        logger.info("Meshy polling task stopped")


# ============ API Endpoints ============

@router.post("/generate/{furniture_id}")
async def generate_model(furniture_id: str):
    """
    Start image-to-3D generation task.
    Returns immediately with task_id. Background loop handles the rest.
    """
    # Check capacity
    active = count_active_tasks()
    if active >= MAX_CONCURRENT_TASKS:
        raise HTTPException(
            status_code=429,
            detail=f"Maximum concurrent tasks ({MAX_CONCURRENT_TASKS}) reached. Please wait."
        )

    # Verify furniture entry exists and has an image
    conn = get_furniture_db()
    row = conn.execute(
        "SELECT image_path FROM furniture WHERE id = ?", [furniture_id]
    ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Furniture entry not found")
    if not row[0]:
        raise HTTPException(status_code=400, detail="Furniture entry has no image")

    # Create task
    task_id = create_task(furniture_id)
    logger.info(f"Created task {task_id} for furniture {furniture_id}")

    return {"task_id": task_id}


@router.get("/tasks")
async def get_tasks():
    """
    Get all active and recently completed/failed tasks.
    Used by client to poll for status updates.
    """
    tasks = get_all_tasks()
    active = sum(1 for t in tasks if t['status'] in ('pending', 'creating', 'polling', 'downloading'))

    return {
        "tasks": tasks,
        "active": active,
        "max": MAX_CONCURRENT_TASKS
    }


@router.get("/status/{task_id}")
async def get_task_status(task_id: str):
    """
    Get status of a specific task.
    """
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Get furniture name
    conn = get_furniture_db()
    row = conn.execute(
        "SELECT name FROM furniture WHERE id = ?", [task.furniture_id]
    ).fetchone()
    furniture_name = row[0] if row else "Unknown"

    return {
        "id": task.id,
        "furniture_id": task.furniture_id,
        "furniture_name": furniture_name,
        "status": task.status,
        "progress": task.progress,
        "error_message": task.error_message
    }


@router.delete("/tasks/{task_id}")
async def cancel_task(task_id: str):
    """
    Cancel a pending or in-progress task.
    Note: The Meshy task will continue on their servers, but we stop tracking it.
    """
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.status in ('completed', 'failed'):
        raise HTTPException(status_code=400, detail="Cannot cancel completed or failed task")

    delete_task(task_id)
    logger.info(f"Cancelled task {task_id}")

    return {"success": True}
