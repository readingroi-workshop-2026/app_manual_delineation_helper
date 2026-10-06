// Surface viewer engine: one hemisphere shown on several surfaces (inflated,
// pial, ...) side by side, with linked cameras.
//
// All surfaces of a hemisphere share vertex indices, so the engine keeps ONE
// per-vertex colour buffer that every mesh renders; an app paints into it
// (`paint(out)`) and everything it draws shows on every surface at once.
//
// Master copy: app_manual_delineation_helper/static/engine/ (it came from
// app_surface_annotate, retired 2026-10-05). app_surface_t1w_labeling keeps a
// copy under static/vendor/engine/. Keep it free of app-specific UI and state.

import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

export { THREE };

let bvh = null;
try {
  bvh = await import("three-mesh-bvh");
  THREE.Mesh.prototype.raycast = bvh.acceleratedRaycast;
} catch (e) {
  console.warn("three-mesh-bvh unavailable, picking will be slower", e);
}

export const PATH_COLOR = [1.0, 0.85, 0.1];

// Blend an 0-255 RGB colour into vertex i of a 0-1 colour buffer.
export function blend(out, i, rgb, a) {
  out[3 * i] = out[3 * i] * (1 - a) + (rgb[0] / 255) * a;
  out[3 * i + 1] = out[3 * i + 1] * (1 - a) + (rgb[1] / 255) * a;
  out[3 * i + 2] = out[3 * i + 2] * (1 - a) + (rgb[2] / 255) * a;
}

// FreeSurfer curvature shading (curv > threshold = sulcus = dark).
//   binary: two tones, sulci `dark`, gyri `light` (the default look);
//   smooth: a grey ramp from light to dark over threshold ± range, so the
//           depth of a fold shows, not just its sign.
// Brightness is 0..1. The defaults reproduce the original two-tone shading.
export const CURV_DEFAULTS = Object.freeze({ mode: "binary", threshold: 0, range: 0.15, dark: 0.46, light: 0.72 });

export function paintCurvature(out, curv, n, on = true, opts = {}) {
  const o = { ...CURV_DEFAULTS, ...opts };
  const span = Math.max(1e-6, o.range);
  for (let i = 0; i < n; i++) {
    let g = 0.6;
    if (curv && on) {
      const c = curv[i];
      if (o.mode === "smooth") {
        const t = Math.min(1, Math.max(0, 0.5 + (c - o.threshold) / (2 * span)));
        g = o.light + (o.dark - o.light) * t;
      } else g = c > o.threshold ? o.dark : o.light;
    }
    out[3 * i] = out[3 * i + 1] = out[3 * i + 2] = g;
  }
}

// Controls for the options above, written into `box`. `opts` is mutated in
// place and `onChange()` called on every edit. With `storageKey`, the
// settings are remembered in this browser (localStorage) across reloads.
export function curvatureControls(box, opts, onChange, storageKey = null) {
  if (storageKey) {
    try { Object.assign(opts, JSON.parse(localStorage.getItem(storageKey) || "{}")); } catch {}
  }
  for (const k of Object.keys(CURV_DEFAULTS)) opts[k] ??= CURV_DEFAULTS[k];
  const save = () => { if (storageKey) try { localStorage.setItem(storageKey, JSON.stringify(opts)); } catch {} };
  const row = (label, input, title = "") =>
    `<label class="row" title="${title}"><span class="curv-lab">${label}</span>${input}</label>`;
  const range = (k, min, max, step) =>
    `<input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}"><output data-o="${k}"></output>`;
  const draw = () => {
    box.innerHTML =
      row("mode", `<select data-k="mode"><option value="binary">binary (two tones)</option>
        <option value="smooth">smooth (grey ramp)</option></select>`,
          "binary: sulcus / gyrus only · smooth: shade follows how deep or high the fold is") +
      row("threshold", range("threshold", -0.5, 0.5, 0.01),
          "curv value where gyrus turns into sulcus (0 = FreeSurfer's sign)") +
      (opts.mode === "smooth" ? row("range ±", range("range", 0.02, 1, 0.01), "curv span of the ramp around the threshold") : "") +
      row("sulci", range("dark", 0, 1, 0.01), "brightness of sulci (curv above threshold)") +
      row("gyri", range("light", 0, 1, 0.01), "brightness of gyri (curv below threshold)") +
      `<div class="row"><button data-reset>reset curvature</button></div>`;
    for (const el of box.querySelectorAll("[data-k]")) {
      el.value = opts[el.dataset.k];
      el.oninput = el.onchange = () => {
        const k = el.dataset.k;
        opts[k] = k === "mode" ? el.value : +el.value;
        if (k === "mode") { draw(); } else show();
        save(); onChange();
      };
    }
    box.querySelector("[data-reset]").onclick = () => { Object.assign(opts, CURV_DEFAULTS); draw(); save(); onChange(); };
    show();
  };
  const show = () => {
    for (const o of box.querySelectorAll("[data-o]")) o.textContent = (+opts[o.dataset.o]).toFixed(2);
  };
  draw();
  return box;
}

