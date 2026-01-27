// House management for Room Furniture Planner

import {
  saveHouse as dbSaveHouse,
  getHouse as dbGetHouse,
  getAllHouses as dbGetAllHouses,
  deleteHouse as dbDeleteHouse,
  getRoomsByHouseId,
  deleteRoom
} from './api.js';

// Current house state
let currentHouse = null;

// Get current house
export function getCurrentHouse() {
  return currentHouse;
}

// Set current house
export function setCurrentHouse(house) {
  currentHouse = house;
}

// Validate house dates
export function validateHouseDates(startDate, endDate) {
  if (!startDate || !endDate) {
    return { valid: false, error: 'Both start and end dates are required' };
  }

  // Check valid ISO date format
  const startParsed = Date.parse(startDate);
  const endParsed = Date.parse(endDate);

  if (isNaN(startParsed)) {
    return { valid: false, error: 'Invalid start date' };
  }

  if (isNaN(endParsed)) {
    return { valid: false, error: 'Invalid end date' };
  }

  if (startDate > endDate) {
    return { valid: false, error: 'End date must be after start date' };
  }

  return { valid: true };
}

// Create a new house
export async function createHouse(name, startDate, endDate) {
  const validation = validateHouseDates(startDate, endDate);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const house = {
    name: name.trim(),
    startDate: startDate,
    endDate: endDate,
    createdAt: Date.now()
  };

  const id = await dbSaveHouse(house);
  return { ...house, id };
}

// Update an existing house
export async function updateHouse(id, updates) {
  const house = await dbGetHouse(id);
  if (!house) {
    throw new Error('House not found');
  }

  // If updating dates, validate them
  const newStartDate = updates.startDate !== undefined ? updates.startDate : house.startDate;
  const newEndDate = updates.endDate !== undefined ? updates.endDate : house.endDate;

  const validation = validateHouseDates(newStartDate, newEndDate);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const updatedHouse = {
    ...house,
    ...updates,
    startDate: newStartDate,
    endDate: newEndDate
  };

  await dbSaveHouse(updatedHouse);
  return updatedHouse;
}

// Delete house and all its rooms
export async function deleteHouseWithRooms(houseId) {
  // Get all rooms in this house
  const rooms = await getRoomsByHouseId(houseId);

  // Delete all rooms
  for (const room of rooms) {
    await deleteRoom(room.id);
  }

  // Delete the house
  await dbDeleteHouse(houseId);
}

// Get house by ID
export async function getHouseById(id) {
  return await dbGetHouse(id);
}

// Get room count for a house
export async function getHouseRoomCount(houseId) {
  const rooms = await getRoomsByHouseId(houseId);
  return rooms.length;
}

// Format date range for display
export function formatDateRange(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  const options = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString('en-US', options);
  const endStr = end.toLocaleDateString('en-US', options);

  // Add year if dates span different years or if not current year
  const currentYear = new Date().getFullYear();
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  if (startYear !== endYear) {
    return `${startStr}, ${startYear} - ${endStr}, ${endYear}`;
  } else if (startYear !== currentYear) {
    return `${startStr} - ${endStr}, ${startYear}`;
  }

  return `${startStr} - ${endStr}`;
}
