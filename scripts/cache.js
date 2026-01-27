// Cache Manager for RoomDesigner
// Provides in-memory caching with TTL and invalidation

// Cache stores
const metadataCache = new Map();
const binaryCache = new Map();
const derivedCache = new Map();

// Cache configuration (TTL in milliseconds)
const CACHE_CONFIG = {
  categories: { ttl: 5 * 60 * 1000 },      // 5 minutes
  tags: { ttl: 5 * 60 * 1000 },            // 5 minutes
  furnitureList: { ttl: 2 * 60 * 1000 },   // 2 minutes
  furnitureEntry: { ttl: 5 * 60 * 1000 },  // 5 minutes
  houses: { ttl: 5 * 60 * 1000 },          // 5 minutes
  roomsByHouse: { ttl: 2 * 60 * 1000 },    // 2 minutes
  availability: { ttl: 30 * 1000 },        // 30 seconds (computed)
};

// Version tracking for invalidation
let cacheVersion = {
  furniture: 0,
  houses: 0,
  rooms: 0,
};

/**
 * Get item from cache if valid
 * @param {string} key - Cache key
 * @param {string} type - Cache type (metadata, binary, derived)
 * @returns {any|null} Cached value or null if expired/missing
 */
export function getCached(key, type = 'metadata') {
  const cache = type === 'binary' ? binaryCache :
                type === 'derived' ? derivedCache : metadataCache;

  const entry = cache.get(key);
  if (!entry) return null;

  const now = Date.now();
  if (entry.expiresAt && now > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

/**
 * Set item in cache
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {string} type - Cache type
 * @param {number} ttl - Time to live in ms (optional, uses config default)
 */
export function setCached(key, value, type = 'metadata', ttl = null) {
  const cache = type === 'binary' ? binaryCache :
                type === 'derived' ? derivedCache : metadataCache;

  // Determine TTL from config or parameter
  const configKey = key.split(':')[0];
  const configTtl = CACHE_CONFIG[configKey]?.ttl;
  const finalTtl = ttl ?? configTtl ?? 60000;

  cache.set(key, {
    value,
    cachedAt: Date.now(),
    expiresAt: Date.now() + finalTtl,
  });
}

/**
 * Invalidate cache entries by pattern
 * @param {string} pattern - Key pattern to invalidate ('furniture', 'furniture:xyz', etc.)
 */
export function invalidateCache(pattern) {
  for (const cache of [metadataCache, derivedCache]) {
    for (const key of cache.keys()) {
      if (key === pattern || key.startsWith(pattern + ':')) {
        cache.delete(key);
      }
    }
  }

  // Bump version for pattern type
  const type = pattern.split(':')[0];
  if (cacheVersion.hasOwnProperty(type)) {
    cacheVersion[type]++;
  }
}

/**
 * Invalidate all furniture-related caches
 * Called when furniture entry is created, updated, or deleted
 */
export function invalidateFurnitureCache() {
  invalidateCache('furnitureList');
  invalidateCache('furnitureEntry');
  invalidateCache('categories');
  invalidateCache('tags');
  invalidateCache('availability');
  cacheVersion.furniture++;
}

/**
 * Invalidate all house-related caches
 */
export function invalidateHouseCache() {
  invalidateCache('houses');
  cacheVersion.houses++;
}

/**
 * Invalidate room caches for a specific house
 */
export function invalidateRoomCache(houseId = null) {
  if (houseId) {
    invalidateCache(`roomsByHouse:${houseId}`);
  } else {
    invalidateCache('roomsByHouse');
  }
  invalidateCache('availability');
  cacheVersion.rooms++;
}

/**
 * Get current cache version for a type
 */
export function getCacheVersion(type) {
  return cacheVersion[type] || 0;
}

/**
 * Clear all caches (for logout, session end, etc.)
 */
export function clearAllCaches() {
  metadataCache.clear();
  binaryCache.clear();
  derivedCache.clear();
  cacheVersion = { furniture: 0, houses: 0, rooms: 0 };
}

/**
 * Get cache statistics (for debugging)
 */
export function getCacheStats() {
  return {
    metadata: metadataCache.size,
    binary: binaryCache.size,
    derived: derivedCache.size,
    version: { ...cacheVersion },
  };
}
