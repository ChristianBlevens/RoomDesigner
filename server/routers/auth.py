import os
import json
import uuid
import logging
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

import jwt
import bcrypt

from db.connection import get_auth_db

logger = logging.getLogger(__name__)

limiter = Limiter(key_func=get_remote_address)
router = APIRouter()
security = HTTPBearer()

JWT_SECRET = None
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 30

def _is_token_revoked(jti: str) -> bool:
    """Check if a JTI has been revoked (persisted in auth.db)."""
    db = get_auth_db()
    row = db.execute("SELECT 1 FROM revoked_tokens WHERE jti = ?", [jti]).fetchone()
    return row is not None


def _revoke_token(jti: str):
    """Revoke a token by storing its JTI in auth.db."""
    db = get_auth_db()
    db.execute(
        "INSERT INTO revoked_tokens (jti) VALUES (?) ON CONFLICT DO NOTHING", [jti]
    )


def init_auth_secret():
    """Initialize JWT secret from DB or generate new one."""
    global JWT_SECRET
    db = get_auth_db()
    row = db.execute("SELECT value FROM settings WHERE key = 'jwt_secret'").fetchone()
    if row:
        JWT_SECRET = row[0]
    else:
        JWT_SECRET = uuid.uuid4().hex + uuid.uuid4().hex
        db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            ['jwt_secret', JWT_SECRET]
        )
    logger.info("Auth secret initialized")


def create_token(org_id: str) -> str:
    """Create a JWT token for an org."""
    payload = {
        "org_id": org_id,
        "jti": uuid.uuid4().hex,
        "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRY_DAYS),
        "iat": datetime.utcnow(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_admin_token() -> str:
    """Create a JWT token for the admin."""
    payload = {
        "admin": True,
        "jti": uuid.uuid4().hex,
        "exp": datetime.utcnow() + timedelta(days=1),
        "iat": datetime.utcnow(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_admin(credentials: HTTPAuthorizationCredentials = Depends(security)) -> bool:
    """Verify JWT token has admin claim. Use as FastAPI dependency."""
    try:
        payload = jwt.decode(
            credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM]
        )
        if not payload.get("admin"):
            raise HTTPException(403, "Admin access required")
        jti = payload.get("jti")
        if jti and _is_token_revoked(jti):
            raise HTTPException(401, "Token revoked")
        return True
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """Verify JWT token and return org_id. Use as FastAPI dependency."""
    try:
        payload = jwt.decode(
            credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM]
        )
        org_id = payload.get("org_id")
        if not org_id:
            raise HTTPException(401, "Invalid token")
        jti = payload.get("jti")
        if jti and _is_token_revoked(jti):
            raise HTTPException(401, "Token revoked")
        return org_id
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")


# ============ Schemas ============

class SignUpRequest(BaseModel):
    username: str
    password: str

class SignInRequest(BaseModel):
    username: str
    password: str

class AuthResponse(BaseModel):
    token: str
    org_id: str
    username: str


# ============ Endpoints ============

@router.post("/signup", response_model=AuthResponse)
@limiter.limit("5/minute")
def sign_up(request: Request, body: SignUpRequest):
    db = get_auth_db()

    username = body.username.strip()
    if not username or len(username) < 2:
        raise HTTPException(400, "Username must be at least 2 characters")
    if len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    existing = db.execute(
        "SELECT id FROM orgs WHERE username = ?", [username]
    ).fetchone()
    if existing:
        raise HTTPException(409, "Username already taken")

    org_id = str(uuid.uuid4())
    password_hash = bcrypt.hashpw(
        body.password.encode('utf-8'), bcrypt.gensalt()
    ).decode('utf-8')

    db.execute(
        "INSERT INTO orgs (id, username, password_hash) VALUES (?, ?, ?)",
        [org_id, username, password_hash]
    )

    token = create_token(org_id)
    return AuthResponse(token=token, org_id=org_id, username=username)


@router.post("/signin")
@limiter.limit("10/minute")
def sign_in(request: Request, body: SignInRequest):
    admin_username = os.environ.get("ADMIN_USERNAME")
    admin_password = os.environ.get("ADMIN_PASSWORD")

    # Check admin credentials first
    if (admin_username and admin_password
        and body.username.strip() == admin_username
        and body.password == admin_password):
        token = create_admin_token()
        return {"token": token, "org_id": "admin", "username": admin_username, "admin": True}

    # Normal org sign-in
    db = get_auth_db()

    row = db.execute(
        "SELECT id, username, password_hash FROM orgs WHERE username = ?",
        [body.username.strip()]
    ).fetchone()

    if not row:
        raise HTTPException(401, "Invalid username or password")

    org_id, username, password_hash = row

    if not bcrypt.checkpw(
        body.password.encode('utf-8'), password_hash.encode('utf-8')
    ):
        raise HTTPException(401, "Invalid username or password")

    token = create_token(org_id)
    return AuthResponse(token=token, org_id=org_id, username=username)


@router.post("/logout")
def log_out(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Revoke the current token."""
    try:
        payload = jwt.decode(
            credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM]
        )
        jti = payload.get("jti")
        if jti:
            _revoke_token(jti)
    except jwt.InvalidTokenError:
        pass
    return {"status": "logged out"}


# ============ Wall Color Presets ============

class WallColorPreset(BaseModel):
    color: str
    name: Optional[str] = None

class WallColorPresetsRequest(BaseModel):
    presets: List[WallColorPreset]


@router.get("/presets/wall-colors")
def get_wall_color_presets(org_id: str = Depends(verify_token)):
    db = get_auth_db()
    row = db.execute(
        "SELECT wall_color_presets FROM orgs WHERE id = ?", [org_id]
    ).fetchone()
    if row and row[0]:
        return {"presets": json.loads(row[0])}
    return {"presets": None}


@router.put("/presets/wall-colors")
def save_wall_color_presets(body: WallColorPresetsRequest, org_id: str = Depends(verify_token)):
    db = get_auth_db()
    presets_json = json.dumps([p.model_dump() for p in body.presets])
    db.execute(
        "UPDATE orgs SET wall_color_presets = ? WHERE id = ?",
        [presets_json, org_id]
    )
    return {"status": "saved"}


# ============ De-staging Buffer Setting ============

class DestagingBufferRequest(BaseModel):
    days: int


@router.get("/settings/destaging-buffer")
def get_destaging_buffer(org_id: str = Depends(verify_token)):
    db = get_auth_db()
    row = db.execute(
        "SELECT destaging_buffer_days FROM orgs WHERE id = ?", [org_id]
    ).fetchone()
    return {"days": row[0] if row and row[0] else 0}


@router.put("/settings/destaging-buffer")
def save_destaging_buffer(body: DestagingBufferRequest, org_id: str = Depends(verify_token)):
    if body.days < 0:
        raise HTTPException(400, "Buffer days must be non-negative")
    db = get_auth_db()
    db.execute(
        "UPDATE orgs SET destaging_buffer_days = ? WHERE id = ?",
        [body.days, org_id]
    )
    return {"status": "saved"}
