from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pathlib import Path
import sys

# Add current directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from db.connection import init_databases, close_databases
from routers import houses, rooms, furniture, files

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_databases()
    yield
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

# Serve frontend static files
FRONTEND_DIR = Path(__file__).parent.parent
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
