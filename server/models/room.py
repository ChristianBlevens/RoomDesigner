from pydantic import BaseModel
from typing import Optional, List, Any

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
    meshUrl: str
    cameraFov: float
    imageAspect: float

class LightingSettings(BaseModel):
    intensity: float
    position: Position
    target: Position
    temperature: float

class RoomCreate(BaseModel):
    id: Optional[str] = None
    houseId: str
    name: str
    placedFurniture: Optional[List[PlacedFurniture]] = []
    mogeData: Optional[MogeData] = None
    lightingSettings: Optional[LightingSettings] = None

class RoomUpdate(BaseModel):
    name: Optional[str] = None
    placedFurniture: Optional[List[PlacedFurniture]] = None
    mogeData: Optional[MogeData] = None
    lightingSettings: Optional[LightingSettings] = None

class RoomResponse(BaseModel):
    id: str
    houseId: str
    name: str
    backgroundImageUrl: Optional[str] = None
    placedFurniture: List[dict] = []
    mogeData: Optional[dict] = None
    lightingSettings: Optional[dict] = None
