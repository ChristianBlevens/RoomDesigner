"""
Server-side 3D model processing for bounding box correction and thumbnail generation.
Uses trimesh to process GLB files before storage.

Thumbnail generation is designed to run async in background tasks.
Concurrency is limited to 1 to avoid overloading a 2 vCPU server.
"""

import asyncio
import io
import logging
from pathlib import Path
from typing import Optional, Tuple
import zipfile

import numpy as np
import trimesh

logger = logging.getLogger(__name__)

# Semaphore to limit concurrent thumbnail renders (1 for 2 vCPU server)
_thumbnail_semaphore = asyncio.Semaphore(1)


class ModelProcessor:
    """
    Process 3D models to fix bounding boxes, recenter origins, and generate thumbnails.

    Designed for compatibility with Three.js:
    - Preserves GLTF/GLB Y-up coordinate system
    - Exports standard GLB that Three.js can load directly
    - Origin placement matches Three.js expectations
    """

    def process_glb(
        self,
        glb_data: bytes,
        origin_placement: str = 'bottom-center',
        generate_thumbnail: bool = True,
        thumbnail_size: Tuple[int, int] = (256, 256)
    ) -> dict:
        """
        Process a GLB file: fix bounds, recenter origin, generate thumbnail.

        Args:
            glb_data: Raw GLB file bytes
            origin_placement: Where to place origin - 'bottom-center', 'center', or 'original'
            generate_thumbnail: Whether to generate a thumbnail image
            thumbnail_size: Thumbnail dimensions (width, height)

        Returns:
            dict with:
                - 'glb': Processed GLB bytes
                - 'thumbnail': PNG thumbnail bytes (if generate_thumbnail=True)
                - 'bounds': Dict with min, max, center, size vectors
                - 'original_bounds': Original bounds before processing
        """
        # Load the GLB file
        scene = trimesh.load(
            io.BytesIO(glb_data),
            file_type='glb',
            force='scene'  # Always load as scene (handles multi-mesh models)
        )

        if scene.is_empty:
            raise ValueError("Model contains no geometry")

        # Compute original bounds
        original_bounds = self._compute_bounds(scene)
        logger.info(f"Original bounds: center={original_bounds['center']}, size={original_bounds['size']}")

        # Recenter geometry if requested
        if origin_placement != 'original':
            self._recenter_scene(scene, original_bounds, origin_placement)

        # Compute new bounds after recentering
        new_bounds = self._compute_bounds(scene)
        logger.info(f"Processed bounds: center={new_bounds['center']}, size={new_bounds['size']}")

        # Generate thumbnail
        thumbnail_bytes = None
        if generate_thumbnail:
            thumbnail_bytes = self._generate_thumbnail(scene, thumbnail_size)

        # Export processed GLB
        processed_glb = self._export_glb(scene)

        return {
            'glb': processed_glb,
            'thumbnail': thumbnail_bytes,
            'bounds': new_bounds,
            'original_bounds': original_bounds
        }

    def _compute_bounds(self, scene: trimesh.Scene) -> dict:
        """
        Compute bounding box from scene geometry.

        Returns dict with numpy arrays for min, max, center, size.
        """
        # Get the overall bounding box of the scene
        bounds = scene.bounds  # Shape: (2, 3) - [[min_x, min_y, min_z], [max_x, max_y, max_z]]

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
        """
        Recenter all geometry in the scene so origin is at specified placement.
        Modifies scene in place.

        Args:
            scene: trimesh.Scene to modify
            bounds: Current bounds dict
            placement: 'bottom-center' or 'center'
        """
        center = np.array(bounds['center'])
        min_pt = np.array(bounds['min'])

        if placement == 'bottom-center':
            # Move origin to bottom-center (center X/Z, bottom Y)
            # After transform: min_y = 0, center_x = 0, center_z = 0
            offset = np.array([
                -center[0],      # Center X at 0
                -min_pt[1],      # Bottom Y at 0
                -center[2]       # Center Z at 0
            ])
        elif placement == 'center':
            # Move origin to geometric center
            offset = -center
        else:
            return  # Unknown placement, don't modify

        # Apply translation to the entire scene
        # This translates all geometry in the scene
        translation_matrix = trimesh.transformations.translation_matrix(offset)
        scene.apply_transform(translation_matrix)

        logger.info(f"Applied translation offset: {offset.tolist()}")

    def _generate_thumbnail(
        self,
        scene: trimesh.Scene,
        size: Tuple[int, int]
    ) -> Optional[bytes]:
        """
        Generate a thumbnail image of the scene.

        Uses trimesh's built-in rendering which requires pyglet.
        Falls back gracefully if rendering is not available.
        """
        try:
            # Use trimesh's scene rendering
            # This requires a display or virtual framebuffer
            png_data = scene.save_image(resolution=size, visible=False)

            if png_data is not None:
                return png_data

        except Exception as e:
            logger.warning(f"Thumbnail generation failed (may need display): {e}")

        # Fallback: try with pyrender if available
        try:
            return self._generate_thumbnail_pyrender(scene, size)
        except ImportError:
            logger.warning("pyrender not available for fallback thumbnail generation")
        except Exception as e:
            logger.warning(f"pyrender thumbnail generation failed: {e}")

        return None

    def _generate_thumbnail_pyrender(
        self,
        scene: trimesh.Scene,
        size: Tuple[int, int]
    ) -> bytes:
        """
        Generate thumbnail using pyrender (works in headless mode with OSMesa).
        """
        import pyrender
        from PIL import Image

        # Create pyrender scene
        pr_scene = pyrender.Scene(ambient_light=[0.3, 0.3, 0.3])

        # Add meshes from trimesh scene
        for name, geometry in scene.geometry.items():
            if isinstance(geometry, trimesh.Trimesh):
                mesh = pyrender.Mesh.from_trimesh(geometry)
                pr_scene.add(mesh)

        # Set up camera to view entire scene
        bounds = scene.bounds
        center = (bounds[0] + bounds[1]) / 2
        size_vec = bounds[1] - bounds[0]
        max_dim = max(size_vec)

        # Position camera to see entire model
        camera_distance = max_dim * 2.0
        camera = pyrender.PerspectiveCamera(yfov=np.pi / 4.0)
        camera_pose = np.eye(4)
        camera_pose[:3, 3] = center + np.array([camera_distance * 0.7, camera_distance * 0.5, camera_distance * 0.7])
        # Look at center
        camera_pose[:3, :3] = self._look_at_rotation(camera_pose[:3, 3], center, np.array([0, 1, 0]))
        pr_scene.add(camera, pose=camera_pose)

        # Add light
        light = pyrender.DirectionalLight(color=[1.0, 1.0, 1.0], intensity=3.0)
        pr_scene.add(light, pose=camera_pose)

        # Render
        renderer = pyrender.OffscreenRenderer(size[0], size[1])
        color, _ = renderer.render(pr_scene)
        renderer.delete()

        # Convert to PNG
        img = Image.fromarray(color)
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        return buffer.getvalue()

    def _look_at_rotation(self, eye: np.ndarray, target: np.ndarray, up: np.ndarray) -> np.ndarray:
        """Compute rotation matrix for camera looking at target."""
        forward = target - eye
        forward = forward / np.linalg.norm(forward)
        right = np.cross(forward, up)
        right = right / np.linalg.norm(right)
        actual_up = np.cross(right, forward)

        rotation = np.eye(3)
        rotation[0, :] = right
        rotation[1, :] = actual_up
        rotation[2, :] = -forward
        return rotation.T

    def _export_glb(self, scene: trimesh.Scene) -> bytes:
        """
        Export scene to GLB bytes.
        """
        return scene.export(file_type='glb')


