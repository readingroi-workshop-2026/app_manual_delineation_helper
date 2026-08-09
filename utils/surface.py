"""Surface geometry: load inflated/pial meshes, apply the camera view, normals."""

from __future__ import annotations

import numpy as np

from .config import fs_subject_dir, normalize_hemi, normalize_sub

# Default camera orientation per hemisphere. The left-hemisphere view is the
# original FreeView-matched ventral view; the right-hemisphere view was tuned
# on the rh sliders to match it. To change either, drag the Camera sliders in
# the app and copy the values back into this dict.
DEFAULT_VIEWS = {
    "lh": {
        "azimuth": 40.0,
        "elevation": -10.0,
        "roll": 90.0,
        "azim_offset": 110.0,
        "camera_center_x": 0.38,
        "zoom": 1.0,
        "convention": "inv_zx",
    },
    "rh": {
        "azimuth": -40.0,
        "elevation": -10.0,
        "roll": -100.0,
        "azim_offset": -25.0,
        "camera_center_x": 0.0,
        "zoom": 1.0,
        "convention": "inv_zx",
    },
}

# Backward-compatible alias — the left-hemisphere view.
DEFAULT_VIEW = DEFAULT_VIEWS["lh"]


def default_view(hemi: str) -> dict:
    """Return a fresh copy of the stored camera view for a hemisphere."""
    hemi_fs, _ = normalize_hemi(hemi)
    return dict(DEFAULT_VIEWS.get(hemi_fs, DEFAULT_VIEWS["lh"]))

# (sub, hemi, surface_type) -> geometry dict. Persists for the process lifetime.
SURFACE_CACHE: dict[tuple[str, str, str], dict] = {}


# ---------------------------------------------------------------------------
# Camera rotation
# ---------------------------------------------------------------------------

def _rx(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], float)


def _rz(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], float)


def _r_axis_angle(axis, deg: float) -> np.ndarray:
    theta = np.deg2rad(deg)
    axis = np.asarray(axis, float)
    n = np.linalg.norm(axis)
    if n == 0:
        return np.eye(3)
    x, y, z = axis / n
    k = np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]], float)
    return np.eye(3) + np.sin(theta) * k + (1 - np.cos(theta)) * (k @ k)


def rotate_to_view(coords: np.ndarray, view: dict | None = None) -> np.ndarray:
    """Rotate mesh coordinates into the requested viewing orientation."""
    view = {**DEFAULT_VIEW, **(view or {})}
    ctr = coords.mean(axis=0, keepdims=True)
    centered = coords - ctr
    az = -(float(view["azimuth"]) + float(view["azim_offset"]))
    el = -float(view["elevation"])
    if view.get("convention", "inv_zx") == "inv_xz":
        r0 = _rx(el) @ _rz(az)
    else:
        r0 = _rz(az) @ _rx(el)
    roll = float(view["roll"])
    if roll:
        forward_world = r0 @ np.array([0.0, 1.0, 0.0])
        r = _r_axis_angle(forward_world, roll) @ r0
    else:
        r = r0
    return (centered @ r.T) + ctr


# ---------------------------------------------------------------------------
# Geometry loading
# ---------------------------------------------------------------------------

def load_surface(config: dict, sub: str, hemi: str, surface_type: str = "inflated") -> dict:
    """Load a subject's surface geometry + curvature shading.

    surface_type is a FreeSurfer surf basename: 'inflated' or 'pial'.
    Returns a dict with coords, faces, curv, bg (two-tone shading), n_verts.
    """
    sub = normalize_sub(sub)
    hemi_fs, _ = normalize_hemi(hemi)
    cache_key = (sub, hemi_fs, surface_type)
    if cache_key in SURFACE_CACHE:
        return SURFACE_CACHE[cache_key]

    import nibabel as nib

    surf_dir = fs_subject_dir(config, sub) / "surf"
    coords, faces = nib.freesurfer.io.read_geometry(str(surf_dir / f"{hemi_fs}.{surface_type}"))
    curv = np.asarray(nib.freesurfer.io.read_morph_data(str(surf_dir / f"{hemi_fs}.curv")), dtype=np.float32)
    data = {
        "coords": np.asarray(coords, dtype=np.float32),
        "faces": np.asarray(faces, dtype=np.int32),
        "curv": curv,
        "bg": np.where(curv > 0, 0.70, 0.35).astype(np.float32),
        "n_verts": coords.shape[0],
    }
    SURFACE_CACHE[cache_key] = data
    return data


def load_inflated(config: dict, sub: str, hemi: str) -> dict:
    return load_surface(config, sub, hemi, surface_type="inflated")


def load_pial(config: dict, sub: str, hemi: str) -> dict:
    return load_surface(config, sub, hemi, surface_type="pial")


# ---------------------------------------------------------------------------
# Vertex normals (used to lift overlays/labels off the mesh so they don't
# z-fight with it). Cached on the (rotated) surface dict.
# ---------------------------------------------------------------------------

def vertex_normals(surface: dict) -> np.ndarray:
    cached = surface.get("vertex_normals")
    if cached is not None:
        return cached
    coords = surface["coords_rot"]
    faces = surface["faces"]
    v0, v1, v2 = coords[faces[:, 0]], coords[faces[:, 1]], coords[faces[:, 2]]
    face_normals = np.cross(v1 - v0, v2 - v0).astype(np.float32)
    norms = np.linalg.norm(face_normals, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    face_normals /= norms
    normals = np.zeros((int(surface["n_verts"]), 3), dtype=np.float32)
    np.add.at(normals, faces[:, 0], face_normals)
    np.add.at(normals, faces[:, 1], face_normals)
    np.add.at(normals, faces[:, 2], face_normals)
    vnorms = np.linalg.norm(normals, axis=1, keepdims=True)
    vnorms[vnorms == 0] = 1.0
    normals /= vnorms
    surface["vertex_normals"] = normals
    return normals
