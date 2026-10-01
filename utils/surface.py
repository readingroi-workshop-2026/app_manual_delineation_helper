"""Surface geometry: load a subject's FreeSurfer surfaces and curvature.

The browser does all the viewing (camera, lighting, overlays); this module only
reads the files. Inflated and pial of one hemisphere share vertex indices, which
is what lets every overlay and label be drawn on both at once.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import numpy as np

from .config import fs_subject_dir, normalize_hemi, normalize_sub


def surf_path(config: dict, sub: str, hemi: str, name: str) -> Path:
    """<fs_dir>/<sub>/surf/<hemi>.<name>, e.g. name='inflated', 'pial', 'curv'."""
    hemi_fs, _ = normalize_hemi(hemi)
    return fs_subject_dir(config, normalize_sub(sub)) / "surf" / f"{hemi_fs}.{name}"


@lru_cache(maxsize=16)
def _geometry(path: str, mtime: float) -> tuple[np.ndarray, np.ndarray]:
    import nibabel as nib

    coords, faces = nib.freesurfer.io.read_geometry(path)
    return np.asarray(coords, dtype=np.float32), np.asarray(faces, dtype=np.int32)


def load_geometry(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """(coords float32 N x 3, faces int32 F x 3); cached until the file changes."""
    path = Path(path)
    return _geometry(str(path), path.stat().st_mtime)


def load_curv(path: Path) -> np.ndarray:
    import nibabel as nib

    return np.asarray(nib.freesurfer.io.read_morph_data(str(path)), dtype=np.float32)