// Ring + cross sprite for the cursor marker (white, tinted by the material colour),
// with a dark rim so it reads on light gyri and dark sulci alike.
let _cursorTex = null;
function cursorTexture() {
  if (_cursorTex) return _cursorTex;
  const n = 64, cv = document.createElement("canvas");
  cv.width = cv.height = n;
  const g = cv.getContext("2d");
  const ring = (w, col) => {
    g.strokeStyle = col; g.lineWidth = w;
    g.beginPath(); g.arc(n / 2, n / 2, n * 0.3, 0, 2 * Math.PI); g.stroke();
    g.beginPath();
    g.moveTo(n * 0.5, n * 0.04); g.lineTo(n * 0.5, n * 0.3); g.moveTo(n * 0.5, n * 0.7); g.lineTo(n * 0.5, n * 0.96);
    g.moveTo(n * 0.04, n * 0.5); g.lineTo(n * 0.3, n * 0.5); g.moveTo(n * 0.7, n * 0.5); g.lineTo(n * 0.96, n * 0.5);
    g.stroke();
  };
  ring(10, "rgba(0,0,0,0.85)");
  ring(4.5, "#ffffff");
  g.fillStyle = "#ffffff";
  g.beginPath(); g.arc(n / 2, n / 2, 3.5, 0, 2 * Math.PI); g.fill();
  _cursorTex = new THREE.CanvasTexture(cv);
  return _cursorTex;
}

const VIEWS = {
  lateral: (lat) => [[lat, 0, 0], [0, 0, 1]],
  medial: (lat) => [[-lat, 0, 0], [0, 0, 1]],
  ventral: () => [[0, 0, -1], [0, 1, 0]],
  dorsal: () => [[0, 0, 1], [0, 1, 0]],
  anterior: () => [[0, 1, 0], [0, 0, 1]],
  posterior: () => [[0, -1, 0], [0, 0, 1]],
};
export const VIEW_NAMES = Object.keys(VIEWS);

// Field of view of the panel's SHORTER side. Wide panels keep it vertically,
// narrow ones horizontally, so the brain keeps its size relative to the panel
// whichever way the window is resized (or the sidebar hidden).
const SHORT_SIDE_FOV = 30;

export class SurfaceViewer {
  // container: element the viewer panels go into.
  // hooks (all optional):
  //   paint(out, row)       fill a row's shared colour buffer (n*3, 0-1); row
  //                         is the index into load()'s `rows` (0 with one row)
  //   onCamera(v)           a panel's camera moved (by the user or a link)
  //   onHover(v, vertex)    pointer moved over a surface (-1 when off it)
  //   onClick(v, vertex, ev) a click (< 5 px of movement), left button
  //   onDragStart(v, ev)    return true to take the drag instead of rotating
  //   onDrag(v, ev), onDragEnd(v, ev)
  constructor(container, hooks = {}) {
    this.container = container;
    this.hooks = hooks;
    this.viewers = [];
    this.link = true;
    this.n = 0;
    this.coords = {};
    this.colorAttr = null;
    this.needsColor = false;
    // Per-surface display settings, by surface name. Kept across load(), so
    // opacity / mesh / hidden panels survive a subject switch.
    this.surfState = {};
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this._syncing = false;
    this._frame = () => this._animate();
    requestAnimationFrame(this._frame);
  }

  get colors() { return this.rows?.[0]?.colorAttr.array; }
  requestColor() { this.needsColor = true; }

