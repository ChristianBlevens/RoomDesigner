"""Usage tracking and allowance system for paid services."""

import json
import logging
from datetime import datetime, timezone, timedelta
from uuid import uuid4

from db.connection import get_auth_db

logger = logging.getLogger(__name__)

# PST is UTC-8 (no DST handling — use fixed offset for simplicity)
PST_OFFSET = timedelta(hours=-8)

# Default daily allowances for new orgs
DEFAULT_ALLOWANCES = {
    "model_3d": 50,   # Meshy/TRELLIS.2 (~$10/day)
    "modal": 100,     # MoGe, SAM 3 (~$5/day)
    "gemini": 50,     # Gemini enhance/wall-color/clear/fix (~$15/day)
}

# Human-readable service category names for error messages
SERVICE_NAMES = {
    "model_3d": "3D model generation",
    "modal": "AI processing (room/segmentation)",
    "gemini": "AI image editing",
}


def _get_pst_midnight_utc() -> str:
    """Get today's midnight PST as a UTC timestamp string for SQL comparison."""
    now_utc = datetime.now(timezone.utc)
    now_pst = now_utc + PST_OFFSET
    midnight_pst = now_pst.replace(hour=0, minute=0, second=0, microsecond=0)
    midnight_utc = midnight_pst - PST_OFFSET
    return midnight_utc.strftime("%Y-%m-%d %H:%M:%S")


def get_usage_today(org_id: str, service_category: str) -> int:
    """Count today's usage (since midnight PST) for this org + service category."""
    db = get_auth_db()
    midnight = _get_pst_midnight_utc()
    row = db.execute(
        "SELECT COUNT(*) FROM usage_log WHERE org_id = ? AND service_category = ? AND created_at >= ?",
        [org_id, service_category, midnight]
    ).fetchone()
    return row[0] if row else 0


def check_allowance(org_id: str, service_category: str, is_admin_impersonating: bool = False) -> tuple:
    """
    Check if org can use this service today.

    Returns (allowed: bool, message: str).
    - Demo mode orgs: always blocked (all allowances treated as 0)
    - Admin impersonating: always allowed (bypasses check)
    - Otherwise: checks today's count vs daily_limit
    """
    # Admin impersonation always bypasses
    if is_admin_impersonating:
        return (True, "")

    db = get_auth_db()

    # Check demo mode — acts as override, treats all limits as 0
    org_row = db.execute("SELECT demo_mode FROM orgs WHERE id = ?", [org_id]).fetchone()
    if org_row and org_row[0]:
        return (False, "This feature is not available in demo mode")

    # Get allowance for this service category
    row = db.execute(
        "SELECT daily_limit FROM org_allowances WHERE org_id = ? AND service_category = ?",
        [org_id, service_category]
    ).fetchone()

    if not row or row[0] is None:
        # No limit set = unlimited
        return (True, "")

    daily_limit = row[0]
    if daily_limit == 0:
        service_name = SERVICE_NAMES.get(service_category, service_category)
        return (False, f"Daily limit reached for {service_name} — contact admin")

    today_count = get_usage_today(org_id, service_category)

    if today_count >= daily_limit:
        service_name = SERVICE_NAMES.get(service_category, service_category)
        return (False, f"Daily limit reached for {service_name} ({today_count}/{daily_limit}) — contact admin")

    return (True, "")


def get_allowance_warning(org_id: str, service_category: str) -> dict | None:
    """
    Check if org is at or above 80% of daily allowance.
    Returns warning dict or None.
    """
    db = get_auth_db()
    row = db.execute(
        "SELECT daily_limit FROM org_allowances WHERE org_id = ? AND service_category = ?",
        [org_id, service_category]
    ).fetchone()

    if not row or row[0] is None or row[0] == 0:
        return None

    daily_limit = row[0]
    today_count = get_usage_today(org_id, service_category)
    # +1 because we check after the call succeeds (count is about to increase)
    usage_after = today_count + 1

    if usage_after >= daily_limit * 0.8:
        service_name = SERVICE_NAMES.get(service_category, service_category)
        return {
            "warning": f"You've used {usage_after} of {daily_limit} daily {service_name} calls",
            "used": usage_after,
            "limit": daily_limit,
            "service": service_category,
        }
    return None


def log_usage(
    org_id: str,
    service_category: str,
    action: str,
    success: bool,
    duration_ms: int = None,
    error_message: str = None,
    admin_initiated: bool = False,
    metadata: dict = None,
):
    """Record a paid service usage event."""
    db = get_auth_db()
    db.execute(
        """INSERT INTO usage_log (id, org_id, service_category, action, success, duration_ms,
           error_message, admin_initiated, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
        [
            uuid4().hex,
            org_id,
            service_category,
            action,
            success,
            duration_ms,
            error_message,
            admin_initiated,
            json.dumps(metadata) if metadata else None,
        ]
    )


def create_default_allowances(org_id: str):
    """Insert default allowances for a new org."""
    db = get_auth_db()
    for service_category, limit in DEFAULT_ALLOWANCES.items():
        db.execute(
            """INSERT INTO org_allowances (org_id, service_category, daily_limit)
               VALUES (?, ?, ?)
               ON CONFLICT (org_id, service_category) DO NOTHING""",
            [org_id, service_category, limit]
        )
