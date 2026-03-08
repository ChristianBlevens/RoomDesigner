import duckdb
import sys
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import HOUSES_DB, FURNITURE_DB, AUTH_DB

logger = logging.getLogger(__name__)

_houses_conn = None
_furniture_conn = None
_auth_conn = None


def _safe_connect(db_path: Path):
    """Connect to DuckDB, cleaning up corrupted WAL file if needed."""
    try:
        conn = duckdb.connect(str(db_path))
    except duckdb.InternalException as e:
        if "WAL file" in str(e):
            wal_path = Path(str(db_path) + ".wal")
            if wal_path.exists():
                logger.warning(f"Removing corrupted WAL file: {wal_path}")
                wal_path.unlink()
                conn = duckdb.connect(str(db_path))
            else:
                raise
        else:
            raise

    conn.execute("PRAGMA enable_checkpoint_on_shutdown")
    return conn


def init_databases():
    global _houses_conn, _furniture_conn, _auth_conn

    # Auth database
    _auth_conn = _safe_connect(AUTH_DB)
    _auth_conn.execute("""
        CREATE TABLE IF NOT EXISTS orgs (
            id VARCHAR PRIMARY KEY,
            username VARCHAR NOT NULL UNIQUE,
            password_hash VARCHAR NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    _auth_conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_username ON orgs(username)")
    _auth_conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key VARCHAR PRIMARY KEY,
            value VARCHAR NOT NULL
        )
    """)
    _auth_conn.execute("""
        CREATE TABLE IF NOT EXISTS revoked_tokens (
            jti VARCHAR PRIMARY KEY,
            revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Houses database
    _houses_conn = _safe_connect(HOUSES_DB)
    _houses_conn.execute("""
        CREATE TABLE IF NOT EXISTS houses (
            id VARCHAR PRIMARY KEY,
            org_id VARCHAR NOT NULL DEFAULT '',
            name VARCHAR NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    _houses_conn.execute("CREATE INDEX IF NOT EXISTS idx_houses_start_date ON houses(start_date)")
    _houses_conn.execute("CREATE INDEX IF NOT EXISTS idx_houses_org_id ON houses(org_id)")

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
            room_scale DOUBLE DEFAULT 1.0,
            meter_stick JSON,
            wall_colors JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Migration: add wall_colors column if missing
    try:
        _houses_conn.execute("ALTER TABLE rooms ADD COLUMN wall_colors JSON")
    except Exception:
        pass

    _houses_conn.execute("CREATE INDEX IF NOT EXISTS idx_rooms_house_id ON rooms(house_id)")

    _houses_conn.execute("""
        CREATE TABLE IF NOT EXISTS layouts (
            id VARCHAR PRIMARY KEY,
            room_id VARCHAR NOT NULL,
            name VARCHAR NOT NULL,
            placed_furniture JSON,
            screenshot_path VARCHAR,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    _houses_conn.execute("CREATE INDEX IF NOT EXISTS idx_layouts_room_id ON layouts(room_id)")

    # Furniture database
    _furniture_conn = _safe_connect(FURNITURE_DB)
    _furniture_conn.execute("""
        CREATE TABLE IF NOT EXISTS furniture (
            id VARCHAR PRIMARY KEY,
            org_id VARCHAR NOT NULL DEFAULT '',
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
    _furniture_conn.execute("CREATE INDEX IF NOT EXISTS idx_furniture_org_id ON furniture(org_id)")

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

def get_auth_db():
    return _auth_conn

def get_houses_db():
    return _houses_conn

def get_furniture_db():
    return _furniture_conn

def close_databases():
    """Close database connections with explicit checkpoint."""
    global _houses_conn, _furniture_conn, _auth_conn
    for name, conn in [("Auth", _auth_conn), ("Houses", _houses_conn), ("Furniture", _furniture_conn)]:
        if conn:
            try:
                conn.execute("CHECKPOINT")
                logger.info(f"{name} database checkpointed successfully")
            except Exception as e:
                logger.warning(f"Failed to checkpoint {name} database: {e}")
            conn.close()
    logger.info("Databases closed")
