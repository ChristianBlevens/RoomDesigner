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

from db.connection import init_databases, close_databases
from routers import houses, rooms, furniture, files, meshy, lbm
from routers.auth import init_auth_secret
from routers import auth
from events import subscribe

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

# CORS: restrict to configured origins (defaults to same-origin only)
cors_origins = os.environ.get("CORS_ORIGINS", "").split(",")
cors_origins = [o.strip() for o in cors_origins if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth routes (no auth required)
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])

# Protected API routes
app.include_router(houses.router, prefix="/api/houses", tags=["houses"])
app.include_router(rooms.router, prefix="/api/rooms", tags=["rooms"])
app.include_router(furniture.router, prefix="/api/furniture", tags=["furniture"])
app.include_router(files.router, prefix="/api/files", tags=["files"])
app.include_router(meshy.router, prefix="/api/meshy", tags=["meshy"])
app.include_router(lbm.router, prefix="/api/lbm", tags=["lbm"])


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
