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
    surfaceNormal: Optional[Position] = None
    contactAxis: Optional[Position] = None
    uprightRotation: Optional[float] = None
    rotationAroundNormal: Optional[float] = None
    baseScale: Optional[Position] = None
    parentIndex: Optional[int] = None
    localOffset: Optional[Position] = None
    localRotationY: Optional[float] = None

class MogeData(BaseModel):
    meshUrl: Optional[str] = None
    cameraFov: Optional[float] = None
    imageAspect: Optional[float] = None

class LightingSettings(BaseModel):
    intensity: float
    position: Position
    target: Position
    temperature: float
    shadowIntensity: Optional[float] = 0.5

class RoomCreate(BaseModel):
    houseId: str
    name: str

class RoomUpdate(BaseModel):
    name: Optional[str] = None
    placedFurniture: Optional[List[PlacedFurniture]] = None
    mogeData: Optional[MogeData] = None
    lightingSettings: Optional[LightingSettings] = None
    roomScale: Optional[float] = None
    meterStick: Optional[dict] = None

class RoomResponse(BaseModel):
    id: str
    houseId: str
    name: str
    status: Literal["processing", "ready", "failed"] = "ready"
    errorMessage: Optional[str] = None
    backgroundImageUrl: Optional[str] = None
    originalBackgroundUrl: Optional[str] = None
    finalImageUrl: Optional[str] = None
    placedFurniture: List[dict] = []
    mogeData: Optional[dict] = None
    lightingSettings: Optional[dict] = None
    roomScale: Optional[float] = None
    meterStick: Optional[dict] = None
    wallColors: Optional[dict] = None