  // surfaces: [[name, Float32Array coords], ...] left to right; faces: Int32Array.
  // rows: one name per row of panels, top to bottom (default: one unnamed row).
  // Every row shows every surface; each row has its own colour buffer, so
  // paint(out, row) can colour the rows differently (e.g. reference labels on
  // top, compared ones below). Cameras link across rows too. With more than
  // one row the rows go in `.viewer-row` divs and the container gets `.rows`.
  load(surfaces, faces, n, { rows = [null] } = {}) {
    for (const v of this.viewers) {
      v.controls.dispose();
      v.renderer.dispose();
      v.el.remove();
    }
    for (const r of this.container.querySelectorAll(":scope > .viewer-row")) r.remove();
    this.viewers = [];
    this.n = n;
    this.cursorVertex = -1;
    this.coords = Object.fromEntries(surfaces);
    const multi = rows.length > 1;
    this.container.classList.toggle("rows", multi);
    this.rows = rows.map((name) => {
      let el = this.container;
      if (multi) {
        el = document.createElement("div");
        el.className = "viewer-row";
        this.container.appendChild(el);
      }
      // hl: 0..1, how coloured a vertex is (0 = curvature grey): what the
      // x-ray pass shows through a see-through surface. Shared like the colours.
      return { name, el, colorAttr: new THREE.BufferAttribute(new Float32Array(n * 3), 3),
               hlAttr: new THREE.BufferAttribute(new Float32Array(n), 1) };
    });
    this.colorAttr = this.rows[0].colorAttr;
    this.hlAttr = this.rows[0].hlAttr;
    this.rows.forEach((row, r) => {
      for (const [surf, coords] of surfaces) this._makeViewer(surf, coords, faces, r);
    });
    this.requestColor();
  }

  _makeViewer(surf, coords, faces, r = 0) {
    const row = this.rows[r];
    const el = document.createElement("div");
    el.className = "viewer";
    el.innerHTML = `<div class="tag">${row.name ? `${row.name} · ` : ""}${surf}</div>`;
    row.el.appendChild(el);
    // preserveDrawingBuffer so snapshot() can read the canvas back.
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x0f1115);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(SHORT_SIDE_FOV, 1, 1, 5000);
    // A key light above-left of the camera plus a weak headlight: gyral crowns
    // catch the light, sulcal walls fall into shade, so depth reads naturally.
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    const head = new THREE.DirectionalLight(0xffffff, 0.45);
    camera.add(key, head);
    scene.add(camera, new THREE.AmbientLight(0xffffff, 0.35));

