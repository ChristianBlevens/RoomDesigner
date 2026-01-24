"""
Server-Sent Events (SSE) for real-time client notifications.
Used to notify clients when async operations complete (e.g., 3D preview generation).
"""

import asyncio
import json
import logging
from typing import AsyncGenerator

logger = logging.getLogger(__name__)

# Connected SSE clients
_clients: set[asyncio.Queue] = set()


async def subscribe() -> AsyncGenerator[str, None]:
    """
    Subscribe to SSE events. Yields formatted SSE messages.
    """
    queue: asyncio.Queue = asyncio.Queue()
    _clients.add(queue)
    logger.info(f"SSE client connected. Total clients: {len(_clients)}")

    try:
        while True:
            event = await queue.get()
            yield f"event: {event['type']}\ndata: {json.dumps(event['data'])}\n\n"
    except asyncio.CancelledError:
        pass
    finally:
        _clients.discard(queue)
        logger.info(f"SSE client disconnected. Total clients: {len(_clients)}")


def publish(event_type: str, data: dict):
    """
    Publish an event to all connected SSE clients.
    Non-blocking - queues the event for each client.
    """
    if not _clients:
        return

    event = {"type": event_type, "data": data}
    for queue in _clients:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning("SSE client queue full, dropping event")
