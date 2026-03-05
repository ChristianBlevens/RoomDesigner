from pathlib import Path

# Base paths
SERVER_DIR = Path(__file__).parent
DATA_DIR = SERVER_DIR / "data"

# Database paths
AUTH_DB = DATA_DIR / "auth.db"
HOUSES_DB = DATA_DIR / "houses.db"
FURNITURE_DB = DATA_DIR / "furniture.db"

# Create database directory
DATA_DIR.mkdir(parents=True, exist_ok=True)
