"""
MoGe-2 mesh optimization for room geometry.
Applies edge-preserving decimation and angle-threshold normal smoothing.
"""

import io
import logging
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# Target face count for room meshes (sufficient for raycasting)
TARGET_FACES = 15000

# Angle threshold in degrees - edges sharper than this are preserved
# 60° preserves wall/floor corners (90°) while smoothing flat surfaces
FEATURE_ANGLE_THRESHOLD = 60.0

# Smoothing iterations for flat surfaces
SMOOTHING_ITERATIONS = 2


def optimize_room_mesh(glb_data: bytes) -> bytes:
    """
    Optimize a MoGe-2 room mesh for furniture placement.

    Applies:
    1. Edge-preserving decimation to reduce geometry
    2. Angle-threshold normal smoothing to remove noise while keeping sharp edges

    Args:
        glb_data: Raw GLB bytes from MoGe-2

    Returns:
        Optimized GLB bytes
    """
    import pymeshlab

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / "input.glb"
        output_path = Path(tmpdir) / "output.glb"

        input_path.write_bytes(glb_data)

        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(str(input_path))

        original_faces = ms.current_mesh().face_number()
        logger.info(f"MoGe mesh original faces: {original_faces}")

        # Step 1: Edge-preserving decimation
        if original_faces > TARGET_FACES:
            ms.meshing_decimation_quadric_edge_collapse(
                targetfacenum=TARGET_FACES,
                qualitythr=0.5,
                preserveboundary=True,
                boundaryweight=1.0,
                preservenormal=True,
                preservetopology=True,
                optimalplacement=True,
                planarquadric=True
            )
            logger.info(f"Decimated to {ms.current_mesh().face_number()} faces")

        # Step 2: Recompute face normals (clean baseline)
        ms.compute_normal_for_polygon_mesh_per_face()

        # Step 3: Angle-threshold normal smoothing
        # Only smooths normals between faces within the angle threshold
        # Faces at greater angles (like wall/floor corners) keep distinct normals
        ms.apply_coord_two_steps_smoothing(
            stepsmoothnum=SMOOTHING_ITERATIONS,
            normalthr=FEATURE_ANGLE_THRESHOLD,
            stepnormalnum=SMOOTHING_ITERATIONS,
            selected=False
        )

        # Step 4: Recompute vertex normals with angle weighting
        # This propagates the smoothed geometry to vertex normals
        ms.compute_normal_for_polygon_mesh_per_vertex()

        logger.info(f"Applied normal smoothing with {FEATURE_ANGLE_THRESHOLD}° threshold")

        ms.save_current_mesh(str(output_path))

        return output_path.read_bytes()


def get_mesh_stats(glb_data: bytes) -> dict:
    """Get face/vertex counts for a mesh (for logging/debugging)."""
    import pymeshlab

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / "input.glb"
        input_path.write_bytes(glb_data)

        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(str(input_path))
        mesh = ms.current_mesh()

        return {
            'faces': mesh.face_number(),
            'vertices': mesh.vertex_number()
        }
