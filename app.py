#!/usr/bin/env python3
"""Streamlit surface viewer: one inflated *or* pial surface with four
independently path-configured label/overlay layers.

Layers (each reads a directory from config.yaml, editable live in the app):
  1 Heatmap overlay   heatmap_dir       *.func.gii
  2 Auto clusters     clusters_dir      *_Cluster_*.label
  3 Atlas labels      atlas_label_dir   lh.*.label (FreeSurfer/atlas)
  4 Manual labels     manual_label_dir  lh.*.label (user-defined, e.g. manual-v1)

UI only — all logic lives in the utils package (config / surface / labels /
discovery / plotting).
"""

from __future__ import annotations

import json
from pathlib import Path

import streamlit as st
from streamlit_js_eval import streamlit_js_eval

from utils import __version__
from utils.camera import LIVE_READOUT_HTML, camera_to_view, wrap180
from utils.config import load_config, normalize_hemi, normalize_sub, resolve_dir
from utils.discovery import (
    CLUSTER_COLORS,
    cluster_labels_in,
    clusters_by_contrast,
    heatmap_overlays_in,
    overlay_value_range,
    surface_labels_in,
)
from utils.plotting import build_surface_figure
from utils.surface import default_view

APP_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = APP_DIR / "config.yaml"

st.set_page_config(
    page_title="VOTCLOC Surface Viewer",
    page_icon="🧠",
    layout="wide",
    initial_sidebar_state="expanded",
)

# Compact layout: narrower sidebar, tighter paddings, smaller widget gaps.
st.markdown(
    """
<style>
[data-testid="stSidebar"] {width: 300px !important; min-width: 300px !important;}
[data-testid="stSidebar"] .block-container {padding-top:1rem;}
.block-container {padding:0.6rem 1rem 0.5rem 1rem; max-width:100%;}
[data-testid="stVerticalBlock"] {gap:0.35rem;}
[data-testid="stExpander"] summary p {font-size:0.85rem;font-weight:600;}
.big-title {font-size:1.25rem;font-weight:800;letter-spacing:-.02em;margin:0;}
.subtitle {color:#94a3b8;font-size:.8rem;margin:0 0 .3rem 0;}
h3 {margin:.2rem 0 .1rem 0;}
</style>
""",
    unsafe_allow_html=True,
)


def _keep_valid(key: str, options: list) -> None:
    """Drop stale multiselect selections that no longer exist in `options`."""
    if key in st.session_state:
        valid = set(options)
        st.session_state[key] = [v for v in st.session_state[key] if v in valid]


def _clear(*keys: str) -> None:
    for key in keys:
        st.session_state[key] = []


# Viewpoint fields: label, session-state key suffix, min, max, step. Single
# source of truth for the Camera sliders, the typed boxes and anything written
# back by a capture — an unclamped write here makes the slider reject its own
# session value on the next run (StreamlitValueBelowMinError).
VIEW_FIELDS = (
    ("azimuth", "Azimuth", "azimuth", -180.0, 180.0, 0.1),
    ("elevation", "Elevation", "elevation", -90.0, 90.0, 0.1),
    ("roll", "Roll", "roll", -180.0, 180.0, 0.1),
    ("azim_offset", "Azim offset", "azim_offset", -180.0, 180.0, 0.1),
    ("camera_center_x", "Center x", "center_x", -1.0, 1.0, 0.01),
    ("zoom", "Zoom", "zoom", 0.2, 5.0, 0.05),
)
VIEW_RANGES = {f[0]: (f[3], f[4]) for f in VIEW_FIELDS}
VIEW_STEPS = {f[0]: f[5] for f in VIEW_FIELDS}


def _view_key(field: str, hemi_fs: str) -> str:
    suffix = next(f[2] for f in VIEW_FIELDS if f[0] == field)
    return f"{suffix}_{hemi_fs}"


# Angles are cyclic: fold them into -180..180 rather than clipping, which would
# silently throw away the view (-273.8 -> -180 instead of the equivalent 86.2).
VIEW_CYCLIC = {"azimuth", "roll", "azim_offset"}


def _clamp(field: str, value: float) -> float:
    lo, hi = VIEW_RANGES[field]
    value = wrap180(value) if field in VIEW_CYCLIC else float(value)
    return min(max(value, lo), hi)