    const v = { surf, row: r, el, renderer, scene, camera, key, center: new THREE.Vector3(), radius: 100 };
    this._attachPointer(v); // before the controls, so a hook can veto a drag
    v.controls = new TrackballControls(camera, renderer.domElement);
    Object.assign(v.controls, { rotateSpeed: 3.0, zoomSpeed: 1.5, panSpeed: 0.8, staticMoving: true });
    v.controls.addEventListener("change", () => { this._syncFrom(v); this.hooks.onCamera?.(v); });
    new ResizeObserver(() => this.resize(v)).observe(el);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(coords, 3));
    geom.setAttribute("color", row.colorAttr); // one attribute object, shared by the row's meshes
    geom.setAttribute("hl", row.hlAttr);
    // Own copy per mesh: MeshBVH reorders the index in place, which would
    // invalidate the other mesh's tree if the buffer were shared.
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(faces), 1));
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    if (bvh) geom.boundsTree = new bvh.MeshBVH(geom);
    v.mesh = new THREE.Mesh(geom, new THREE.MeshPhongMaterial({
      vertexColors: true, side: THREE.DoubleSide, shininess: 14, specular: 0x202020 }));
    v.center.copy(geom.boundingSphere.center);
    v.radius = geom.boundingSphere.radius;
    v.controls.target.copy(v.center);
    camera.near = v.radius * 0.05;
    camera.far = v.radius * 20;
    camera.updateProjectionMatrix();
    key.position.set(-0.6, 0.8, 0.2).multiplyScalar(v.radius * 4);

    // Wireframe overlay on the same geometry, off by default.
    v.wire = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
      wireframe: true, color: 0x10131a, transparent: true, opacity: 0.18, depthWrite: false }));
    v.wire.visible = false;
    v.wire.renderOrder = 1;
    // Depth-only copy drawn first when the surface is see-through or the mesh
    // is on, so only the front layer shows (a glass shell, not an x-ray).
    v.depthPre = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ colorWrite: false }));
    v.depthPre.visible = false;
    v.depthPre.renderOrder = -1;

    // X-ray of the coloured vertices (clusters, labels, heatmap) that the
    // see-through front layer hides, e.g. a cluster down a sulcus on the pial.
    // Only where something is in front (GreaterDepth against the front layer's
    // depth), unlit, its strength rising as the surface opacity falls. The grey
    // surface itself stays one clean front layer.
    v.xray = new THREE.Mesh(geom, new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 0.6 } },
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `attribute float hl; varying vec3 vC; varying float vH;
        void main() { vC = color; vH = hl; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float opacity; varying vec3 vC; varying float vH;
        void main() { if (vH < 0.05) discard; gl_FragColor = vec4(vC, opacity * vH);
        #include <colorspace_fragment>
        }`,
    }));
    v.xray.material.depthFunc = THREE.GreaterDepth;
    // Pull the x-ray slightly toward the camera: on the front layer it then
    // always fails GreaterDepth instead of z-fighting with itself (labels
    // flashing while rotating). Buried layers are mm behind, far beyond this.
    Object.assign(v.xray.material, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    v.xray.visible = false;
    v.xray.renderOrder = 2;

    // The polyline (e.g. a contour) is drawn twice. Visible pass: depth-tested,
    // bright, 3 px (Line2: WebGL's own lines are always 1 px). Hidden pass:
    // only where the surface is in front (GreaterDepth), dim and dashed -- so
    // on the pial a stretch on a gyral crown reads differently from one
    // running down a sulcus.
    const pathColor = new THREE.Color(...PATH_COLOR);
    v.pathLine = new Line2(new LineGeometry(), new LineMaterial({
      color: pathColor, linewidth: 3, transparent: true }));
    v.pathHidden = new Line2(v.pathLine.geometry, new LineMaterial({
      color: pathColor, linewidth: 2, transparent: true, opacity: 0.45, depthWrite: false,
      dashed: true, dashSize: 1.2, gapSize: 1.0 }));
    v.pathHidden.material.depthFunc = THREE.GreaterDepth;
    v.pathLine.visible = v.pathHidden.visible = false;
    v.pathLine.renderOrder = v.pathHidden.renderOrder = 3;
    v.pointsObj = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      size: 9, sizeAttenuation: false, vertexColors: true, transparent: true }));
    v.pointsHidden = new THREE.Points(v.pointsObj.geometry, new THREE.PointsMaterial({
      size: 7, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.4,
      depthWrite: false }));
    v.pointsHidden.material.depthFunc = THREE.GreaterDepth;
    v.pointsObj.renderOrder = v.pointsHidden.renderOrder = 4;

    // Cursor marker (setCursor): a ring + cross sprite, bright where visible,
    // dim where the surface hides it. Separate from the path points above.
    const tex = cursorTexture();
    v.cursorObj = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      size: 26, sizeAttenuation: false, map: tex, color: 0xffffff, transparent: true, alphaTest: 0.05,
      depthWrite: false }));
    v.cursorHidden = new THREE.Points(v.cursorObj.geometry, new THREE.PointsMaterial({
      size: 22, sizeAttenuation: false, map: tex, color: 0xffffff, transparent: true, opacity: 0.35,
      depthWrite: false }));
    v.cursorHidden.material.depthFunc = THREE.GreaterDepth;
    v.cursorObj.renderOrder = v.cursorHidden.renderOrder = 5;
    v.cursorObj.visible = v.cursorHidden.visible = false;

    scene.add(v.depthPre, v.mesh, v.wire, v.xray, v.pathLine, v.pathHidden, v.pointsObj, v.pointsHidden,
              v.cursorObj, v.cursorHidden);
    this.viewers.push(v);
    const st = this.surfState[surf];
    if (st) {
      this.setOpacity(v, st.opacity ?? 1);
      this.setWire(v, !!st.wire);
      this.setXray(v, st.xray ?? true);
      this.setVisible(v, st.visible ?? true);
    }
    this.resize(v);
    return v;
  }

  resize(v) {
    const w = v.el.clientWidth, h = v.el.clientHeight;
    if (!w || !h) return;
    // Browser zoom changes devicePixelRatio; follow it so the canvas stays sharp.
    if (v.renderer.getPixelRatio() !== window.devicePixelRatio) {
      v.renderer.setPixelRatio(window.devicePixelRatio);
    }
    const aspect = w / h;
    const half = THREE.MathUtils.degToRad(SHORT_SIDE_FOV / 2);
    v.camera.fov = aspect >= 1 ? SHORT_SIDE_FOV
      : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) / aspect));
    v.renderer.setSize(w, h, false);
    v.pathLine.material.resolution.set(w, h);
    v.pathHidden.material.resolution.set(w, h);
    v.camera.aspect = w / h;
    v.camera.updateProjectionMatrix();
    v.controls.handleResize();
  }

  // Rotation, zoom and pan, each relative to the mesh's own size so inflated
  // and pial (different extents) stay framed the same way.
  _syncFrom(src) {
    if (!this.link || this._syncing) return;
    this._syncing = true;
    const dir = src.camera.position.clone().sub(src.controls.target);
    const rel = dir.length() / src.radius;
    dir.normalize();
    const pan = src.controls.target.clone().sub(src.center).divideScalar(src.radius);
    for (const v of this.viewers) {
      if (v === src) continue;
      v.controls.target.copy(v.center).addScaledVector(pan, v.radius);
      v.camera.position.copy(v.controls.target).addScaledVector(dir, rel * v.radius);
      v.camera.up.copy(src.camera.up);
      v.camera.lookAt(v.controls.target);
    }
    this._syncing = false;
  }

  // Distance at which the bounding sphere fits the narrower of the two fovs.
  _fitDistance(v) {
    const half = THREE.MathUtils.degToRad(v.camera.fov / 2);
    const hHalf = Math.atan(Math.tan(half) * v.camera.aspect);
    return (v.radius * 0.95) / Math.sin(Math.min(half, hHalf));
  }

  setView(name, hemi) {
    const [d, up] = VIEWS[name](hemi === "rh" ? 1 : -1);
    for (const v of this.viewers) {
      v.controls.target.copy(v.center);
      v.camera.position.copy(v.center).addScaledVector(new THREE.Vector3(...d), this._fitDistance(v));
      v.camera.up.set(...up);
      v.camera.lookAt(v.center);
    }
  }

  _state(v) { return (this.surfState[v.surf] ??= { visible: true, opacity: 1, wire: false, xray: true }); }

  // The camera as direction, up, zoom and pan relative to the mesh's own
  // size, so it can be put back on another subject (setViewState). Null
  // before anything is loaded.
  getViewState() {
    const v = this.viewers.find((x) => !x.el.classList.contains("hidden")) || this.viewers[0];
    if (!v) return null;
    const off = v.camera.position.clone().sub(v.controls.target);
    return {
      dir: off.clone().normalize().toArray(),
      rel: off.length() / v.radius,
      up: v.camera.up.toArray(),
      pan: v.controls.target.clone().sub(v.center).divideScalar(v.radius).toArray(),
    };
  }

  // mirrorX: the state came from the other hemisphere, so reflect it across
  // the midline (a lateral view of lh becomes a lateral view of rh).
  setViewState(st, mirrorX = false) {
    const m = (a) => (mirrorX ? [-a[0], a[1], a[2]] : a);
    const dir = new THREE.Vector3(...m(st.dir)), pan = new THREE.Vector3(...m(st.pan));
    for (const v of this.viewers) {
      v.controls.target.copy(v.center).addScaledVector(pan, v.radius);
      v.camera.position.copy(v.controls.target).addScaledVector(dir, st.rel * v.radius);
      v.camera.up.set(...m(st.up));
      v.camera.lookAt(v.controls.target);
    }
  }

  setVisible(v, on) {
    this._state(v).visible = on;
    v.el.classList.toggle("hidden", !on);
    this.resize(v);
  }

  // Below 1 the front layer turns see-through (the background shows behind
  // it). Depth is still written, so hidden polyline stretches stay dashed and
  // buried layers don't smear into one flat grey.
  setOpacity(v, a) {
    this._state(v).opacity = a;
    const m = v.mesh.material;
    m.opacity = a;
    m.transparent = a < 1;
    m.needsUpdate = true;
    this._syncDepthPre(v);
    this._syncXray(v);
  }
  // Show coloured vertices hidden behind a see-through surface (opacity < 1).
  setXray(v, on) { this._state(v).xray = on; this._syncXray(v); }
  _syncXray(v) {
    const st = this._state(v), a = v.mesh.material.opacity;
    v.xray.visible = (st.xray ?? true) && a < 1;
    v.xray.material.uniforms.opacity.value = Math.min(0.9, 0.15 + 0.85 * (1 - a));
  }
  setWire(v, on) { this._state(v).wire = on; v.wire.visible = on; this._syncDepthPre(v); }
  _syncDepthPre(v) { v.depthPre.visible = v.wire.visible || v.mesh.material.opacity < 1; }

  // One row per surface: show / opacity / mesh. Returns the container.
  // With several rows, one control row per surface drives it in every row.
  surfaceControls(box) {
    box.innerHTML = "";
    for (const v of this.viewers.filter((x) => x.row === 0)) {
      const each = (fn) => () => { for (const x of this.viewers) if (x.surf === v.surf) fn(x); };
      const row = document.createElement("div");
      row.className = "row";
      const st = this._state(v);
      row.innerHTML = `<label class="surf-name"><input type="checkbox" ${st.visible ? "checked" : ""}> ${v.surf}</label>
        <input type="range" min="0.05" max="1" step="0.05" value="${st.opacity}" title="surface opacity">
        <label title="triangle mesh overlay; zoom in to see individual edges"><input type="checkbox" ${st.wire ? "checked" : ""}> mesh</label>
        <label title="below full opacity, show clusters / labels hidden behind the surface (e.g. down a sulcus); lower opacity = stronger"><input type="checkbox" ${st.xray ?? true ? "checked" : ""}> x-ray</label>`;
      const [show, alpha, mesh, xray] = row.querySelectorAll("input");
      xray.onchange = each((x) => this.setXray(x, xray.checked));
      show.onchange = each((x) => this.setVisible(x, show.checked));
      alpha.oninput = each((x) => this.setOpacity(x, +alpha.value));
      mesh.onchange = each((x) => this.setWire(x, mesh.checked));
      box.appendChild(row);
    }
    return box;
  }

  // Draw a polyline through `path` (vertex indices) and markers at `points`;
  // `pointColors` is one [r,g,b] (0-1) per point. showHidden draws the
  // occluded stretches dashed.
  setPath(path, points = [], pointColors = [], showHidden = true) {
    for (const v of this.viewers) {
      const c = this.coords[v.surf];
      const nrm = v.mesh.geometry.attributes.normal.array;
      const lift = (idx, out, k) => {
        for (let d = 0; d < 3; d++) out[3 * k + d] = c[3 * idx + d] + nrm[3 * idx + d] * 0.4;
      };
      v.pathLine.visible = path.length >= 2;
      v.pathHidden.visible = v.pathLine.visible && showHidden;
      if (v.pathLine.visible) {
        const lp = new Float32Array(path.length * 3);
        path.forEach((idx, k) => lift(idx, lp, k));
        // A fresh geometry each time: LineGeometry can't shrink its buffers.
        v.pathLine.geometry.dispose();
        const g = new LineGeometry();
        g.setPositions(lp);
        v.pathLine.geometry = v.pathHidden.geometry = g;
        v.pathLine.computeLineDistances();
      }
      const pp = new Float32Array(points.length * 3);
      const pc = new Float32Array(points.length * 3);
      points.forEach((idx, k) => { lift(idx, pp, k); pc.set(pointColors[k] || PATH_COLOR, 3 * k); });
      v.pointsObj.geometry.setAttribute("position", new THREE.BufferAttribute(pp, 3));
      v.pointsObj.geometry.setAttribute("color", new THREE.BufferAttribute(pc, 3));
      v.pointsObj.geometry.computeBoundingSphere();
      v.pointsHidden.visible = showHidden;
    }
  }

  // A cursor marker at vertex `vi` on every panel (the same vertex on each
  // surface); -1 hides it. `color` is a CSS colour.
  setCursor(vi, color = "#39ff88") {
    this.cursorVertex = vi;
    for (const v of this.viewers) {
      const on = vi >= 0 && vi < this.n;
      v.cursorObj.visible = v.cursorHidden.visible = on;
      if (!on) continue;
      const c = this.coords[v.surf], nrm = v.mesh.geometry.attributes.normal.array;
      const p = new Float32Array(3);
      for (let d = 0; d < 3; d++) p[d] = c[3 * vi + d] + nrm[3 * vi + d] * 0.6;
      v.cursorObj.geometry.setAttribute("position", new THREE.BufferAttribute(p, 3));
      v.cursorObj.geometry.computeBoundingSphere();
      v.cursorObj.material.color.set(color);
      v.cursorHidden.material.color.set(color);
    }
  }

  pick(v, ev) {
    const r = v.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1,
                                  -((ev.clientY - r.top) / r.height) * 2 + 1);
    v.camera.updateMatrixWorld(); // may be stale if no frame rendered since the last move
    this.raycaster.setFromCamera(ndc, v.camera);
    const hit = this.raycaster.intersectObject(v.mesh, false)[0];
    if (!hit) return -1;
    const c = this.coords[v.surf];
    let best = -1, bd = Infinity;
    for (const idx of [hit.face.a, hit.face.b, hit.face.c]) {
      const dx = c[3 * idx] - hit.point.x, dy = c[3 * idx + 1] - hit.point.y,
            dz = c[3 * idx + 2] - hit.point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = idx; }
    }
    return best;
  }

  _attachPointer(v) {
    const el = v.renderer.domElement;
    const h = this.hooks;
    let down = null, dragging = false;
    el.addEventListener("pointerdown", (ev) => {
      down = { x: ev.clientX, y: ev.clientY, button: ev.button };
      if (ev.button === 0 && h.onDragStart?.(v, ev)) {
        dragging = true;
        v.controls.enabled = false;
      }
    }, { capture: true });
    el.addEventListener("pointermove", (ev) => {
      if (dragging) { h.onDrag?.(v, ev); return; }
      if (!down) h.onHover?.(v, this.pick(v, ev), ev);
    });
    el.addEventListener("pointerup", (ev) => {
      if (dragging) {
        dragging = false;
        v.controls.enabled = true;
        h.onDragEnd?.(v, ev);
      } else if (down && down.button === 0 &&
                 Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 5) {
        h.onClick?.(v, this.pick(v, ev), ev);
      }
      down = null;
    });
    el.addEventListener("pointerleave", () => { if (!dragging) down = null; });
  }

  _animate() {
    if (this.needsColor && this.rows?.length) {
      this.needsColor = false;
      this.rows.forEach((row, k) => {
        this.hooks.paint?.(row.colorAttr.array, k);
        row.colorAttr.needsUpdate = true;
        // How coloured each vertex is (0 = grey; curvature is always r = g = b),
        // ramped so faint tints (a heatmap fading below threshold) don't x-ray as haze.
        const c = row.colorAttr.array, hl = row.hlAttr.array;
        for (let i = 0; i < this.n; i++) {
          const r = c[3 * i], g = c[3 * i + 1], b = c[3 * i + 2];
          hl[i] = Math.min(1, Math.max(0, (Math.max(r, g, b) - Math.min(r, g, b) - 0.04) / 0.16));
        }
        row.hlAttr.needsUpdate = true;
      });
    }
    for (const v of this.viewers) {
      if (v.el.classList.contains("hidden")) continue;
      v.controls.update();
      v.renderer.render(v.scene, v.camera);
    }
    requestAnimationFrame(this._frame);
  }

  // PNG (data URL) of every visible panel as on screen: side by side, rows
  // stacked.
  snapshot() {
    const shown = this.viewers.filter((v) => !v.el.classList.contains("hidden"));
    for (const v of shown) v.renderer.render(v.scene, v.camera);
    const rows = (this.rows || [null]).map((_, r) =>
      shown.filter((v) => (v.row ?? 0) === r).map((v) => v.renderer.domElement)).filter((r) => r.length);
    const out = document.createElement("canvas");
    out.width = Math.max(0, ...rows.map((cs) => cs.reduce((s, c) => s + c.width, 0)));
    out.height = rows.reduce((s, cs) => s + Math.max(...cs.map((c) => c.height)), 0);
    const ctx = out.getContext("2d");
    let y = 0;
    for (const cs of rows) {
      let x = 0;
      for (const c of cs) { ctx.drawImage(c, x, y); x += c.width; }
      y += Math.max(...cs.map((c) => c.height));
    }
    return out.toDataURL("image/png");
  }
}
