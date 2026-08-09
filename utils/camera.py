"""Convert between Plotly's 3D camera and the app's azimuth/elevation/roll view.

The app never moves the camera: it rotates the *mesh* (see `rotate_to_view`) and
leaves Plotly at its default camera. So when you drag the plot by hand you are
composing a second rotation on top, and the sliders no longer describe what you
see. These helpers undo that composition, i.e. answer:

    "which slider values, with the default camera, would reproduce this view?"

It is exact for the orientation only. Plotly's camera lives in a scene-space
where each axis is normalized by its own range (`aspectmode="data"`), so a
dragged view is reproduced faithfully in direction but the reported angles are
an estimate rather than a round-trip guarantee.
"""

from __future__ import annotations

import numpy as np

# Plotly's defaults, used whenever the figure doesn't pin them (this app pins
# only camera.center.x).
DEFAULT_EYE = (1.25, 1.25, 1.25)
DEFAULT_UP = (0.0, 0.0, 1.0)


def _rot_matrix(eye, center, up) -> np.ndarray:
    """World -> camera rotation for a look-at camera, as rows [right, up, back]."""
    eye = np.asarray(eye, float)
    center = np.asarray(center, float)
    up = np.asarray(up, float)
    forward = center - eye
    forward /= np.linalg.norm(forward) or 1.0
    right = np.cross(forward, up)
    right /= np.linalg.norm(right) or 1.0
    true_up = np.cross(right, forward)
    return np.stack([right, true_up, -forward])


def view_matrix(view: dict) -> np.ndarray:
    """The mesh rotation `rotate_to_view` applies, as Rz(az) @ Rx(el) @ Ry(roll).

    Rolling about the transformed forward axis is a conjugation, so
    `R_axis(r0 @ y, roll) @ r0` collapses to `r0 @ Ry(roll)` — which makes the
    whole thing a plain ZXY Euler triple, and therefore invertible below.
    """
    a = np.deg2rad(-(float(view["azimuth"]) + float(view["azim_offset"])))
    b = np.deg2rad(-float(view["elevation"]))
    c = np.deg2rad(float(view["roll"]))
    ca, sa, cb, sb, cc, sc = np.cos(a), np.sin(a), np.cos(b), np.sin(b), np.cos(c), np.sin(c)
    return np.array([
        [ca * cc - sa * sb * sc, -sa * cb, ca * sc + sa * sb * cc],
        [sa * cc + ca * sb * sc, ca * cb, sa * sc - ca * sb * cc],
        [-cb * sc, sb, cb * cc],
    ])


def wrap180(deg: float) -> float:
    """Fold an angle into (-180, 180], the range the Camera sliders accept."""
    return float((float(deg) + 180.0) % 360.0 - 180.0)


def _decompose_zxy(m: np.ndarray) -> tuple[float, float, float]:
    """Inverse of `view_matrix`: a rotation -> (az, el, roll) radians."""
    b = np.arcsin(np.clip(m[2, 1], -1.0, 1.0))
    if abs(m[2, 1]) > 0.999999:  # gimbal lock: fold roll into azimuth
        return float(np.arctan2(m[0, 2], m[0, 0])), float(b), 0.0
    return (
        float(np.arctan2(-m[0, 1], m[1, 1])),
        float(b),
        float(np.arctan2(-m[2, 0], m[2, 2])),
    )


def zoom_to_eye(center_x: float, zoom: float) -> dict:
    """Plotly `camera.eye` for a zoom factor (>1 closer, <1 further away).

    Pulls the default eye toward the scene centre along the same line, so
    zoom=1 leaves the framing exactly as it was before zoom existed.
    """
    center = np.array([float(center_x), 0.0, 0.0])
    eye = center + (np.array(DEFAULT_EYE) - center) / max(float(zoom), 1e-3)
    return {"x": float(eye[0]), "y": float(eye[1]), "z": float(eye[2])}