def _per_label_style(names: list[str], panel: str,
                     palette_offset: int = 0) -> dict[str, tuple[str, bool]]:
    """One colour swatch + fill toggle per selected label.

    Returns ``{name: (color, fill)}``. Each label keeps its own choice in
    session_state, so re-selecting a label brings its colour back; defaults
    walk the palette so two labels never start out identical.
    """
    styles: dict[str, tuple[str, bool]] = {}
    if not names:
        return styles
    st.caption("colour · tick = filled patch (unticked = outline)")
    for i, name in enumerate(names):
        ckey, fkey = f"{panel}_col::{name}", f"{panel}_fill::{name}"
        st.session_state.setdefault(
            ckey, CLUSTER_COLORS[(i + palette_offset) % len(CLUSTER_COLORS)])
        st.session_state.setdefault(fkey, False)
        c1, c2 = st.columns([1, 3], vertical_alignment="center")
        with c1:
            st.color_picker(name, key=ckey, label_visibility="collapsed")
        with c2:
            st.checkbox(name, key=fkey)
        styles[name] = (st.session_state[ckey], bool(st.session_state[fkey]))
    return styles


def _snapshot_name(sub: str, hemi_fs: str, surface_type: str,
                   overlay_name: str, threshold: float) -> str:
    """Filename for the modebar's PNG export, describing what is on screen."""
    parts = [sub, hemi_fs, surface_type]
    if overlay_name and overlay_name != "none":
        parts += [overlay_name, f"thr{threshold:g}"]
    return "_".join(parts)


def _set_view_value(slider_key: str, box_key: str) -> None:
    """Typed viewpoint value -> Camera slider, and force the surface to redraw."""
    st.session_state[slider_key] = float(st.session_state[box_key])
    st.session_state["force_plot"] = True


def _apply_captured(captured: dict | None, hemi_fs: str) -> None:
    """Push a captured viewpoint into the Camera sliders.

    Called before the sliders are instantiated — that is the only moment a
    widget's session_state entry may be written; assigning afterwards raises.
    """
    if not captured:
        return
    for field in VIEW_RANGES:
        if field in captured:
            st.session_state[_view_key(field, hemi_fs)] = _clamp(field, captured[field])
    st.session_state["force_plot"] = True


def _viewpoint_panel(view: dict, hemi_fs: str) -> None:
    """Live readout of the dragged camera + capture it into the sliders."""
    with st.expander("📐 Viewpoint — live camera readout", expanded=False):
        st.caption(
            "Drag the brain: these numbers update as you go. The button below "
            "writes them into the sidebar's Camera sliders and redraws."
        )
        st.iframe(
            LIVE_READOUT_HTML.replace("__VIEW__", json.dumps(
                {k: view[k] for k in
                 ("azimuth", "elevation", "roll", "azim_offset", "camera_center_x")}
            )),
            height=180,
        )
        st.button(
            "⬅ Copy readout into the sidebar sliders", key="capture_view",
            width="stretch", type="primary",
            help="Takes the viewpoint you dragged to and writes it into the "
                 "Camera sliders, then redraws.",
            on_click=lambda: st.session_state.update(
                capture_wanted=True,
                capture_n=st.session_state.get("capture_n", 0) + 1),
        )

        # Typed entry for the same six values. These write the Camera sliders'
        # session_state keys from an on_change callback (the only safe moment —
        # the sliders were already instantiated higher up this run) and ask for
        # a rebuild, so a typed number moves the surface straight away.
        st.caption("Type exact values — the plot redraws on Enter.")
        cols = st.columns(3)
        for i, (field, label, _, lo, hi, step) in enumerate(VIEW_FIELDS):
            slider_key = _view_key(field, hemi_fs)
            box_key = f"num_{slider_key}"
            # Mirror the slider into the box each run so the two never drift.
            st.session_state[box_key] = _clamp(field, view[field])
            with cols[i % 3]:
                st.number_input(label, lo, hi, step=step, format="%.2f", key=box_key,
                                on_change=_set_view_value, args=(slider_key, box_key))

        # Must render on every run, not only on the click: streamlit_js_eval
        # returns None on the run that mounts it and delivers the value on a
        # later rerun, so a component that only exists during the click run
        # disappears before its answer arrives.
        cam = streamlit_js_eval(
            js_expressions=(
                "(() => {const d = window.parent.document;"
                " const gd = d.querySelector('.stPlotlyChart .js-plotly-plot')"
                "         || d.querySelector('.js-plotly-plot');"
                " const s = gd && (gd._fullLayout?.scene || gd.layout?.scene);"
                " return s && s.camera ? JSON.stringify(s.camera) : null;})()"
            ),
            key=f"grab_camera_{st.session_state.get('capture_n', 0)}",
            want_output=True,
        )
        # Consume it ONLY when the button asked for it. Acting on every change
        # loops forever: applying a capture rebuilds the figure, which moves the
        # camera, which looks like a new capture, which rebuilds again...
        if cam and st.session_state.pop("capture_wanted", False):
            captured = camera_to_view(json.loads(cam), view)
            st.session_state["captured_view"] = captured
            # Applied at the top of the next run: the Camera sliders already
            # exist by the time this panel renders, and a widget's state can
            # only be written before it is instantiated.
            st.session_state["pending_capture"] = captured
            st.rerun()

        captured = st.session_state.get("captured_view")
        if captured:
            snippet = ",\n".join(f'        "{k}": {captured[k]}' for k in
                                 ("azimuth", "elevation", "roll", "azim_offset",
                                  "camera_center_x", "zoom"))
            st.caption("Paste into `DEFAULT_VIEWS` in `utils/surface.py` to make it the preset:")
            st.code(f'"{hemi_fs}": {{\n{snippet},\n        "convention": "inv_zx",\n    }},',
                    language="python")


