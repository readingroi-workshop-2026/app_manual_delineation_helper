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


# ---------------------------------------------------------------- T1w space
# FreeSurfer surfaces are stored in tkr (surface) RAS. To place a vertex in the
# T1w: scanner RAS = Norig @ inv(Torig) @ tkr, both from a conformed volume's
# header (mri/orig.mgz), then T1 voxel = inv(T1 vox2ras) @ scanner. Without any
# mri/ volume, the c_ras stored in the surface file gives the same translation.
@lru_cache(maxsize=16)
def _mgh_header(path: str, mtime: float) -> tuple[np.ndarray, np.ndarray]:
    import nibabel as nib

    h = nib.load(path).header
    return np.asarray(h.get_vox2ras(), float), np.asarray(h.get_vox2ras_tkr(), float)


def mgh_header(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """(vox2ras, vox2ras_tkr) of an .mgz/.mgh header; cached until the file changes."""
    path = Path(path)
    return _mgh_header(str(path), path.stat().st_mtime)


def tkr_to_scanner(subject_dir: Path, surf: Path | None = None) -> tuple[np.ndarray, str]:
    """4x4 tkr RAS -> scanner RAS, and where it came from."""
    for name in ("orig.mgz", "T1.mgz", "brain.mgz", "norm.mgz"):
        p = Path(subject_dir) / "mri" / name
        if p.is_file():
            v2r, tkr = mgh_header(p)
            return v2r @ np.linalg.inv(tkr), f"mri/{name}"
    if surf is not None and Path(surf).is_file():
        import nibabel.freesurfer as nfs

        *_, meta = nfs.read_geometry(str(surf), read_metadata=True)
        if "cras" in meta:
            m = np.eye(4)
            m[:3, 3] = meta["cras"]
            return m, f"c_ras of {Path(surf).name}"
    return np.eye(4), "none (no mri/orig.mgz, no c_ras: tkr shown as scanner)"


def voxel_affines(path: Path) -> tuple[np.ndarray, np.ndarray, str]:
    """(file vox2ras, x-y-z ordered vox2ras, file axis codes) of a volume.

    A conformed .mgz is stored LIA: its voxel [a, b, c] runs R->L, S->I, P->A,
    i.e. (x, z, y) and flipped. The second affine indexes the same voxels in
    R, A, S order, so voxel coordinates read as x, y, z (RAS+ canonical)."""
    import nibabel as nib
    from nibabel.orientations import aff2axcodes, inv_ornt_aff, io_orientation

    v2r = mgh_header(path)[0]
    shape = nib.load(str(path)).header.get_data_shape()[:3]
    canon = v2r @ inv_ornt_aff(io_orientation(v2r), shape)
    return v2r, canon, "".join(aff2axcodes(v2r))
