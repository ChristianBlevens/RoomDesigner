from pydantic import BaseModel
from typing import Optional, List


class LayoutCreate(BaseModel):
    name: str
    placedFurniture: List[dict] = []
    screenshot: Optional[str] = None


class LayoutResponse(BaseModel):
    id: str
    roomId: str
    name: str
    placedFurniture: List[dict] = []
    screenshotUrl: Optional[str] = None
    createdAt: Optional[str] = None
