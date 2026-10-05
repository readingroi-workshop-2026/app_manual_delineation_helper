// Surface viewer engine: one hemisphere shown on several surfaces (inflated,
// pial, ...) side by side, with linked cameras.
//
// All surfaces of a hemisphere share vertex indices, so the engine keeps ONE
// per-vertex colour buffer that every mesh renders; an app paints into it
// (`paint(out)`) and everything it draws shows on every surface at once.
//
// This file is shared: app_manual_delineation_helper vendors a copy under
// static/vendor/surface_annotate/. Keep it free of app-specific UI and state.

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

// Two-tone FreeSurfer curvature: sulci (curv > 0) dark, gyri light.
export function paintCurvature(out, curv, n, on = true) {
  for (let i = 0; i < n; i++) {
    const g = curv && on ? (curv[i] > 0 ? 0.46 : 0.72) : 0.6;
    out[3 * i] = out[3 * i + 1] = out[3 * i + 2] = g;
  }
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
  //   paint(out)            fill the shared colour buffer (n*3, 0-1)
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

  get colors() { return this.colorAttr?.array; }
  requestColor() { this.needsColor = true; }

  // surfaces: [[name, Float32Array coords], ...] left to right; faces: Int32Array.
  load(surfaces, faces, n) {
    for (const v of this.viewers) {
      v.controls.dispose();
      v.renderer.dispose();
      v.el.remove();
    }
    this.viewers = [];
    this.n = n;
    this.coords = Object.fromEntries(surfaces);
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    for (const [surf, coords] of surfaces) this._makeViewer(surf, coords, faces);
    this.requestColor();
  }

  _makeViewer(surf, coords, faces) {
    const el = document.createElement("div");
    el.className = "viewer";
    el.innerHTML = `<div class="tag">${surf}</div>`;
    this.container.appendChild(el);
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

    const v = { surf, el, renderer, scene, camera, key, center: new THREE.Vector3(), radius: 100 };
    this._attachPointer(v); // before the controls, so a hook can veto a drag
    v.controls = new TrackballControls(camera, renderer.domElement);
    Object.assign(v.controls, { rotateSpeed: 3.0, zoomSpeed: 1.5, panSpeed: 0.8, staticMoving: true });
    v.controls.addEventListener("change", () => this._syncFrom(v));
    new ResizeObserver(() => this.resize(v)).observe(el);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(coords, 3));
    geom.setAttribute("color", this.colorAttr); // one attribute object, shared by every mesh
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

    scene.add(v.depthPre, v.mesh, v.wire, v.pathLine, v.pathHidden, v.pointsObj, v.pointsHidden);
    this.viewers.push(v);
    const st = this.surfState[surf];
    if (st) {
      this.setOpacity(v, st.opacity ?? 1);
      this.setWire(v, !!st.wire);
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

  _state(v) { return (this.surfState[v.surf] ??= { visible: true, opacity: 1, wire: false }); }

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
  }
  setWire(v, on) { this._state(v).wire = on; v.wire.visible = on; this._syncDepthPre(v); }
  _syncDepthPre(v) { v.depthPre.visible = v.wire.visible || v.mesh.material.opacity < 1; }

  // One row per surface: show / opacity / mesh. Returns the container.
  surfaceControls(box) {
    box.innerHTML = "";
    for (const v of this.viewers) {
      const row = document.createElement("div");
      row.className = "row";
      const st = this._state(v);
      row.innerHTML = `<label class="surf-name"><input type="checkbox" ${st.visible ? "checked" : ""}> ${v.surf}</label>
        <input type="range" min="0.05" max="1" step="0.05" value="${st.opacity}" title="surface opacity">
        <label title="triangle mesh overlay; zoom in to see individual edges"><input type="checkbox" ${st.wire ? "checked" : ""}> mesh</label>`;
      const [show, alpha, mesh] = row.querySelectorAll("input");
      show.onchange = () => this.setVisible(v, show.checked);
      alpha.oninput = () => this.setOpacity(v, +alpha.value);
      mesh.onchange = () => this.setWire(v, mesh.checked);
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
    if (this.needsColor && this.colorAttr) {
      this.needsColor = false;
      this.hooks.paint?.(this.colorAttr.array);
      this.colorAttr.needsUpdate = true;
    }
    for (const v of this.viewers) {
      if (v.el.classList.contains("hidden")) continue;
      v.controls.update();
      v.renderer.render(v.scene, v.camera);
    }
    requestAnimationFrame(this._frame);
  }

  // PNG (data URL) of every visible panel side by side, as on screen.
  snapshot() {
    const shown = this.viewers.filter((v) => !v.el.classList.contains("hidden"));
    for (const v of shown) v.renderer.render(v.scene, v.camera);
    const canvases = shown.map((v) => v.renderer.domElement);
    const out = document.createElement("canvas");
    out.width = canvases.reduce((s, c) => s + c.width, 0);
    out.height = Math.max(0, ...canvases.map((c) => c.height));
    const ctx = out.getContext("2d");
    let x = 0;
    for (const c of canvases) { ctx.drawImage(c, x, 0); x += c.width; }
    return out.toDataURL("image/png");
  }
}
