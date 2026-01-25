from pydantic import BaseModel
from typing import Optional, List, Literal

class Position(BaseModel):
    x: float
    y: float
    z: float

class PlacedFurniture(BaseModel):
    entryId: str
    position: Position
    rotation: Position
    scale: Position

class MogeData(BaseModel):
    meshUrl: Optional[str] = None
    cameraFov: Optional[float] = None
    imageAspect: Optional[float] = None

class LightingSettings(BaseModel):
    intensity: float
    position: Position
    target: Position
    temperature: float

class RoomCreate(BaseModel):
    houseId: str
    name: str

class RoomUpdate(BaseModel):
    name: Optional[str] = None
    placedFurniture: Optional[List[PlacedFurniture]] = None
    mogeData: Optional[MogeData] = None
    lightingSettings: Optional[LightingSettings] = None

class RoomResponse(BaseModel):
    id: str
    houseId: str
    name: str
    status: Literal["processing", "ready", "failed"] = "ready"
    errorMessage: Optional[str] = None
    backgroundImageUrl: Optional[str] = None
    placedFurniture: List[dict] = []
    mogeData: Optional[dict] = None
    lightingSettings: Optional[dict] = None
