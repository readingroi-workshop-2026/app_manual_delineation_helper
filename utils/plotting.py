"""Build the Plotly surface figure: curvature base, heatmap overlay, ROI labels."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import plotly.graph_objects as go

from .config import normalize_hemi, normalize_sub
from .labels import load_gifti_values, read_label_vertices
from .surface import DEFAULT_VIEW, load_surface, rotate_to_view, vertex_normals


# ---------------------------------------------------------------------------
# Trace builders
# ---------------------------------------------------------------------------

def add_overlay(
    fig: go.Figure,
    values: np.ndarray,
    name: str,
    surface: dict,
    threshold: float = 1e-6,
    opacity: float = 0.86,
) -> None:
    """Draw a thresholded heatmap patch, lifted slightly off the mesh."""
    faces = surface["faces"]
    coords = surface["coords_rot"]
    active = np.isfinite(values) & (values > threshold)
    if not np.any(active):
        return
    face_mask = active[faces[:, 0]] | active[faces[:, 1]] | active[faces[:, 2]]
    sub_faces = faces[face_mask]
    used = np.unique(sub_faces.reshape(-1))
    remap = np.full(int(surface["n_verts"]), -1, dtype=np.int32)
    remap[used] = np.arange(len(used), dtype=np.int32)
    local_faces = remap[sub_faces]
    local_coords = coords[used].copy() + 1.0 * vertex_normals(surface)[used]
    local_values = values[used].copy()
    local_values[(~np.isfinite(local_values)) | (local_values <= threshold)] = np.nan
    fig.add_trace(
        go.Mesh3d(
            x=local_coords[:, 0], y=local_coords[:, 1], z=local_coords[:, 2],
            i=local_faces[:, 0], j=local_faces[:, 1], k=local_faces[:, 2],
            intensity=local_values, intensitymode="vertex",
            colorscale="Hot", cmin=threshold, opacity=opacity, showscale=True,
            colorbar=dict(title=name, thickness=12, len=0.65, x=0.98),
            hoverinfo="skip",
            lighting=dict(ambient=1.0, diffuse=0.0, specular=0.0, roughness=1.0),
            name=name,
        )
    )


def add_label_border(fig: go.Figure, vertices: np.ndarray, color: str, name: str, surface: dict) -> None:
    """Draw a label as its outline (contour) on the surface."""
    n_verts = int(surface["n_verts"])
    vertices = vertices[(vertices >= 0) & (vertices < n_verts)]
    if len(vertices) < 3:
        return
    faces = surface["faces"]
    mask = np.zeros(n_verts, dtype=bool)
    mask[vertices] = True
    in0, in1, in2 = mask[faces[:, 0]], mask[faces[:, 1]], mask[faces[:, 2]]
    border_face_mask = ((in0.astype(np.int8) + in1.astype(np.int8) + in2.astype(np.int8)) > 0) & ~(
        in0 & in1 & in2
    )
    bf = faces[border_face_mask]
    b0, b1, b2 = in0[border_face_mask], in1[border_face_mask], in2[border_face_mask]
    edges = []
    for ia, ib, ba, bb in [(0, 1, b0, b1), (1, 2, b1, b2), (2, 0, b2, b0)]:
        cross = ba != bb
        if np.any(cross):
            edges.append(np.sort(np.stack([bf[cross, ia], bf[cross, ib]], axis=1), axis=1))
    if not edges:
        return
    all_edges = np.unique(np.concatenate(edges, axis=0), axis=0)
    line_pts = np.full((len(all_edges) * 3, 3), np.nan, dtype=np.float32)
    coords = surface["coords_rot"] + 1.5 * vertex_normals(surface)
    line_pts[0::3] = coords[all_edges[:, 0]]
    line_pts[1::3] = coords[all_edges[:, 1]]
    fig.add_trace(
        go.Scatter3d(
            x=line_pts[:, 0], y=line_pts[:, 1], z=line_pts[:, 2],
            mode="lines", line=dict(color=color, width=7),
            showlegend=True, name=name, hoverinfo="none",
        )
    )


def add_label_fill(fig: go.Figure, vertices: np.ndarray, color: str, name: str, surface: dict) -> None:
    """Draw a label as a solid filled patch on the surface."""
    n_verts = int(surface["n_verts"])
    vertices = vertices[(vertices >= 0) & (vertices < n_verts)]
    if len(vertices) < 3:
        return
    mask = np.zeros(n_verts, dtype=bool)
    mask[vertices] = True
    faces = surface["faces"]
    face_mask = mask[faces[:, 0]] & mask[faces[:, 1]] & mask[faces[:, 2]]
    sub_faces = faces[face_mask]
    if len(sub_faces) == 0:
        face_mask = mask[faces[:, 0]] | mask[faces[:, 1]] | mask[faces[:, 2]]
        sub_faces = faces[face_mask]
    if len(sub_faces) == 0:
        return
    used = np.unique(sub_faces.reshape(-1))
    remap = np.full(n_verts, -1, dtype=np.int32)
    remap[used] = np.arange(len(used), dtype=np.int32)
    local_faces = remap[sub_faces]
    local_coords = surface["coords_rot"][used].copy() + 1.5 * vertex_normals(surface)[used]
    fig.add_trace(
        go.Mesh3d(
            x=local_coords[:, 0], y=local_coords[:, 1], z=local_coords[:, 2],
            i=local_faces[:, 0], j=local_faces[:, 1], k=local_faces[:, 2],
            color=color, opacity=0.9, showscale=False, showlegend=True,
            name=f"{name} fill", hoverinfo="skip",
            lighting=dict(ambient=1.0, diffuse=0.0, specular=0.0, roughness=1.0),
        )
    )


# ---------------------------------------------------------------------------
# Figure assembly
# ---------------------------------------------------------------------------

def build_surface_figure(
    config: dict,
    sub_value: str,
    hemi_value: str,
    overlay_path: str | Path | None = None,
    clusters: list[dict] | None = None,
    view: dict | None = None,
    overlay_name: str = "overlay",
    overlay_threshold: float = 1e-6,
    overlay_opacity: float = 0.86,
    surface_type: str = "inflated",
    drag_mode: str = "turntable",
):
    """Return (figure, overlay_path_or_None, [label_paths]).

    `overlay_path` is an explicit .func.gii path (or None for no heatmap).
    `clusters` is a list of layer specs, each a dict with:
      label_path (str)   explicit .label file to draw
      color (hex str)    line/fill color
      fill (bool)        filled patch vs. contour
      label_name (str)   legend name
    """
    sub = normalize_sub(sub_value)
    hemi_fs, hemi_bids = normalize_hemi(hemi_value)

    surface = load_surface(config, sub, hemi_fs, surface_type=surface_type)
    faces = surface["faces"]
    surface["coords_rot"] = rotate_to_view(surface["coords"], view)
    surface.pop("vertex_normals", None)
    coords = surface["coords_rot"]

    fig = go.Figure()
    fig.add_trace(
        go.Mesh3d(
            x=coords[:, 0], y=coords[:, 1], z=coords[:, 2],
            i=faces[:, 0], j=faces[:, 1], k=faces[:, 2],
            intensity=surface["bg"], intensitymode="vertex",
            colorscale="Greys", cmin=0, cmax=1, showscale=False, hoverinfo="skip",
            lighting=dict(ambient=0.9, diffuse=0.35, specular=0.05, roughness=0.9),
            name="curvature",
        )
    )

    opath = Path(overlay_path) if overlay_path else None
    if opath is not None and opath.exists():
        values = load_gifti_values(opath).astype(np.float32)
        add_overlay(fig, values, overlay_name, surface, threshold=overlay_threshold, opacity=overlay_opacity)

    label_paths = []
    for spec in clusters or []:
        color = str(spec.get("color", "#00ff00"))
        fill = bool(spec.get("fill", False))
        lpath = Path(str(spec["label_path"]))
        label_paths.append(lpath)
        if lpath.exists():
            vertices = np.asarray(read_label_vertices(lpath), dtype=np.int64)
            name = spec.get("label_name") or lpath.stem
            (add_label_fill if fill else add_label_border)(fig, vertices, color, name, surface)

    center_x = float((view or DEFAULT_VIEW).get("camera_center_x", 0.38))
    fig.update_layout(
        title=f"{sub} {hemi_fs} ({surface_type})",
        autosize=True, height=760, margin=dict(l=0, r=0, t=32, b=0),
        scene=dict(
            bgcolor="white",
            xaxis=dict(visible=False), yaxis=dict(visible=False), zaxis=dict(visible=False),
            aspectmode="data",
            dragmode=drag_mode,
            camera=dict(center=dict(x=center_x, y=0.0, z=0.0)),
        ),
        legend=dict(x=0.0, xanchor="left", y=0.5, yanchor="middle",
                    bgcolor="rgba(255,255,255,0.6)"),
    )
    return fig, opath, label_paths
