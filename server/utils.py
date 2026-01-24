from pathlib import Path

IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']


def cleanup_image_files(directory: Path, file_id: str):
    """Remove all image files for a given ID from a directory."""
    for ext in IMAGE_EXTENSIONS:
        (directory / f"{file_id}.{ext}").unlink(missing_ok=True)


def cleanup_entity_files(file_id: str, image_dirs: list, other_files: list = None):
    """Clean up all files associated with an entity.

    Args:
        file_id: The entity ID used in filenames
        image_dirs: List of Path directories containing image files
        other_files: List of specific Path objects to delete
    """
    for directory in image_dirs:
        cleanup_image_files(directory, file_id)
    if other_files:
        for path in other_files:
            path.unlink(missing_ok=True)
