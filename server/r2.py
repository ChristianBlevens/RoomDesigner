"""
Cloudflare R2 storage client (S3-compatible).
Handles upload, download, delete, and URL generation for all binary assets.
"""

import os
import logging
import tempfile
from pathlib import Path
from typing import Optional

import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)

# R2 Configuration from environment
R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME", "roomdesigner")
R2_PUBLIC_URL = os.environ.get("R2_PUBLIC_URL", "")

_client = None


def get_client():
    """Get or create S3 client for R2."""
    global _client
    if _client is None:
        if not (R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY):
            raise RuntimeError(
                "R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
            )

        _client = boto3.client(
            's3',
            endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            config=Config(
                signature_version='s3v4',
                retries={'max_attempts': 3, 'mode': 'adaptive'}
            ),
            region_name='auto'
        )
    return _client


def upload_bytes(key: str, data: bytes, content_type: str = 'application/octet-stream') -> str:
    """
    Upload bytes to R2.

    Args:
        key: Object key (e.g., "furniture/images/uuid.jpg")
        data: File content bytes
        content_type: MIME type

    Returns:
        Public URL for the uploaded object
    """
    client = get_client()
    client.put_object(
        Bucket=R2_BUCKET_NAME,
        Key=key,
        Body=data,
        ContentType=content_type
    )
    logger.info(f"Uploaded {len(data)} bytes to R2: {key}")
    return get_public_url(key)


def download_bytes(key: str) -> Optional[bytes]:
    """Download bytes from R2. Returns None if not found."""
    client = get_client()
    try:
        response = client.get_object(Bucket=R2_BUCKET_NAME, Key=key)
        return response['Body'].read()
    except client.exceptions.NoSuchKey:
        return None


def delete_object(key: str):
    """Delete an object from R2."""
    client = get_client()
    try:
        client.delete_object(Bucket=R2_BUCKET_NAME, Key=key)
        logger.info(f"Deleted from R2: {key}")
    except Exception as e:
        logger.warning(f"Failed to delete R2 object {key}: {e}")


def delete_objects(keys: list[str]):
    """Delete multiple objects from R2."""
    if not keys:
        return
    client = get_client()
    try:
        client.delete_objects(
            Bucket=R2_BUCKET_NAME,
            Delete={'Objects': [{'Key': k} for k in keys]}
        )
        logger.info(f"Deleted {len(keys)} objects from R2")
    except Exception as e:
        logger.warning(f"Failed to delete R2 objects: {e}")


def get_public_url(key: str) -> str:
    """Get public URL for an R2 object."""
    if R2_PUBLIC_URL:
        return f"{R2_PUBLIC_URL.rstrip('/')}/{key}"
    return f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{R2_BUCKET_NAME}/{key}"


def object_exists(key: str) -> bool:
    """Check if an object exists in R2."""
    client = get_client()
    try:
        client.head_object(Bucket=R2_BUCKET_NAME, Key=key)
        return True
    except Exception:
        return False


# Content type mapping
CONTENT_TYPES = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'webp': 'image/webp',
    'glb': 'model/gltf-binary',
    'zip': 'application/zip',
}


def get_content_type(ext: str) -> str:
    """Get MIME type for file extension."""
    return CONTENT_TYPES.get(ext.lower(), 'application/octet-stream')


class TempFile:
    """Context manager for temporary file processing (upload -> process -> R2 -> cleanup)."""

    def __init__(self, suffix: str = '.glb'):
        self.suffix = suffix
        self.path = None

    def __enter__(self) -> Path:
        fd, path = tempfile.mkstemp(suffix=self.suffix)
        os.close(fd)
        self.path = Path(path)
        return self.path

    def __exit__(self, *args):
        if self.path and self.path.exists():
            self.path.unlink()
