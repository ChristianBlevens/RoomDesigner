from pydantic import BaseModel
from typing import Optional
from datetime import date

class HouseCreate(BaseModel):
    id: Optional[str] = None
    name: str
    start_date: date
    end_date: date

class HouseUpdate(BaseModel):
    name: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None

class HouseResponse(BaseModel):
    id: str
    name: str
    startDate: str
    endDate: str
    createdAt: Optional[str] = None
