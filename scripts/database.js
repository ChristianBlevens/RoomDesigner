// Database operations - now uses server API
// Re-export everything from api.js for backwards compatibility

export {
  openDatabase,
  // Houses
  getAllHouses,
  getHouse,
  saveHouse,
  deleteHouse,
  // Rooms
  getAllRooms,
  loadRoom,
  getRoomsByHouseId,
  getOrphanRooms,
  saveRoom,
  deleteRoom,
  // Furniture
  getAllFurniture,
  getFurnitureEntry,
  saveFurnitureEntry,
  deleteFurnitureEntry,
  getAllCategories,
  getAllTags
} from './api.js';