def camera_to_view(camera: dict, view: dict) -> dict:
    """Slider values equivalent to the current Plotly `camera`.

    `view` is the view the figure was *built* with — the dragged camera sits on
    top of it, so it has to be composed back in. `azim_offset` is held fixed
    (it is a convention, not something dragging can change) and the azimuth
    absorbs the difference.
    """
    eye = camera.get("eye") or dict(zip("xyz", DEFAULT_EYE))
    up = camera.get("up") or dict(zip("xyz", DEFAULT_UP))
    center = camera.get("center") or {"x": 0.0, "y": 0.0, "z": 0.0}
    to_vec = lambda d: [float(d.get("x", 0.0)), float(d.get("y", 0.0)), float(d.get("z", 0.0))]
    eye_v, center_v = np.array(to_vec(eye)), np.array(to_vec(center))

    # Reference = the camera the figure was built with (default eye, but the
    # centre the app pins). Comparing against a (0,0,0)-centred camera would
    # leave a residual tilt and the untouched view wouldn't round-trip.
    built_center = (float(view["camera_center_x"]), 0.0, 0.0)
    default = _rot_matrix(DEFAULT_EYE, built_center, DEFAULT_UP)
    current = _rot_matrix(eye_v, center_v, to_vec(up))
    total = default.T @ current @ view_matrix(view)

    a, b, c = _decompose_zxy(total)
    offset = float(view["azim_offset"])
    ref_dist = float(np.linalg.norm(np.array(DEFAULT_EYE) - np.array(built_center)))
    dist = float(np.linalg.norm(eye_v - center_v)) or 1e-9
    # Subtracting the offset can push azimuth past a full turn; the sliders are
    # -180..180, and the rotation is identical modulo 360 anyway.
    return {
        "azimuth": round(wrap180(-np.rad2deg(a) - offset), 2),
        "elevation": round(-np.rad2deg(b), 2),
        "roll": round(wrap180(np.rad2deg(c)), 2),
        "azim_offset": offset,
        "camera_center_x": round(float(center_v[0]), 3),
        "zoom": round(ref_dist / dist, 3),
        "distance": round(dist, 3),
    }


# ---------------------------------------------------------------------------
# Live readout (browser side)
# ---------------------------------------------------------------------------

