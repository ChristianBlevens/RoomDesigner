"""Unified activity logging utility."""

import json
import logging
from uuid import uuid4

from db.connection import get_auth_db

logger = logging.getLogger(__name__)


def log_activity(actor_type: str, actor_id: str, action: str, resource_type: str,
                 resource_id: str = None, resource_name: str = None, details: dict = None):
    """Log an activity event to the activity_log table.

    Args:
        actor_type: 'org', 'admin', or 'system'
        actor_id: org_id, 'admin', or 'system'
        action: e.g. 'create_house', 'signin', 'admin_delete_org'
        resource_type: e.g. 'house', 'room', 'furniture', 'org'
        resource_id: ID of the affected resource
        resource_name: human-readable name of the resource
        details: action-specific context dict
    """
    try:
        auth_db = get_auth_db()
        auth_db.execute(
            """INSERT INTO activity_log
               (id, actor_type, actor_id, action, resource_type, resource_id, resource_name, details)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [str(uuid4()), actor_type, actor_id, action, resource_type,
             resource_id, resource_name, json.dumps(details) if details else None]
        )
    except Exception as e:
        logger.error(f"Failed to log activity: {e}")


def diff_room_state(old_state: dict, new_state: dict):
    """Compare old and new room state, return list of activity descriptions.

    Each entry is a dict with 'action' and 'details' keys.
    """
    changes = []

    # Compare placed furniture
    old_furn = {f.get('entryId'): f for f in (old_state.get('placed_furniture') or []) if f.get('entryId')}
    new_furn = {f.get('entryId'): f for f in (new_state.get('placed_furniture') or []) if f.get('entryId')}

    # Placed (added)
    for eid in new_furn:
        if eid not in old_furn:
            changes.append({'action': 'place_furniture', 'details': {'entry_id': eid}})

    # Removed
    for eid in old_furn:
        if eid not in new_furn:
            changes.append({'action': 'remove_furniture', 'details': {'entry_id': eid}})

    # Moved or rotated
    for eid in new_furn:
        if eid in old_furn:
            old_f = old_furn[eid]
            new_f = new_furn[eid]
            if old_f.get('position') != new_f.get('position'):
                changes.append({'action': 'move_furniture', 'details': {'entry_id': eid}})
            if (old_f.get('rotation') != new_f.get('rotation') or
                old_f.get('rotationAroundNormal') != new_f.get('rotationAroundNormal')):
                changes.append({'action': 'rotate_furniture', 'details': {'entry_id': eid}})

    # Lighting
    old_light = old_state.get('lighting_settings')
    new_light = new_state.get('lighting_settings')
    if old_light != new_light and new_light is not None:
        changed_settings = []
        if old_light and new_light:
            for key in new_light:
                if old_light.get(key) != new_light.get(key):
                    changed_settings.append(key)
        changes.append({'action': 'change_lighting', 'details': {'changed': changed_settings}})

    # Scale
    old_scale = old_state.get('room_scale')
    new_scale = new_state.get('room_scale')
    if new_scale is not None and old_scale != new_scale:
        changes.append({'action': 'change_scale', 'details': {'old': old_scale, 'new': new_scale}})

    # Meter stick
    old_ms = old_state.get('meter_stick')
    new_ms = new_state.get('meter_stick')
    if old_ms != new_ms:
        if (old_ms is None) != (new_ms is None):
            changes.append({'action': 'toggle_meter_stick', 'details': {}})
        elif old_ms and new_ms:
            if old_ms.get('visible') != new_ms.get('visible'):
                changes.append({'action': 'toggle_meter_stick', 'details': {}})
            elif old_ms.get('position') != new_ms.get('position'):
                changes.append({'action': 'move_meter_stick', 'details': {}})

    return changes
