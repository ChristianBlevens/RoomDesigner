"""Org-facing feedback endpoints."""

import logging
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional

from db.connection import get_auth_db
from routers.auth import verify_token
from activity import log_activity
from errors import log_error

logger = logging.getLogger(__name__)
router = APIRouter()


class FeedbackSubmit(BaseModel):
    message: str


class ErrorReport(BaseModel):
    message: str
    source: Optional[str] = None
    line: Optional[int] = None
    column: Optional[int] = None
    stack: Optional[str] = None
    url: Optional[str] = None
    userAgent: Optional[str] = None


@router.post("/")
def submit_feedback(body: FeedbackSubmit, org_id: str = Depends(verify_token)):
    """Submit feedback (any authenticated org, including demo)."""
    if not body.message.strip():
        raise HTTPException(400, "Message cannot be empty")

    db = get_auth_db()
    feedback_id = uuid4().hex
    db.execute(
        """INSERT INTO feedback (id, org_id, message, status, created_at, updated_at)
           VALUES (?, ?, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""",
        [feedback_id, org_id, body.message.strip()]
    )
    log_activity("org", org_id, "submit_feedback", "feedback", resource_id=feedback_id,
                 details={"message_preview": body.message.strip()[:80]})
    return {"id": feedback_id, "status": "open"}


@router.post("/error-report")
def submit_error_report(body: ErrorReport, org_id: str = Depends(verify_token)):
    """Auto-submit a frontend error report to the error log."""
    log_error(
        error_type="FrontendError",
        source=body.source or "frontend",
        message=body.message[:500],
        traceback=body.stack,
        org_id=org_id,
        endpoint=body.url,
        metadata={
            "line": body.line,
            "column": body.column,
            "userAgent": body.userAgent,
        },
    )
    return {"status": "reported"}


@router.get("/")
def get_own_feedback(org_id: str = Depends(verify_token)):
    """Get feedback submitted by this org, including admin responses."""
    db = get_auth_db()
    rows = db.execute(
        """SELECT id, message, status, admin_notes, created_at, updated_at
           FROM feedback WHERE org_id = ? ORDER BY created_at DESC""",
        [org_id]
    ).fetchall()

    return [
        {
            "id": r[0], "message": r[1], "status": r[2],
            "adminNotes": r[3] if r[3] else None,
            "createdAt": str(r[4]), "updatedAt": str(r[5]),
        }
        for r in rows
    ]