def _threshold_widgets(overlay_path: str | None, overlay_name: str) -> float:
    """Threshold slider + exact-value box, bounded by the overlay's own range.

    Overlays span very different ranges, so the bounds are read from the file
    (peak shown as a caption). Widget keys carry the overlay name: each map
    keeps its own threshold, and switching maps can't leave a stale value
    outside the new bounds.
    """
    if overlay_path is None:
        return 0.0
    vmin, vmax = overlay_value_range(str(overlay_path))
    lo, hi = 0.0, float(max(vmax, 1e-6))
    step = max(round(hi / 200, 4), 1e-4)
    st.caption(f"Range {vmin:.3g} – {vmax:.3g}")

    slider_key, input_key = f"thr_s::{overlay_name}", f"thr_n::{overlay_name}"
    default = min(0.1, hi)
    for k in (slider_key, input_key):
        st.session_state[k] = min(max(float(st.session_state.get(k, default)), lo), hi)

    def _mirror(src: str, dst: str) -> None:
        st.session_state[dst] = st.session_state[src]

    c1, c2 = st.columns([2, 1])
    with c1:
        st.slider("Threshold", lo, hi, step=step, key=slider_key,
                  on_change=_mirror, args=(slider_key, input_key))
    with c2:
        st.number_input("Exact", lo, hi, step=step, format="%.4g", key=input_key,
                        on_change=_mirror, args=(input_key, slider_key),
                        help="Type a threshold; the slider follows.")
    return float(st.session_state[input_key])


# ---------------------------------------------------------------------------
# Sidebar — global controls
# ---------------------------------------------------------------------------
with st.sidebar:
    st.markdown("### 🧠 Surface viewer")
    st.caption(f"v{__version__}")

    config_path_text = st.text_input("Config YAML", value=str(DEFAULT_CONFIG))
    try:
        config = load_config(Path(config_path_text).expanduser())
    except Exception as exc:
        st.error(f"Could not load config: {exc}")
        st.stop()

    c1, c2 = st.columns(2)
    with c1:
        sub_input = st.text_input("Subject", value=str(config.get("default_subject", "07")))
    with c2:
        hemi_input = st.selectbox(
            "Hemisphere", ["lh", "rh"],
            index=0 if str(config.get("default_hemi", "lh")) == "lh" else 1,
        )
    sub = normalize_sub(sub_input)
    hemi_fs, hemi_bids = normalize_hemi(hemi_input)

    s1, s2 = st.columns(2)
    with s1:
        surface_type = st.selectbox(
            "Surface", ["inflated", "pial"],
            index=0 if str(config.get("default_surface", "inflated")) == "inflated" else 1,
        )
    with s2:
        drag_mode = st.selectbox(
            "Rotation", ["orbit", "turntable"],
            help="orbit is a free trackball. turntable keeps a fixed up-axis, "
                 "which snaps camera.up back to +Z and discards an oblique "
                 "hand-rotated view.",
        )

    plot_sidebar = st.button(
        "🔄 Update plot", type="primary", width="stretch", key="plot_sidebar",
    )

    with st.expander("Camera", expanded=False):
        # Per-hemisphere slider state: keys are hemi-suffixed, so switching lh/rh
        # loads that hemisphere's stored preset and keeps its tweaks independent.
        base_view = default_view(hemi_input)
        _apply_captured(st.session_state.pop("pending_capture", None), hemi_fs)

        def _cam_slider(label, field, help=None):
            # Seed from the preset instead of passing `value=` (Streamlit warns
            # when a widget has both a default and a session_state value), and
            # clamp: a capture or an old session can hold an out-of-range value,
            # and the slider would reject its own state.
            lo, hi = VIEW_RANGES[field]
            step = VIEW_STEPS[field]
            key = _view_key(field, hemi_fs)
            st.session_state[key] = _clamp(
                field, st.session_state.get(key, base_view.get(field, 0.0)))
            return st.slider(label, lo, hi, step=step, key=key, help=help)

        view = {
            "azimuth": _cam_slider("Azimuth", "azimuth"),
            "elevation": _cam_slider("Elevation", "elevation"),
            "roll": _cam_slider("Roll", "roll"),
            "azim_offset": _cam_slider("Azimuth offset", "azim_offset"),
            "camera_center_x": _cam_slider("Camera center x", "camera_center_x"),
            "zoom": _cam_slider("Zoom", "zoom",
                                help="Pulls the camera toward the surface; >1 closer, <1 further."),
            "convention": base_view.get("convention", "inv_zx"),
        }

