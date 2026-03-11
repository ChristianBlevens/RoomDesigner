from pydantic import BaseModel
from typing import Optional, List

class FurnitureCreate(BaseModel):
    id: Optional[str] = None
    name: str
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    quantity: int = 1
    dimensionX: Optional[float] = None
    dimensionY: Optional[float] = None
    dimensionZ: Optional[float] = None
    location: Optional[str] = None
    condition: Optional[str] = None
    conditionNotes: Optional[str] = None

class FurnitureUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    quantity: Optional[int] = None
    dimensionX: Optional[float] = None
    dimensionY: Optional[float] = None
    dimensionZ: Optional[float] = None
    location: Optional[str] = None
    condition: Optional[str] = None
    conditionNotes: Optional[str] = None

class FurnitureResponse(BaseModel):
    id: str
    name: str
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    quantity: int = 1
    dimensionX: Optional[float] = None
    dimensionY: Optional[float] = None
    dimensionZ: Optional[float] = None
    imageUrl: Optional[str] = None
    preview3dUrl: Optional[str] = None
    modelUrl: Optional[str] = None
    location: Optional[str] = None
    condition: Optional[str] = None
    conditionNotes: Optional[str] = None


class ConflictDetail(BaseModel):
    houseId: str
    houseName: str
    startDate: str
    endDate: str
    count: int
    type: str  # "overlap" or "buffer"


class AvailabilityEntry(BaseModel):
    available: int
    total: int
    conflicts: List[ConflictDetail] = []
