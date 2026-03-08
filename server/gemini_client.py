"""Async Gemini API client for image editing."""

import logging
import os

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
GEMINI_IMAGE_MODEL = os.getenv("GEMINI_IMAGE_MODEL", "gemini-3-pro-image-preview")

_client = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        if not GOOGLE_API_KEY:
            raise RuntimeError("GOOGLE_API_KEY environment variable not configured")
        _client = genai.Client(api_key=GOOGLE_API_KEY)
    return _client


async def edit_image(image_bytes: bytes, prompt: str, mime_type: str = "image/png") -> bytes:
    """Send image + text prompt to Gemini, return edited image bytes."""
    client = get_client()
    response = await client.aio.models.generate_content(
        model=GEMINI_IMAGE_MODEL,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            prompt,
        ],
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE"],
        ),
    )
    for part in response.candidates[0].content.parts:
        if part.inline_data:
            return part.inline_data.data
    raise RuntimeError("No image in Gemini response")