st.markdown('<div class="big-title">VOTCLOC surface viewer</div>', unsafe_allow_html=True)
st.markdown(f'<div class="subtitle">{sub} · {hemi_fs} · {surface_type}</div>', unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# Layer panels — each points at a directory (config field, live-editable)
# ---------------------------------------------------------------------------
col1, col2, col3, col4 = st.columns(4)

# --- 1. Heatmap overlay ----------------------------------------------------
with col1:
    with st.expander("1 · Heatmap", expanded=True):
        heatmap_tmpl = st.text_input(
            "heatmap_dir", value=str(config.get("heatmap_dir", "")), key="heatmap_dir",
            help="Directory of *.func.gii overlays. {sub} → subject.",
        )
        overlays = heatmap_overlays_in(str(resolve_dir(config, heatmap_tmpl, sub)), hemi_bids)
        overlay_choices = ["none"] + list(overlays.keys())
        default_overlay = f"{config.get('default_contrast', 'RWvsPER')}_score"
        overlay_name = st.selectbox(
            "Overlay", overlay_choices,
            index=overlay_choices.index(default_overlay) if default_overlay in overlay_choices else 0,
            key="overlay_name",
        )
        overlay_threshold = _threshold_widgets(
            overlays.get(overlay_name) if overlay_name != "none" else None, overlay_name
        )
        overlay_opacity = st.slider("Opacity", 0.0, 1.0, 0.85, key="overlay_opacity")
        plot_1 = st.button("🔄 Plot", width="stretch", key="plot_btn_1")

# --- 2. Auto clusters ------------------------------------------------------
with col2:
    with st.expander("2 · Auto clusters", expanded=False):
        clusters_tmpl = st.text_input(
            "clusters_dir", value=str(config.get("clusters_dir", "")), key="clusters_dir",
            help="Directory of *_Cluster_*.label files. {sub} → subject.",
        )
        cluster_map = cluster_labels_in(str(resolve_dir(config, clusters_tmpl, sub)), hemi_bids)
        by_contrast = clusters_by_contrast(cluster_map)
        _keep_valid("cluster_contrast_sel", list(by_contrast))
        selected_contrasts = st.multiselect(
            "Contrasts (all clusters)", list(by_contrast), key="cluster_contrast_sel",
            help="Shortcut for selecting every cluster of that contrast — each one "
                 "is still drawn individually, with its own color and legend entry.",
            format_func=lambda c: f"{c} ({len(by_contrast[c])})",
        )
        st.caption("ℹ️ Cluster IDs run **posterior → anterior**: the higher the "
                   "index, the more anterior the cluster.")
        _keep_valid("cluster_sel", list(cluster_map))
        selected_clusters = st.multiselect(
            "Individual clusters", list(cluster_map), key="cluster_sel",
            help="Added on top of whatever the contrast selection already covers.",
        )
        cluster_fill = st.checkbox("Fill", value=False, key="cluster_fill")
        st.button("Clear all", key="clear_cluster_btn", on_click=_clear,
                  args=("cluster_sel", "cluster_contrast_sel"))
        plot_2 = st.button("🔄 Plot", width="stretch", key="plot_btn_2")

# --- 3. Atlas labels -------------------------------------------------------
with col3:
    with st.expander("3 · Atlas labels", expanded=False):
        atlas_tmpl = st.text_input(
            "atlas_label_dir", value=str(config.get("atlas_label_dir", "")), key="atlas_label_dir",
            help="FreeSurfer/atlas labels: <hemi>.*.label. {sub} → subject.",
        )
        atlas_map = surface_labels_in(str(resolve_dir(config, atlas_tmpl, sub)), hemi_fs)
        _keep_valid("atlas_sel", list(atlas_map))
        selected_atlas = st.multiselect("Labels", list(atlas_map), key="atlas_sel")
        atlas_styles = _per_label_style(selected_atlas, "atlas")
        st.button("Clear all", key="clear_atlas_btn", on_click=_clear, args=("atlas_sel",))
        plot_3 = st.button("🔄 Plot", width="stretch", key="plot_btn_3")

# --- 4. Manual labels ------------------------------------------------------
with col4:
    with st.expander("4 · Manual labels", expanded=False):
        manual_tmpl = st.text_input(
            "manual_label_dir", value=str(config.get("manual_label_dir", "")), key="manual_label_dir",
            help="User-defined labels: <hemi>.*.label (e.g. manual-v1). {sub} → subject.",
        )
        manual_map = surface_labels_in(str(resolve_dir(config, manual_tmpl, sub)), hemi_fs)
        _keep_valid("manual_sel", list(manual_map))
        selected_manual = st.multiselect("Labels", list(manual_map), key="manual_sel")
        manual_styles = _per_label_style(selected_manual, "manual", palette_offset=9)
        st.button("Clear all", key="clear_manual_btn", on_click=_clear, args=("manual_sel",))
        plot_4 = st.button("🔄 Plot", width="stretch", key="plot_btn_4")


# --- Build the shared label spec list --------------------------------------
clusters: list[dict] = []

# Layer 2: picking a contrast is a shortcut for picking all of its clusters —
# each one still becomes its own cluster with its own color and legend entry.
# Union of both selections, kept in cluster_map order (contrast, then id).
chosen = {n for c in selected_contrasts for n in by_contrast[c]} | set(selected_clusters)
for i, name in enumerate(n for n in cluster_map if n in chosen):
    clusters.append({
        "label_path": cluster_map[name],
        "color": CLUSTER_COLORS[i % len(CLUSTER_COLORS)],
        "fill": cluster_fill,
        "label_name": name,
    })
# Layers 3 and 4: colour and fill are per label, set in the panel.
for label_map, styles in ((atlas_map, atlas_styles), (manual_map, manual_styles)):
    for name, (color, fill) in styles.items():
        clusters.append({
            "label_path": label_map[name],
            "color": color,
            "fill": fill,
            "label_name": name,
        })

overlay_path = None if overlay_name == "none" else overlays.get(overlay_name)

# Same note as in panel 2, shown next to the clickable legend entries.
legend_note = ("Cluster IDs: posterior → anterior<br>(higher index = more anterior)"
               if (selected_contrasts or selected_clusters) else None)


# ---------------------------------------------------------------------------
# Render — one full-width surface.
# The 3D mesh is expensive, so it is rebuilt ONLY when a Plot button is pressed
# (any of the sidebar / per-panel buttons) or on the very first load. Between
# clicks the last figure is served from session_state, so tweaking widgets is
# instant and the surface updates only on demand.
# ---------------------------------------------------------------------------
do_plot = bool(plot_sidebar or plot_1 or plot_2 or plot_3 or plot_4
               or st.session_state.pop("force_plot", False))
need_build = do_plot or "fig_main_obj" not in st.session_state

if need_build:
    try:
        fig, opath, label_paths = build_surface_figure(
            config, sub, hemi_input, overlay_path, clusters,
            view=view,
            overlay_name=overlay_name,
            overlay_threshold=overlay_threshold,
            overlay_opacity=overlay_opacity,
            surface_type=surface_type,
            drag_mode=drag_mode,
            legend_note=legend_note,
        )
    except Exception as exc:
        st.error(str(exc))
    else:
        st.session_state["fig_main_obj"] = fig
        st.session_state["fig_main_missing"] = [str(p) for p in label_paths if not p.exists()]

if "fig_main_obj" in st.session_state:
    missing = st.session_state.get("fig_main_missing", [])
    if missing:
        with st.expander(f"⚠️ {len(missing)} label file(s) not found", expanded=False):
            for p in missing:
                st.code(p)
    st.plotly_chart(
        st.session_state["fig_main_obj"], width="stretch",
        # Both rotation buttons stay in the modebar, but the sidebar's Rotation
        # box is the intended control: plotly's turntable button forces
        # camera.up back to +Z, which discards an oblique hand-rotated view.
        config={
            "displaylogo": False, "scrollZoom": True,
            # Modebar camera icon: exports the plot area only. Default is
            # screen resolution named newplot.png — neither is useful for a
            # figure, so name it after what is on screen and render at 3x.
            "toImageButtonOptions": {
                "format": "png", "filename": _snapshot_name(
                    sub, hemi_fs, surface_type, overlay_name, overlay_threshold),
                "scale": 3,
            },
        },
        key="fig_main",
    )
    _viewpoint_panel(view, hemi_fs)
else:
    st.info("Configure the layers, then click **🔄 Update plot**.")
