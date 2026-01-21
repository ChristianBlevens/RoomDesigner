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

class FurnitureUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    quantity: Optional[int] = None
    dimensionX: Optional[float] = None
    dimensionY: Optional[float] = None
    dimensionZ: Optional[float] = None

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
    thumbnailUrl: Optional[str] = None
    modelUrl: Optional[str] = None