LIVE_READOUT_HTML = """
<style>
  body {margin:0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px;}
  .wrap {background:#0e1726; color:#e6edf7; border:1px solid #2b3b55;
         border-radius:8px; padding:8px 10px;}
  table {width:100%; border-collapse:collapse;}
  td {padding:1px 6px 1px 0; white-space:nowrap;}
  td.k {color:#8fa3c0;}
  td.v {text-align:right; font-variant-numeric:tabular-nums;}
  .hd {color:#8fa3c0; text-transform:uppercase; letter-spacing:.06em;
       font-size:10px; margin-bottom:3px;}
  button {margin-top:6px; font:inherit; background:#1e2c45; color:#e6edf7;
          border:1px solid #2b3b55; border-radius:5px; padding:2px 8px; cursor:pointer;}
  .warn {color:#f0a868;}
</style>
<div class="wrap">
  <div class="hd">current viewpoint</div>
  <table id="derived"></table>
  <span id="status"></span>
</div>
<script>
const VIEW = __VIEW__;
const DEFAULT_EYE = [1.25, 1.25, 1.25];
const d2r = d => d * Math.PI / 180, r2d = r => r * 180 / Math.PI;
const sub = (a,b) => a.map((v,i) => v - b[i]);
const nrm = v => {const n = Math.hypot(...v) || 1; return v.map(x => x/n);};
const crs = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const mul = (A,B) => A.map(r => B[0].map((_,j) => r.reduce((s,v,k) => s + v*B[k][j], 0)));
const tps = A => A[0].map((_,j) => A.map(r => r[j]));

function camRot(eye, center, up) {
  const f = nrm(sub(center, eye)), r = nrm(crs(f, up)), u = crs(r, f);
  return [r, u, f.map(x => -x)];
}
function viewMat(v) {
  const a = d2r(-(v.azimuth + v.azim_offset)), b = d2r(-v.elevation), c = d2r(v.roll);
  const ca=Math.cos(a), sa=Math.sin(a), cb=Math.cos(b), sb=Math.sin(b),
        cc=Math.cos(c), sc=Math.sin(c);
  return [[ca*cc - sa*sb*sc, -sa*cb, ca*sc + sa*sb*cc],
          [sa*cc + ca*sb*sc,  ca*cb, sa*sc - ca*sb*cc],
          [-cb*sc,            sb,    cb*cc]];
}
function toView(cam) {
  const eye = [cam.eye.x, cam.eye.y, cam.eye.z];
  const up  = [cam.up.x,  cam.up.y,  cam.up.z];
  const ctr = [cam.center.x, cam.center.y, cam.center.z];
  const built = [VIEW.camera_center_x, 0, 0];
  const total = mul(mul(tps(camRot(DEFAULT_EYE, built, [0,0,1])), camRot(eye, ctr, up)), viewMat(VIEW));
  const b = Math.asin(Math.max(-1, Math.min(1, total[2][1])));
  const locked = Math.abs(total[2][1]) > 0.999999;
  const a = locked ? Math.atan2(total[0][2], total[0][0]) : Math.atan2(-total[0][1], total[1][1]);
  const c = locked ? 0 : Math.atan2(-total[2][0], total[2][2]);
  const refD = Math.hypot(...sub(DEFAULT_EYE, built));
  const dist = Math.hypot(...sub(eye, ctr)) || 1e-9;
  const w = d => ((d + 180) % 360 + 360) % 360 - 180;   // fold into -180..180
  return {azimuth: w(-r2d(a) - VIEW.azim_offset), elevation: -r2d(b), roll: w(r2d(c)),
          azim_offset: VIEW.azim_offset, camera_center_x: ctr[0],
          zoom: refD / dist, distance: dist};
}
const fmt = (x, n=2) => Number(x).toFixed(n);
let last = null;
function draw(cam) {
  const v = toView(cam); last = v;
  document.getElementById("derived").innerHTML = [
    ["azimuth", fmt(v.azimuth) + "\\u00b0"], ["elevation", fmt(v.elevation) + "\\u00b0"],
    ["roll", fmt(v.roll) + "\\u00b0"], ["azim offset", fmt(v.azim_offset) + "\\u00b0"],
    ["center x", fmt(v.camera_center_x, 3)], ["zoom", fmt(v.zoom, 3) + "\\u00d7"],
  ].map(([k, val]) => `<tr><td class="k">${k}</td><td class="v">${val}</td></tr>`).join("");
}
function copyJSON() {
  if (!last) return;
  navigator.clipboard.writeText(JSON.stringify(last, null, 2));
  const s = document.getElementById("status");
  s.textContent = " copied"; setTimeout(() => s.textContent = "", 1500);
}
function findPlot() {
  // The chart lives in the parent Streamlit document, not in this iframe.
  const doc = window.parent.document;
  return doc.querySelector(".stPlotlyChart .js-plotly-plot") || doc.querySelector(".js-plotly-plot");
}
function attach() {
  const gd = findPlot();
  if (!gd || !gd.on) { setTimeout(attach, 400); return; }
  if (gd.__camWatch) return;
  gd.__camWatch = true;
  const read = () => {
    const cam = (gd._fullLayout && gd._fullLayout.scene && gd._fullLayout.scene.camera) ||
                (gd.layout && gd.layout.scene && gd.layout.scene.camera);
    if (cam && cam.eye) draw(cam);
  };
  // relayouting fires continuously during a drag, relayout once at the end.
  gd.on("plotly_relayouting", read);
  gd.on("plotly_relayout", read);
  gd.on("plotly_afterplot", read);
  read();
}
attach();
</script>
"""
