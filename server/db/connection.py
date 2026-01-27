import duckdb
import sys
import logging
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import HOUSES_DB, FURNITURE_DB

logger = logging.getLogger(__name__)

_houses_conn = None
_furniture_conn = None


def _safe_connect(db_path: Path):
    """Connect to DuckDB, cleaning up corrupted WAL file if needed."""
    try:
        return duckdb.connect(str(db_path))
    except duckdb.InternalException as e:
        if "WAL file" in str(e):
            wal_path = Path(str(db_path) + ".wal")
            if wal_path.exists():
                logger.warning(f"Removing corrupted WAL file: {wal_path}")
                wal_path.unlink()
                return duckdb.connect(str(db_path))
        raise


def init_databases():
    global _houses_conn, _furniture_conn

    # Houses database
    _houses_conn = _safe_connect(HOUSES_DB)
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
            status VARCHAR DEFAULT 'ready',
            error_message VARCHAR,
            background_image_path VARCHAR,
            placed_furniture JSON,
            moge_data JSON,
            lighting_settings JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Migration: add status column if it doesn't exist (for existing databases)
    try:
        _houses_conn.execute("SELECT status FROM rooms LIMIT 1")
    except Exception:
        _houses_conn.execute("ALTER TABLE rooms ADD COLUMN status VARCHAR DEFAULT 'ready'")
        _houses_conn.execute("ALTER TABLE rooms ADD COLUMN error_message VARCHAR")
    _houses_conn.execute("CREATE INDEX IF NOT EXISTS idx_rooms_house_id ON rooms(house_id)")

    # Furniture database
    _furniture_conn = _safe_connect(FURNITURE_DB)
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
            preview_3d_path VARCHAR,
            model_path VARCHAR,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    _furniture_conn.execute("CREATE INDEX IF NOT EXISTS idx_furniture_category ON furniture(category)")

    # Meshy generation tasks table
    _furniture_conn.execute("""
        CREATE TABLE IF NOT EXISTS meshy_tasks (
            id VARCHAR PRIMARY KEY,
            furniture_id VARCHAR NOT NULL,
            meshy_task_id VARCHAR,
            status VARCHAR DEFAULT 'pending',
            progress INTEGER DEFAULT 0,
            retry_count INTEGER DEFAULT 0,
            error_message VARCHAR,
            glb_url VARCHAR,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    _furniture_conn.execute("CREATE INDEX IF NOT EXISTS idx_meshy_tasks_status ON meshy_tasks(status)")
    _furniture_conn.execute("CREATE INDEX IF NOT EXISTS idx_meshy_tasks_furniture ON meshy_tasks(furniture_id)")

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