def process_model_file(
    input_path: Path,
    output_path: Path,
    thumbnail_path: Optional[Path] = None,
    origin_placement: str = 'bottom-center'
) -> dict:
    """
    Convenience function to process a model file on disk.

    Args:
        input_path: Path to input GLB or ZIP containing GLB
        output_path: Path to save processed GLB (or ZIP)
        thumbnail_path: Optional path to save thumbnail PNG
        origin_placement: Origin placement mode

    Returns:
        Processing result dict with bounds info
    """
    processor = ModelProcessor()

    # Read input
    input_bytes = input_path.read_bytes()

    # Handle ZIP-wrapped GLB
    is_zip = input_path.suffix.lower() == '.zip'
    if is_zip:
        with zipfile.ZipFile(io.BytesIO(input_bytes)) as zf:
            # Find GLB file in ZIP
            glb_name = None
            for name in zf.namelist():
                if name.lower().endswith('.glb'):
                    glb_name = name
                    break

            if not glb_name:
                raise ValueError("No GLB file found in ZIP")

            glb_data = zf.read(glb_name)
    else:
        glb_data = input_bytes

    # Process
    result = processor.process_glb(
        glb_data,
        origin_placement=origin_placement,
        generate_thumbnail=thumbnail_path is not None
    )

    # Save processed model
    if is_zip:
        # Wrap back in ZIP for consistency
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('model.glb', result['glb'])
        output_path.write_bytes(zip_buffer.getvalue())
    else:
        output_path.write_bytes(result['glb'])

    # Save thumbnail
    if thumbnail_path and result['thumbnail']:
        thumbnail_path.write_bytes(result['thumbnail'])

    return {
        'bounds': result['bounds'],
        'original_bounds': result['original_bounds'],
        'thumbnail_generated': result['thumbnail'] is not None
    }


async def generate_thumbnail_async(
    model_path: Path,
    thumbnail_path: Path,
    furniture_id: str
):
    """
    Generate thumbnail asynchronously in background.
    Uses semaphore to limit concurrent renders (protects 2 vCPU server).

    Args:
        model_path: Path to the model ZIP file
        thumbnail_path: Path to save thumbnail PNG
        furniture_id: ID of the furniture entry for database update
    """
    async with _thumbnail_semaphore:
        try:
            # Run CPU-intensive work in thread pool
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                _generate_thumbnail_sync,
                model_path,
                thumbnail_path
            )

            logger.info(f"Thumbnail generated: {thumbnail_path}")

            # Update database
            from db.connection import get_furniture_db
            conn = get_furniture_db()
            conn.execute(
                "UPDATE furniture SET thumbnail_path = ? WHERE id = ?",
                [str(thumbnail_path), furniture_id]
            )

        except Exception as e:
            logger.error(f"Async thumbnail generation failed: {e}")


def _generate_thumbnail_sync(model_path: Path, thumbnail_path: Path):
    """Synchronous thumbnail generation (runs in thread pool)."""
    processor = ModelProcessor()

    # Read model from ZIP
    with zipfile.ZipFile(model_path) as zf:
        glb_name = None
        for name in zf.namelist():
            if name.lower().endswith('.glb'):
                glb_name = name
                break

        if not glb_name:
            raise ValueError("No GLB file found in ZIP")

        glb_data = zf.read(glb_name)

    # Load scene and generate thumbnail only
    scene = trimesh.load(
        io.BytesIO(glb_data),
        file_type='glb',
        force='scene'
    )

    thumbnail_data = processor._generate_thumbnail(scene, (256, 256))

    if thumbnail_data:
        thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
        thumbnail_path.write_bytes(thumbnail_data)
    else:
        raise RuntimeError("Thumbnail generation returned no data")
