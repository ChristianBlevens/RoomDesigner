import duckdb
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import HOUSES_DB, FURNITURE_DB

_houses_conn = None
_furniture_conn = None

def init_databases():
    global _houses_conn, _furniture_conn

    # Houses database
    _houses_conn = duckdb.connect(str(HOUSES_DB))
    _houses_conn.execute("""
        CREATE TABLE IF NOT EXISTS houses (
            id VARCHAR PRIMARY KEY,
            name VARCHAR NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    _houses_conn.execute("CREATE INDEX IF NOT EXISTS idx_houses_start_date ON houses(start_date)")

    _houses_conn.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            id VARCHAR PRIMARY KEY,
            house_id VARCHAR NOT NULL,
            name VARCHAR NOT NULL,
            background_image_path VARCHAR,
            placed_furniture JSON,
            moge_data JSON,
            lighting_settings JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    _houses_conn.execute("CREATE INDEX IF NOT EXISTS idx_rooms_house_id ON rooms(house_id)")

    # Furniture database
    _furniture_conn = duckdb.connect(str(FURNITURE_DB))
    _furniture_conn.execute("""
        CREATE TABLE IF NOT EXISTS furniture (
            id VARCHAR PRIMARY KEY,
            name VARCHAR NOT NULL,
            category VARCHAR,
            tags JSON,
            quantity INTEGER DEFAULT 1,
            dimension_x DOUBLE,
            dimension_y DOUBLE,
            dimension_z DOUBLE,
            image_path VARCHAR,
            thumbnail_path VARCHAR,
            model_path VARCHAR,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    _furniture_conn.execute("CREATE INDEX IF NOT EXISTS idx_furniture_category ON furniture(category)")

def get_houses_db():
    return _houses_conn

def get_furniture_db():
    return _furniture_conn

def close_databases():
    global _houses_conn, _furniture_conn
    if _houses_conn:
        _houses_conn.close()
    if _furniture_conn:
        _furniture_conn.close()
