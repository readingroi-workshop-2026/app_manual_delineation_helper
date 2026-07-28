"""Readers for FreeSurfer .label files and GIFTI (.func.gii) overlays."""

from __future__ import annotations

from pathlib import Path

import numpy as np


def read_label_vertices(path: Path) -> list[int]:
    """Vertex indices of a FreeSurfer .label file (skips the 2-line header)."""
    vertices: list[int] = []
    with Path(path).open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f):
            if line_no < 2 or not line.strip():
                continue
            vertices.append(int(line.split()[0]))
    return vertices


def load_gifti_values(path: Path) -> np.ndarray:
    """Concatenated data of a .func.gii overlay as a 1-D array."""
    import nibabel as nib

    img = nib.load(str(path))
    arrays = [np.asarray(d.data).reshape(-1) for d in img.darrays]
    if not arrays:
        raise ValueError(f"No data arrays in {path}")
    return arrays[0] if len(arrays) == 1 else np.concatenate(arrays)
