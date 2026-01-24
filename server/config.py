from pathlib import Path

# Base paths
SERVER_DIR = Path(__file__).parent
DATA_DIR = SERVER_DIR / "data"
STORAGE_DIR = SERVER_DIR / "storage"

# Database paths
HOUSES_DB = DATA_DIR / "houses.db"
FURNITURE_DB = DATA_DIR / "furniture.db"

# Storage paths
FURNITURE_IMAGES = STORAGE_DIR / "furniture" / "images"
FURNITURE_PREVIEWS_3D = STORAGE_DIR / "furniture" / "previews_3d"
FURNITURE_MODELS = STORAGE_DIR / "furniture" / "models"
ROOM_BACKGROUNDS = STORAGE_DIR / "rooms" / "backgrounds"
ROOM_MESHES = STORAGE_DIR / "rooms" / "meshes"

# Create directories
for path in [DATA_DIR, FURNITURE_IMAGES, FURNITURE_PREVIEWS_3D,
             FURNITURE_MODELS, ROOM_BACKGROUNDS, ROOM_MESHES]:
    path.mkdir(parents=True, exist_ok=True)
