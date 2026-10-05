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


def write_label(path: Path, vertices, coords: np.ndarray, comment: str = "") -> int:
    """Write a FreeSurfer ASCII label; xyz of each vertex are taken from ``coords``.

    Returns the number of (unique) vertices written.
    """
    verts = np.unique(np.asarray(vertices, dtype=np.int64))
    if verts.size and (verts[0] < 0 or verts[-1] >= len(coords)):
        raise ValueError(f"vertex index out of range 0..{len(coords) - 1}")
    rows = [f"#!ascii label {comment}".rstrip(), str(verts.size)]
    for v in verts:
        x, y, z = coords[v]
        rows.append(f"{v}  {x:.3f}  {y:.3f}  {z:.3f} 0.0000000000")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(rows) + "\n")
    return int(verts.size)
