from dotenv import load_dotenv
load_dotenv()

import os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, JSONResponse
from contextlib import asynccontextmanager
from pathlib import Path
import sys
from slowapi.errors import RateLimitExceeded

sys.path.insert(0, str(Path(__file__).parent))

import logging
import traceback

from db.connection import init_databases, close_databases, get_auth_db, get_houses_db, get_furniture_db
from routers import houses, rooms, furniture, files, meshy, enhance, admin, layouts, share, segmentation, feedback
from routers.auth import init_auth_secret
from routers import auth
from events import subscribe
from errors import log_exception

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_databases()
    init_auth_secret()
    meshy.start_polling()
    yield
    meshy.stop_polling()
    close_databases()

app = FastAPI(title="RoomDesigner API", lifespan=lifespan)

# Rate limiting
from routers.auth import limiter
app.state.limiter = limiter

@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Please try again later."}
    )

# CORS: derive allowed origin from SERVER_BASE_URL
_server_url = os.environ.get("SERVER_BASE_URL", "")
if _server_url:
    from urllib.parse import urlparse
    _parsed = urlparse(_server_url)
    cors_origins = [f"{_parsed.scheme}://{_parsed.netloc}"]
else:
    cors_origins = []

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if os.environ.get("SERVER_BASE_URL", "").startswith("https"):
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.middleware("http")
async def global_error_logging(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as e:
        log_exception(e, "unhandled", endpoint=f"{request.method} {request.url.path}")
        raise


@app.get("/health")
async def health_check():
    """Health check endpoint for monitoring."""
    status = {"server": "ok", "databases": {}, "r2": "unknown"}
    for name, get_db in [("auth", get_auth_db), ("houses", get_houses_db), ("furniture", get_furniture_db)]:
        try:
            get_db().execute("SELECT 1")
            status["databases"][name] = "ok"
        except Exception:
            status["databases"][name] = "error"
    try:
        import r2 as r2_module
        r2_module.get_client()
        status["r2"] = "ok"
    except Exception:
        status["r2"] = "error"
    from circuit_breaker import moge_breaker, gemini_breaker, trellis_breaker, sam3_breaker
    status["circuit_breakers"] = {
        b.service_name: b.get_status()
        for b in [moge_breaker, gemini_breaker, trellis_breaker, sam3_breaker]
    }
    all_ok = all(v == "ok" for v in status["databases"].values()) and status["r2"] == "ok"
    return {"status": "ok" if all_ok else "degraded", "services": status}


# Auth routes (no auth required)
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])

# Protected API routes
app.include_router(houses.router, prefix="/api/houses", tags=["houses"])
app.include_router(rooms.router, prefix="/api/rooms", tags=["rooms"])
app.include_router(layouts.router, prefix="/api", tags=["layouts"])
app.include_router(furniture.router, prefix="/api/furniture", tags=["furniture"])
app.include_router(files.router, prefix="/api/files", tags=["files"])
app.include_router(meshy.router, prefix="/api/meshy", tags=["meshy"])
app.include_router(enhance.router, prefix="/api/enhance", tags=["enhance"])
app.include_router(admin.router, prefix="/api/admin", tags=["admin"])
app.include_router(segmentation.router, prefix="/api/segmentation", tags=["segmentation"])
app.include_router(feedback.router, prefix="/api/feedback", tags=["feedback"])

# Share routes (public page + protected management, no prefix — handles /share/{token} and /api/share/{token})
app.include_router(share.router, tags=["share"])


@app.get("/api/events")
async def sse_events():
    """Server-Sent Events endpoint for real-time notifications."""
    return StreamingResponse(
        subscribe(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


# Serve frontend static files
FRONTEND_DIR = Path(__file__).parent.parent
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
