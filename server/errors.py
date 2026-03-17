"""Server error logging utility."""

import json
import logging
import traceback as tb_module
from uuid import uuid4

from db.connection import get_auth_db

logger = logging.getLogger(__name__)


def log_error(error_type: str, source: str, message: str, traceback: str = None,
              org_id: str = None, endpoint: str = None, metadata: dict = None):
    """Log an error to the error_log table."""
    try:
        auth_db = get_auth_db()
        auth_db.execute(
            """INSERT INTO error_log (id, error_type, source, message, traceback, org_id, endpoint, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [str(uuid4()), error_type, source, message, traceback, org_id, endpoint,
             json.dumps(metadata) if metadata else None]
        )
    except Exception as e:
        logger.error(f"Failed to log error to DB: {e}")


def log_exception(exc: Exception, source: str, org_id: str = None,
                  endpoint: str = None, metadata: dict = None):
    """Log an exception with full traceback."""
    log_error(
        error_type=type(exc).__name__,
        source=source,
        message=str(exc),
        traceback=tb_module.format_exc(),
        org_id=org_id,
        endpoint=endpoint,
        metadata=metadata,
    )
