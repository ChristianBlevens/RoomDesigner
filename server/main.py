from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager
from pathlib import Path
import sys

# Add current directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from db.connection import init_databases, close_databases
from routers import houses, rooms, furniture, files, meshy, lbm
from events import subscribe

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_databases()
    meshy.start_polling()
    yield
    meshy.stop_polling()
    close_databases()

app = FastAPI(title="RoomDesigner API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
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
