"""Org-facing feedback endpoints."""

import logging
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from db.connection import get_auth_db
from routers.auth import verify_token

logger = logging.getLogger(__name__)
router = APIRouter()


class FeedbackSubmit(BaseModel):
    message: str


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
    return {"id": feedback_id, "status": "open"}


@router.get("/")
def get_own_feedback(org_id: str = Depends(verify_token)):
    """Get feedback submitted by this org."""
    db = get_auth_db()
    rows = db.execute(
        """SELECT id, message, status, created_at, updated_at
           FROM feedback WHERE org_id = ? ORDER BY created_at DESC""",
        [org_id]
    ).fetchall()

    return [
        {
            "id": r[0], "message": r[1], "status": r[2],
            "createdAt": str(r[3]), "updatedAt": str(r[4]),
        }
        for r in rows
    ]
