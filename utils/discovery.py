"""Discover what's on disk inside a given layer directory.

Each layer in the app points at one directory (resolved from its config
field or the live text box). These helpers scan that directory and return an
ordered ``{display_name: full_path}`` mapping. They hit an NFS mount, so
they're wrapped in st.cache_data with a short TTL — repeated Streamlit reruns
(e.g. dragging a slider) reuse the listing, but newly written files still show
up within TTL seconds without restarting the app.

The directory path is passed in as a string so the cache key is stable.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import streamlit as st

TTL = 30  # seconds

# Solid, saturated palette so labels stay legible on the gray surface.
CLUSTER_COLORS = [
    "#e6194b",  # red
    "#3cb44b",  # green
    "#4363d8",  # blue
    "#f58231",  # orange
    "#911eb4",  # purple
    "#f032e6",  # magenta
    "#008080",  # teal
    "#e6a000",  # amber
    "#0088ff",  # bright blue
    "#d40000",  # crimson
    "#7cb342",  # leaf green
    "#9a6324",  # brown
    "#c71585",  # violet-red
    "#1abc9c",  # turquoise
    "#6a3d9a",  # deep purple
    "#800000",  # maroon
    "#000075",  # navy
    "#ff4500",  # orange-red
]


@st.cache_data(ttl=TTL, show_spinner=False)
def heatmap_overlays_in(dir_path: str, hemi_bids: str) -> dict[str, str]:
    """`*.func.gii` overlays in a directory, for the given hemisphere.

    Display name is the descriptive tail (e.g. 'RWvsSC_scaled') when the BIDS
    'desc-*' pattern is present, otherwise the bare filename. Only files whose
    name carries the matching `hemi-<L|R>` tag are kept (files with no hemi tag
    are always shown).
    """
    d = Path(dir_path)
    if not d.is_dir():
        return {}
    out: dict[str, str] = {}
    for f in sorted(d.glob("*.func.gii")):
        name = f.name
        if f"hemi-{hemi_bids}" not in name and re.search(r"hemi-[LR]", name):
            continue
        m = re.search(r"_desc-GDscaled_(.+)\.func\.gii$", name)
        display = m.group(1) if m else name[: -len(".func.gii")]
        out[display] = str(f)
    return out


@st.cache_data(ttl=TTL, show_spinner=False)
def cluster_labels_in(dir_path: str, hemi_bids: str) -> dict[str, str]:
    """`*_Cluster_*.label` files in a directory, for the given hemisphere.

    Display name is 'contrast #id'; entries are ordered by contrast then id.
    """
    d = Path(dir_path)
    if not d.is_dir():
        return {}
    rows = []
    for f in d.glob("*_Cluster_*.label"):
        name = f.name
        if f"hemi-{hemi_bids}" not in name and re.search(r"hemi-[LR]", name):
            continue
        m = re.search(r"contrast-(.+?)_scaled_Cluster_(\d+)\.label$", name)
        if m:
            contrast, cid = m.group(1), int(m.group(2))
            rows.append((contrast, cid, str(f)))
        else:  # unrecognized naming — fall back to the stem
            rows.append(("", -1, str(f)))
    rows.sort(key=lambda r: (r[0], r[1]))
    out: dict[str, str] = {}
    for contrast, cid, path in rows:
        display = f"{contrast} #{cid}" if cid >= 0 else Path(path).stem
        out[display] = path
    return out


@st.cache_data(ttl=TTL, show_spinner=False)
def overlay_value_range(path: str) -> tuple[float, float]:
    """(min, max) of the finite values in a `.func.gii` overlay.

    Used to bound the threshold widget: overlays differ by an order of
    magnitude (a *_score map tops out at 1, a *_mean_raw map at ~20), so a
    fixed slider range is either mostly dead or unable to reach the peak.
    Returns (0.0, 1.0) when the file is unreadable or has no finite values.
    """
    from .labels import load_gifti_values

    try:
        values = load_gifti_values(Path(path))
    except Exception:
        return 0.0, 1.0
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return 0.0, 1.0
    return float(finite.min()), float(finite.max())


def clusters_by_contrast(cluster_map: dict[str, str]) -> dict[str, list[str]]:
    """Group `cluster_labels_in` display names by contrast.

    Returns ``{contrast: [display, ...]}`` in the order the clusters appear.
    Names that don't follow the 'contrast #id' pattern are grouped under
    themselves, so unrecognized files stay selectable.
    """
    out: dict[str, list[str]] = {}
    for display in cluster_map:
        head, sep, tail = display.rpartition(" #")
        contrast = head if sep and tail.isdigit() else display
        out.setdefault(contrast, []).append(display)
    return out


@st.cache_data(ttl=TTL, show_spinner=False)
def surface_labels_in(dir_path: str, hemi_fs: str) -> dict[str, str]:
    """`<hemi>.<name>.label` files in a directory → ``{name: path}``.

    Used for both atlas labels (layer 3) and manual labels (layer 4).
    """
    d = Path(dir_path)
    if not d.is_dir():
        return {}
    out: dict[str, str] = {}
    for f in sorted(d.glob(f"{hemi_fs}.*.label")):
        name = f.name[len(hemi_fs) + 1: -len(".label")]
        out[name] = str(f)
    return out
