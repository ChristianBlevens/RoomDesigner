"""
Server-side 3D model processing for bounding box correction and origin recentering.
Uses trimesh to process GLB files before storage.
"""

import io
import logging
from typing import Tuple

import numpy as np
import trimesh

logger = logging.getLogger(__name__)


class ModelProcessor:
    """
    Process 3D models to fix bounding boxes and recenter origins.

    Designed for compatibility with Three.js:
    - Preserves GLTF/GLB Y-up coordinate system
    - Exports standard GLB that Three.js can load directly
    - Origin placement matches Three.js expectations
    """

    def process_glb(
        self,
        glb_data: bytes,
        origin_placement: str = 'bottom-center',
        generate_preview: bool = False,
        preview_size: Tuple[int, int] = (256, 256)
    ) -> dict:
        """
        Process a GLB file: fix bounds and recenter origin.

        Args:
            glb_data: Raw GLB file bytes
            origin_placement: Where to place origin - 'bottom-center', 'center', or 'original'
            generate_preview: Unused, kept for API compatibility
            preview_size: Unused, kept for API compatibility

        Returns:
            dict with:
                - 'glb': Processed GLB bytes
                - 'preview': Always None
                - 'bounds': Dict with min, max, center, size vectors
                - 'original_bounds': Original bounds before processing
        """
        scene = trimesh.load(
            io.BytesIO(glb_data),
            file_type='glb',
            force='scene'
        )

        if scene.is_empty:
            raise ValueError("Model contains no geometry")

        original_bounds = self._compute_bounds(scene)
        logger.info(f"Original bounds: center={original_bounds['center']}, size={original_bounds['size']}")

        if origin_placement != 'original':
            self._recenter_scene(scene, original_bounds, origin_placement)

        new_bounds = self._compute_bounds(scene)
        logger.info(f"Processed bounds: center={new_bounds['center']}, size={new_bounds['size']}")

        processed_glb = scene.export(file_type='glb')

        return {
            'glb': processed_glb,
            'preview': None,
            'bounds': new_bounds,
            'original_bounds': original_bounds
        }

    def _compute_bounds(self, scene: trimesh.Scene) -> dict:
        """Compute bounding box from scene geometry."""
        bounds = scene.bounds
        if bounds is None:
            raise ValueError("Scene has no bounds (empty geometry)")

        min_pt = bounds[0]
        max_pt = bounds[1]
        center = (min_pt + max_pt) / 2
        size = max_pt - min_pt

        return {
            'min': min_pt.tolist(),
            'max': max_pt.tolist(),
            'center': center.tolist(),
            'size': size.tolist()
        }

    def _recenter_scene(self, scene: trimesh.Scene, bounds: dict, placement: str):
        """Recenter all geometry so origin is at specified placement."""
        center = np.array(bounds['center'])
        min_pt = np.array(bounds['min'])

        if placement == 'bottom-center':
            offset = np.array([
                -center[0],
                -min_pt[1],
                -center[2]
            ])
        elif placement == 'center':
            offset = -center
        else:
            return

        translation_matrix = trimesh.transformations.translation_matrix(offset)
        scene.apply_transform(translation_matrix)
        logger.info(f"Applied translation offset: {offset.tolist()}")
