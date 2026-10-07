// Delineation helper — view heatmaps, auto clusters, atlas and manual labels
// on inflated + pial side by side (the surface engine in static/engine/), and
// draw labels on top of them: Contour (paths + FreeView-style seeded fill),
// Brush and Erase, saved to <sub>/label/<folder>/.
//
// Everything is painted into the engine's one per-vertex colour buffer, so
// each layer shows on both surfaces, and every toggle is applied in the
// browser immediately — the server only hands out files (and saves drawn ones).

import { SurfaceViewer, PATH_COLOR, blend, paintCurvature, curvatureControls } from "./engine/viewer.js";
import * as M from "./engine/mesh.js";
import * as D from "./draw.js";

const $ = (id) => document.getElementById(id);
const KINDS = ["clusters", "atlas", "manual", "compare"];
const CUSTOM = "__custom__";
// /compare: within-subject QC. Two rows of panels: the reference labels (layer
// 4, "manual") on top, the compared ones (layer 5, "compare") below; the
// heatmap, clusters, atlas labels and drawn labels show in both rows, and
// drawing in either row edits the same labels.
const PAGE = location.pathname.replace(/\/+$/, "") === "/compare" ? "compare" : "single";
const COMPARE = PAGE === "compare";
const LABEL_KINDS = ["atlas", "manual", "compare"];   // folder-of-labels layers

const S = {
  session: null, meta: null,
  sub: null, hemi: "lh", n: 0, adj: null, curv: null, curvOn: true, curvOpts: {},
  cursorOn: true,       // Navigate: a click places the cursor (ring + cross) on every surface
  cursorV: -1,
  templates: {},        // layer -> folder template ({sub} allowed)
  heat: null,           // {name, values, min, max}
  heatAlpha: 0.85,
  heatTT: true,         // transparent thresholding (Taylor et al. 2026), see paintHeat
  heatOutline: true,    // outline the suprathreshold vertices
  thresholds: {},       // heatmap name -> threshold, kept across subjects
  items: new Map(),     // `${kind}:${name}` -> loaded label/annot layer
  colors: {},           // `${kind}:${name}` -> [r,g,b], kept across subjects
  clusterFill: false,
  fillAlpha: 0.6,
  open: new Set(),      // expanded contrast / annot rows
  highlight: null,      // item key hovered in the legend: drawn filled
  // Drawing (Contour / Brush / Erase tabs)
  coords: {},           // surface name -> Float32Array, for paths and the brush
  tool: "navigate", drawMode: "add", clickMode: "path", radius: 2,
  seedFill: false, showHidden: true, pathSurface: null,
  contour: { points: [], cursor: "tail", awaitingSeed: null, path: [] },
  drawFolder: "", drawDir: "",
  drawn: new Map(),     // name -> {mask, visible, dirty}; colours via colorFor("drawn", name)
  active: null,
  drawAlpha: 0.45,
  undo: [],
};
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const isDirty = () => [...S.drawn.values()].some((l) => l.dirty);

// ---------------------------------------------------------------- utilities
async function api(path, opts) {
  const r = await fetch(`/api/${path}`, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(`${r.status}: ${msg}`);
  }
  return r;
}
const getJSON = async (p) => (await api(p)).json();
const getBin = async (p, T) => new T(await (await api(p)).arrayBuffer());
const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "")).toString();
function status(msg, bad = false) {
  $("status").textContent = msg;
  $("status").title = msg;
  $("status").style.color = bad ? "var(--danger)" : "";
}
const rgbHex = (c) => "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const b64ToInt32 = (s) => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int32Array(bytes.buffer);
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const key = (kind, name) => `${kind}:${name}`;

// Fixed colour for word-ROI names (IOG, PON, pOTS, mOTS, mFus), else the next
// palette colour; remembered per layer + name so re-ticking brings it back.
let paletteNext = 0;
function colorFor(kind, name) {
  const k = key(kind, name);
  if (!S.colors[k]) {
    const low = name.toLowerCase();
    // Landmarks by exact name (aparc.a2009s colours), then word ROIs by substring.
    const anat = S.session.anat_colors?.[low.replace(/^aparc\./, "")];
    const roi = Object.entries(S.session.roi_colors).find(([r]) => low.includes(r));
    const pal = S.session.cluster_colors;
    S.colors[k] = hexRgb(anat || (roi ? roi[1] : pal[paletteNext++ % pal.length]));
  }
  return S.colors[k];
}

// ---------------------------------------------------------------- engine
const isPaintTool = () => S.tool === "brush" || S.tool === "erase";
const view = new SurfaceViewer($("viewers"), {
  paint,
  onHover: hoverAt,
  onClick: clickAt,
  // Shift+drag with the brush paints instead of rotating.
  onDragStart: (v, ev) => {
    if (!(isPaintTool() && ev.shiftKey && ensureActive())) return false;
    beginStroke();
    paintAt(v, view.pick(v, ev));
    return true;
  },
  onDrag: (v, ev) => paintAt(v, view.pick(v, ev)),
  onDragEnd: () => endStroke(),
});
window.delineationHelper = { S, view }; // for the devtools console

// Red -> orange -> yellow, from the threshold up to the map's maximum.
const HEAT = [[190, 25, 0], [255, 120, 0], [255, 235, 60]];
function heatColor(t) {
  const x = Math.min(1, Math.max(0, t)) * 2;
  const [a, b] = x < 1 ? [HEAT[0], HEAT[1]] : [HEAT[1], HEAT[2]];
  const f = x < 1 ? x : x - 1;
  return [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * f);
}

// Compare page: the row showing the Save-to folder (0 ref, 1 compare), or
// null for both.
function drawRow() {
  if (!COMPARE || !S.meta) return null;
  if (S.meta.layers.manual.dir === S.drawDir) return 0;
  if (S.meta.layers.compare.dir === S.drawDir) return 1;
  return null;
}

// row: 0, or on the compare page 0 = top (reference) / 1 = bottom (compare).
function paint(out, row = 0) {
  const n = S.n;
  paintCurvature(out, S.curv, n, S.curvOn, S.curvOpts);
  if (S.heat) paintHeat(out);
  // Layer order: clusters, then atlas (annots under labels), then manual /
  // compare -- the reference labels only in the top row, compared ones below.
  for (const kind of KINDS) {
    if (kind === "manual" && row === 1) continue;
    if (kind === "compare" && row !== 1) continue;
    const items = [...S.items.values()].filter((it) => it.kind === kind && it.on && !it.hidden);
    for (const it of items.filter((x) => x.type === "annot")) {
      const { labels, colors, regions, boundary } = it;
      for (let i = 0; i < n; i++) {
        const k = labels[i];
        if (k < 0 || !regions[k]) continue;
        if (boundary[i]) blend(out, i, colors[k], 0.95);
        else if (it.fill) blend(out, i, colors[k], S.fillAlpha);
      }
    }
    for (const it of items.filter((x) => x.type === "label")) {
      const color = colorFor(kind, it.name);
      const lit = S.highlight === key(kind, it.name);
      const fill = lit || (kind === "clusters" ? S.clusterFill : it.fill);
      if (fill) for (const i of it.verts) blend(out, i, color, lit ? 0.85 : S.fillAlpha);
      for (const i of it.outline) blend(out, i, color, 1);
    }
  }
  // What you draw goes on top, then the path being drawn. On the compare page
  // only in the row whose folder it saves to (both if neither).
  const dRow = drawRow();
  for (const [name, l] of S.drawn) {
    if (dRow !== null && dRow !== row) break;
    if (!l.visible) continue;
    const color = colorFor("drawn", name);
    const a = name === S.active ? Math.min(1, S.drawAlpha + 0.1) : S.drawAlpha;
    const edge = M.maskOutline(S.adj, l.mask);
    for (let i = 0; i < n; i++) {
      if (edge[i]) blend(out, i, color, 1);
      else if (l.mask[i] && a > 0) blend(out, i, color, a);
    }
  }
  for (const i of S.contour.awaitingSeed || S.contour.path) out.set(PATH_COLOR, 3 * i);
}

// Transparent thresholding — Taylor PA, Aggarwal H, Bandettini PA (2026),
// "Go figure: transparency in neuroscience images preserves context and
// clarifies interpretation", Nature Methods, doi:10.1038/s41592-026-03206-7.
// Instead of hiding everything below the threshold, colour the whole map by
// value (0 -> max), keep suprathreshold vertices opaque and outlined, and let
// subthreshold ones fade out quadratically, opacity (v / thr)^2. Unticked, the
// map is the classic hard cut: only v > thr, coloured from thr to max.
function paintHeat(out) {
  const { values, max } = S.heat;
  const n = S.n, thr = currentThreshold();
  if (S.heatTT) {
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!(v > 0)) continue;
      const a = v > thr ? 1 : (v / thr) ** 2;
      blend(out, i, heatColor(v / max), S.heatAlpha * a);
    }
  } else {
    const span = max - thr || 1;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v > thr) blend(out, i, heatColor((v - thr) / span), S.heatAlpha);
    }
  }
  if (S.heatOutline) {
    const supra = Uint8Array.from(values, (v) => (v > thr ? 1 : 0));
    const edge = M.maskOutline(S.adj, supra);
    // Dark, not the paper's white: on a mesh the outline is a whole ring of
    // vertices, and white rings wash out small blobs on a speckled map.
    for (let i = 0; i < n; i++) if (edge[i]) blend(out, i, [20, 20, 20], 0.85);
  }
}

// Surfaces whose coordinates are positions in the brain. The inflated (and
// sphere) meshes are not: inflating moves every vertex, so their x, y, z mean
// nothing anatomically (x = 4.8 for a left-hemisphere vertex, say).
const ANATOMICAL = ["pial", "white", "smoothwm", "midthickness", "orig"];

function hoverAt(v, vi) {
  if (vi < 0) { $("hover").textContent = ""; return; }
  // Always report an anatomical position, whichever panel is hovered.
  const anat = Object.keys(view.coords).filter((s) => ANATOMICAL.includes(s));
  $("hover").textContent = describe(vi, anat.length ? [anat[0]] : [v.surf]).join("  ·  ");
}

// What is at vertex vi: coordinates on `surfs` (x, y, z in surface RAS),
// curvature, heatmap, labels.
function describe(vi, surfs) {
  const parts = [`vertex ${vi}`];
  for (const surf of surfs) {
    const c = view.coords[surf];
    if (!c) continue;
    const xyz = `(${c[3 * vi].toFixed(1)}, ${c[3 * vi + 1].toFixed(1)}, ${c[3 * vi + 2].toFixed(1)})`;
    parts.push(ANATOMICAL.includes(surf) ? `${surf} x,y,z ${xyz}`
                                         : `${surf} mesh ${xyz} (not anatomical)`);
  }
  if (S.curv) parts.push(`curv ${S.curv[vi].toFixed(3)}`);
  if (S.heat) parts.push(`${S.heat.name}: ${S.heat.values[vi].toFixed(3)}`);
  for (const it of S.items.values()) {
    if (!it.on || it.hidden) continue;
    if (it.type === "annot") {
      const k = it.labels[vi];
      parts.push(`${it.name}: ${k >= 0 ? it.names[k] : "—"}`);
    } else if (it.mask[vi]) parts.push(it.name);
  }
  const inDrawn = [...S.drawn].filter(([, l]) => l.mask[vi]).map(([n]) => n);
  if (inDrawn.length) parts.push(`drawn: ${inDrawn.join(", ")}`);
  return parts;
}

// ---------------------------------------------------------------- cursor
// Navigate mode: a click puts a cursor (ring + cross) on that vertex, on every
// surface panel at once, so you can see where the same point is on inflated and pial.
function placeCursor(vi) {
  S.cursorV = vi;
  view.setCursor(S.cursorOn ? vi : -1);
  showCursorInfo();
}
function showCursorInfo() {
  const box = $("cursor-info");
  if (S.cursorV < 0 || !S.cursorOn) {
    box.textContent = S.cursorOn ? "Click the surface to place the cursor." : "Cursor hidden.";
    return;
  }
  const vi = S.cursorV;
  box.innerHTML = describe(vi, Object.keys(view.coords)).map((t) => `<div>${t}</div>`).join("") +
    `<div class="t1w" id="cursor-t1w">T1w: …</div>`;
  // Inflated has no meaning in the T1w: report the vertex on white and pial.
  getJSON(`${S.sub}/${S.hemi}/t1w/${vi}`).then((d) => {
    const el = $("cursor-t1w");
    if (!el || S.cursorV !== vi) return; // moved on meanwhile
    const f = (a) => a.map((x) => x.toFixed(1)).join(", ");
    // Everything in x, y, z order. The raw file index of a conformed .mgz is
    // stored L, I, A (x, z, y and flipped), so it is shown apart and labelled.
    el.innerHTML = `<b>T1w space</b> <span class="dim">(x, y, z · scanner RAS via ${d.transform})</span>` +
      Object.entries(d.surfaces).map(([surf, e]) =>
        `<div>${surf}: RAS (${f(e.scanner)})${e.voxel ? ` · voxel x,y,z [${e.voxel.join(", ")}]` : ""}` +
        (e.voxel_file ? `<div class="dim">&nbsp;&nbsp;${d.volume} file index [${e.voxel_file.join(", ")}] (${d.file_axes} order, as in Freeview)</div>` : "") +
        `</div>`).join("");
  }).catch((e) => { const el = $("cursor-t1w"); if (el) el.textContent = `T1w: ${e.message}`; });
}

// ---------------------------------------------------------------- drawing
function clickAt(v, vi) {
  if (S.tool === "navigate") { if (vi >= 0 && S.cursorOn) placeCursor(vi); return; }
  if (vi < 0) return;
  if (!ensureActive()) return;
  if (S.tool === "contour") {
    if (S.contour.awaitingSeed) { commitContour(vi); return; }
    if (S.clickMode === "fill") { seedFill(vi); return; }
    const pts = S.contour.points;
    if (S.contour.cursor === "tail") pts.push(vi); else pts.unshift(vi);
    updateContour();
  } else {
    beginStroke();
    paintAt(v, vi);
    endStroke();
  }
}

function pushUndo(name) {
  S.undo.push({ name, mask: S.drawn.get(name).mask.slice() });
  if (S.undo.length > 60) S.undo.shift();
}
function undo() {
  const u = S.undo.pop();
  if (!u) { status("Nothing to undo"); return; }
  const l = S.drawn.get(u.name);
  if (!l) return;
  l.mask = u.mask; l.dirty = true;
  renderDrawn();
  status(`Undid last edit on ${u.name}`);
}
// Replace the active label's mask (one undo step) and report the change.
function setMask(mask, what) {
  const l = S.drawn.get(S.active);
  let before = 0, after = 0;
  for (let i = 0; i < S.n; i++) { before += l.mask[i]; after += mask[i]; }
  if (before === after && l.mask.every((x, i) => x === mask[i])) { status(`${what}: nothing changed`); return; }
  pushUndo(S.active);
  l.mask = mask; l.dirty = true;
  renderDrawn();
  status(`${what}: ${S.active} ${before.toLocaleString()} → ${after.toLocaleString()} vertices`);
}

let strokeOpen = false;
function beginStroke() { if (S.active) { pushUndo(S.active); strokeOpen = true; } }
function endStroke() {
  if (!strokeOpen) return;
  strokeOpen = false;
  S.drawn.get(S.active).dirty = true;
  renderDrawn();
}
function paintAt(v, vi) {
  if (vi < 0 || !S.active) return;
  const l = S.drawn.get(S.active);
  const val = S.tool === "erase" ? 0 : 1;
  for (const w of M.brush(S.adj, S.coords[v.surf], vi, S.radius)) l.mask[w] = val;
  view.requestColor();
}

const contourPath = (closed) => M.tracePath(S.adj, S.coords[S.pathSurface], S.contour.points, closed);

function updateContour() {
  const path = contourPath(false);
  const pts = S.contour.points;
  const colors = pts.map((_, k) => {
    const cursorEnd = S.contour.cursor === "tail" ? k === pts.length - 1 : k === 0;
    return cursorEnd ? [1, 0.3, 0.3] : PATH_COLOR;
  });
  view.setPath(path, pts, colors, S.showHidden);
  S.contour.path = path;
  view.requestColor();
  const n = pts.length;
  const cutHint = n >= 2 && S.clickMode === "path" && $("c-path").checked && !S.contour.awaitingSeed
    ? " — to cut a region: run both ends past its edge, press F, click the side to fill" : "";
  if (n) status(`Path: ${n} point${n > 1 ? "s" : ""}, adding at ${S.contour.cursor}` +
                (S.contour.awaitingSeed ? " — click inside the region" : cutHint));
}

function closeContour() {
  if (S.contour.points.length < 3) { status("A closed path needs at least 3 points", true); return; }
  if (!ensureActive()) return;
  if (S.seedFill) {
    S.contour.awaitingSeed = contourPath(true);
    status("Click a vertex inside the path to fill that side");
    return;
  }
  commitContour(-1);
}

function applyFill(fill, what) {
  const l = S.drawn.get(S.active);
  const add = S.drawMode === "add";
  const mask = l.mask.slice();
  for (let i = 0; i < S.n; i++) if (fill[i]) mask[i] = add ? 1 : 0;
  setMask(mask, `${what} (${add ? "add" : "remove"})`);
}

function commitContour(seed) {
  const loop = S.contour.awaitingSeed || contourPath(true);
  applyFill(M.fillLoop(S.adj, loop, seed), "Closed path");
  clearContour();
}

function clearContour() {
  S.contour = { points: [], cursor: "tail", awaitingSeed: null, path: [] };
  updateContour();
}

// The heatmap / curvature conditions as a 0/1 mask (null when neither is on).
function valueMask() {
  const heat = $("c-heat").checked, curv = $("c-curv").value;
  if (!heat && curv === "any") return null;
  if (heat && !S.heat) throw new Error("pick a map in Navigate › 1 · Heatmap first (or untick “inside the thresholded map”)");
  if (curv !== "any" && !S.curv) throw new Error("this subject has no curvature file");
  const ok = new Uint8Array(S.n).fill(1);
  const thr = currentThreshold();
  for (let i = 0; i < S.n; i++) {
    if (heat && !(S.heat.values[i] > thr)) ok[i] = 0;
    else if (curv === "sulci" && !(S.curv[i] > 0)) ok[i] = 0;
    else if (curv === "gyri" && !(S.curv[i] < 0)) ok[i] = 0;
  }
  return ok;
}

// Every shown layer label containing `seed`, and the seed's region of every
// shown annot, as one 0/1 mask (null when the seed is in none of them).
function regionAt(seed) {
  const ok = new Uint8Array(S.n);
  let found = false;
  for (const it of S.items.values()) {
    if (!it.on || it.hidden) continue;
    if (it.type === "label" && it.mask[seed]) {
      for (const i of it.verts) ok[i] = 1;
      found = true;
    } else if (it.type === "annot") {
      const k = it.labels[seed];
      if (k < 0 || !it.regions[k]) continue;
      for (let i = 0; i < S.n; i++) if (it.labels[i] === k) ok[i] = 1;
      found = true;
    }
  }
  return found ? ok : null;
}

// FreeView's custom fill: flood from the clicked vertex, bounded by the ticked
// conditions, then add it to (or remove it from) the active label.
const SNAP_MM = 3; // a fill click this close to a passing vertex still counts
function seedFill(seed) {
  let snapped = "";
  let allowed;
  try { allowed = valueMask() || new Uint8Array(S.n).fill(1); }
  catch (e) { status(`Fill: ${e.message}`, true); return; }
  if ($("c-inside").checked) {
    const region = regionAt(seed);
    if (!region) { status("Fill: the click is not inside a shown layer label or annot region", true); return; }
    for (let i = 0; i < S.n; i++) allowed[i] &= region[i];
  }
  if ($("c-others").checked) {
    for (const [name, l] of S.drawn) {
      if (name === S.active) continue;
      for (let i = 0; i < S.n; i++) if (l.mask[i]) allowed[i] = 0;
    }
  }
  let barrier = null;
  if ($("c-path").checked && S.contour.points.length >= 2) {
    // The wall is the path exactly as drawn: OPEN, a line. (It used to be closed
    // last -> first once it had 3 points, which cut a big region a second time.)
    // Enter still closes the path and fills the loop.
    barrier = new Uint8Array(S.n);
    for (const i of contourPath(false)) barrier[i] = 1;
  }
  if (!allowed[seed]) {
    // A click just outside a blob (e.g. on its faded, below-threshold rim):
    // snap to the nearest vertex that passes, within SNAP_MM on the anatomy.
    const coords = S.coords.pial || S.coords.white || S.coords[S.pathSurface];
    let best = -1, bd = Infinity;
    for (const w of M.brush(S.adj, coords, seed, SNAP_MM)) {
      if (!allowed[w] || barrier?.[w]) continue;
      const d = Math.hypot(coords[3 * w] - coords[3 * seed], coords[3 * w + 1] - coords[3 * seed + 1],
                           coords[3 * w + 2] - coords[3 * seed + 2]);
      if (d < bd) { bd = d; best = w; }
    }
    if (best < 0) {
      const why = $("c-heat").checked && S.heat
        ? `${S.heat.name} is ${S.heat.values[seed].toPrecision(3)} here, not above ${+currentThreshold().toPrecision(4)}, and nothing above it within ${SNAP_MM} mm`
        : "the clicked vertex fails the conditions";
      status(`Fill: ${why}`, true);
      return;
    }
    snapped = ` (you clicked vertex ${seed}, below the bound; snapped ${bd.toFixed(1)} mm)`;
    seed = best;
  }
  if (barrier?.[seed]) { status("Fill: click beside the path, not on it", true); return; }
  const fill = D.floodFill(S.adj, seed, allowed, barrier);
  let count = 0;
  for (let i = 0; i < S.n; i++) count += fill[i];
  // Did the path actually cut the region? If the fill reaches everything the
  // region holds off the path, the flood went round an end of the path.
  let leak = "";
  if (barrier) {
    const whole = D.floodFill(S.adj, seed, allowed, null);
    let missed = 0;
    for (let i = 0; i < S.n; i++) if (whole[i] && !barrier[i] && !fill[i]) missed++;
    if (!missed) leak = " — the path does not split this region (the fill went round an end): extend both ends past its edge";
  }
  if (count > S.n * 0.25 &&
      !confirm(`This fill covers ${count.toLocaleString()} vertices (${Math.round((100 * count) / S.n)}% ` +
               "of the hemisphere) — nothing bounds it. Apply anyway?")) {
    status("Fill cancelled");
    return;
  }
  applyFill(fill, `Fill from vertex ${seed}${snapped}`);
  if (leak) status($("status").textContent + leak, true);
}

// ---------------------------------------------------------------- drawn labels
// "Save to" dropdown: the configured delineation folders first, then the other
// folders this subject has under label/, then a free name.
function fillFolderPick() {
  const sel = $("draw-folder-pick");
  if (!sel || !S.session) return;
  const preset = S.session.draw_folders || [];
  const have = new Set(S.meta?.label_folders || []);
  const others = [...have].filter((f) => !preset.includes(f)).sort();
  const opt = (f, note = "") => `<option value="${f}">${f}${note}</option>`;
  sel.innerHTML =
    (preset.length ? `<optgroup label="delineation steps">${preset.map((f) => opt(f, have.has(f) ? "" : "  (new)")).join("")}</optgroup>` : "") +
    (others.length ? `<optgroup label="other folders of ${S.sub}">${others.map((f) => opt(f)).join("")}</optgroup>` : "") +
    `<option value="${CUSTOM}">custom… (type a name above)</option>`;
  sel.value = [...sel.options].some((o) => o.value === S.drawFolder) ? S.drawFolder : CUSTOM;
  renderNameList();
}

// The name list: the folder's suggested names plus every name saved there on
// either hemisphere, each tagged with where it is saved ("lh ✓ · rh —"), so
// mirroring one hemisphere's labels on the other is a matter of picking down
// the list.
function renderNameList() {
  const by = S.savedByHemi || {};
  const has = (h, n) => (by[h] || []).includes(n);
  const names = [...new Set([...roiNames(), ...(by.lh || []), ...(by.rh || [])])];
  $("roi-names").innerHTML = names.map((n) =>
    `<option value="${esc(n)}" label="lh ${has("lh", n) ? "✓" : "—"} · rh ${has("rh", n) ? "✓" : "—"}">`).join("");
}

// Which names the Save-to folder holds on each hemisphere (the other one is
// listed here; this one is S.savedInFolder).
async function hemiStatus() {
  const other = S.hemi === "lh" ? "rh" : "lh";
  let o = {};
  try { o = (await getJSON(`${S.sub}/${other}/drawn?${q({ folder: S.drawFolder })}`)).labels; } catch {}
  S.savedByHemi = { [S.hemi]: Object.keys(S.savedInFolder || {}).sort(), [other]: Object.keys(o).sort() };
  setSeg("draw-hemi", "hemi", S.hemi);
  const line = (h) => `${h}: ${S.savedByHemi[h].length ? S.savedByHemi[h].join(", ") : "none yet"}`;
  $("hemi-progress").textContent = `Saved in ${S.drawFolder}/ — ${line("lh")} · ${line("rh")}`;
  renderNameList();
}

// Name suggestions for the current Save-to folder (config: draw_label_names),
// else the word-ROI names.
function roiNames() {
  return S.session.draw_label_names?.[S.drawFolder] ?? S.session.roi_names;
}

function addLabel(name) {
  name = name.trim();
  if (!NAME_RE.test(name)) { status("Label names: letters, digits and . _ + - only", true); return; }
  if (!S.drawn.has(name)) S.drawn.set(name, { mask: new Uint8Array(S.n), visible: true, dirty: false });
  setActive(name);
}

// Drawing needs a label to draw into. Without one, start one: the name typed in
// the box, else the first suggested name (roiNames) not drawn yet (else roi1, roi2, ...).
function ensureActive() {
  if (S.active) return true;
  const typed = $("new-name").value.trim();
  let name = typed;
  if (!name) {
    name = roiNames().find((n) => !S.drawn.has(n));
    for (let k = 1; !name; k++) if (!S.drawn.has(`roi${k}`)) name = `roi${k}`;
  }
  if (!NAME_RE.test(name)) { status("Label names: letters, digits and . _ + - only", true); return false; }
  addLabel(name);
  $("new-name").value = "";
  status(`Drawing into ${S.hemi}.${name}${typed ? "" : " — add or click another label in Drawn labels to switch"}`);
  return true;
}

function setActive(name) {
  S.active = name;
  renderDrawn();
}

function renderDrawn() {
  const ul = $("drawn");
  ul.innerHTML = "";
  if (!S.drawn.size) ul.innerHTML = `<li class="empty">no labels yet — add one above, or just start drawing</li>`;
  $("drawing-into").textContent = S.active ? `Drawing into: ${S.hemi}.${S.active}` : `Drawing into: (new ${S.hemi} label on first click)`;
  for (const [name, l] of S.drawn) {
    let count = 0;
    for (let i = 0; i < S.n; i++) count += l.mask[i];
    const li = document.createElement("li");
    li.className = name === S.active ? "active" : "";
    li.innerHTML = `<input type="checkbox" ${l.visible ? "checked" : ""} title="show">
      <input type="color" value="${rgbHex(colorFor("drawn", name))}">
      <span class="name" title="click to draw into this label">${esc(name)}${l.dirty ? ' <span class="dirty">●</span>' : ""}</span>
      <span class="count">${count.toLocaleString()}</span>
      <button class="del" title="delete the saved file from disk (asks first)">🗑</button>
      <button class="rm" title="remove from this session (a saved file is kept)">×</button>`;
    const [vis, col] = li.querySelectorAll("input");
    vis.onchange = () => { l.visible = vis.checked; view.requestColor(); };
    col.oninput = () => { S.colors[key("drawn", name)] = hexRgb(col.value); view.requestColor(); };
    li.querySelector(".name").onclick = () => setActive(name);
    li.querySelector(".del").onclick = () => deleteDrawn(name);
    li.querySelector(".rm").onclick = () => {
      if (l.dirty && !confirm(`Discard unsaved changes to ${name}?`)) return;
      S.drawn.delete(name);
      if (S.active === name) S.active = S.drawn.keys().next().value || null;
      renderDrawn();
    };
    ul.appendChild(li);
  }
  view.requestColor();
}

// (Re)load the save folder's labels for this subject; they become editable.
// Point the drawing at the Save-to folder. Its saved labels are NOT opened:
// what is shown is chosen in Navigate (one place), and the drawing list holds
// only what you draw -- or what "Open saved" pulls in to edit.
async function loadDrawn() {
  const d = await getJSON(`${S.sub}/${S.hemi}/drawn?${q({ folder: S.drawFolder })}`);
  S.drawn = new Map();
  S.undo = [];
  S.active = null;
  S.savedInFolder = d.labels;
  S.drawDir = d.dir;
  setOpenSaved();
  $("draw-out").textContent = `Saves to ${d.dir}/${S.hemi}.<name>.label` +
    (d.exists ? "" : " (folder is created on the first save)") + " — overwrites a file of the same name.";
  renderDrawn();
}

function setOpenSaved() {
  const n = Object.keys(S.savedInFolder || {}).length;
  const b = $("open-saved");
  b.textContent = n ? `Open saved ${S.hemi} labels to edit (${n})` : `no saved ${S.hemi} labels in this folder yet`;
  b.disabled = !n;
  hemiStatus();
}

// Load the folder's saved labels into the drawing list (not already there).
async function openSaved() {
  const d = await getJSON(`${S.sub}/${S.hemi}/drawn?${q({ folder: S.drawFolder })}`);
  S.savedInFolder = d.labels;
  for (const [name, verts] of Object.entries(d.labels)) {
    if (S.drawn.has(name)) continue;
    const mask = new Uint8Array(S.n);
    for (const i of verts) if (i >= 0 && i < S.n) mask[i] = 1;
    S.drawn.set(name, { mask, visible: true, dirty: false });
  }
  S.active ??= S.drawn.keys().next().value || null;
  setOpenSaved();
  renderDrawn();
  view.requestColor();
  status(`Opened ${Object.keys(d.labels).length} saved labels from ${S.drawFolder}/`);
}

async function saveDrawn(names) {
  const done = [], empty = [];
  try {
    for (const name of names) {
      const l = S.drawn.get(name);
      const vertices = [];
      for (let i = 0; i < S.n; i++) if (l.mask[i]) vertices.push(i);
      if (!vertices.length) { empty.push(name); continue; }
      const r = await api(`${S.sub}/${S.hemi}/drawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: S.drawFolder, name, vertices }),
      });
      done.push(await r.json());
      l.dirty = false;
    }
  } catch (e) { status(`Save failed — ${e.message}`, true); renderDrawn(); return; }
  renderDrawn();
  const skip = empty.length ? ` (skipped empty: ${empty.join(", ")})` : "";
  status(done.length === 1 ? `Saved ${done[0].n_vertices} vertices → ${done[0].path}${skip}`
                           : `Saved ${done.length} labels to ${S.drawDir}${skip}`, !done.length);
  if (done.length) await afterSave(names);
}

// Delete a label's saved file from disk (after asking), and drop it from the session.
async function deleteDrawn(name) {
  if (!name) { status("Pick a label first", true); return; }
  const file = `${S.drawDir}/${S.hemi}.${name}.label`;
  if (!confirm(`Delete this file from disk? This cannot be undone.\n\n${file}`)) return;
  try {
    const r = await api(`${S.sub}/${S.hemi}/drawn?${q({ folder: S.drawFolder, name })}`, { method: "DELETE" });
    const d = await r.json();
    status(`Deleted ${d.removed.join(", ")}`);
  } catch (e) {
    status(e.message.startsWith("404") ? `${name} has no saved file in ${S.drawFolder}/ (× removes it from the session)`
                                       : `Delete failed — ${e.message}`, true);
    return;
  }
  S.drawn.delete(name);
  if (S.active === name) S.active = S.drawn.keys().next().value || null;
  renderDrawn();
  await refreshSaved();
  // Panel 4 (or 5, compare page) may be listing (and showing) the deleted file.
  try { S.meta = await fetchMeta(); } catch { return; }
  renderManualFolders();
  for (const kind of ["manual", "compare"]) {
    if (S.meta.layers[kind].dir !== S.drawDir) continue;
    S.items.delete(key(kind, name));
    renderLayer(kind);
  }
  renderLegend();
  view.requestColor();
}

// A save may have created the folder or changed files panel 4 is showing:
// re-list, and reload the ticked manual labels that were just overwritten.
async function refreshSaved() {
  try { S.savedInFolder = (await getJSON(`${S.sub}/${S.hemi}/drawn?${q({ folder: S.drawFolder })}`)).labels; } catch {}
  setOpenSaved();
}

async function afterSave(names) {
  await refreshSaved();
  try { S.meta = await fetchMeta(); } catch { return; }
  renderManualFolders();
  for (const kind of ["manual", "compare"]) {
    if (S.meta.layers[kind].dir === S.drawDir) {
      const again = names.filter((n) => isOn(kind, n));
      for (const n of again) S.items.delete(key(kind, n));
      if (again.length) await setOn(kind, again, true);
    }
    renderLayer(kind);
  }
}

// ---------------------------------------------------------------- heatmap
function currentThreshold() {
  return S.heat ? (S.thresholds[S.heat.name] ?? Math.min(0.1, S.heat.max)) : 0;
}

async function setHeatmap(name) {
  S.heat = null;
  if (name) {
    try {
      const values = await getBin(`${S.sub}/${S.hemi}/heatmap?${q({ name, dir: S.templates.heatmap })}`,
                                  Float32Array);
      let min = Infinity, max = -Infinity;
      for (const v of values) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
      S.heat = { name, values, min, max: Math.max(max, 1e-6) };
    } catch (e) { status(`Heatmap failed — ${e.message}`, true); }
  }
  syncThresholdWidgets();
  view.requestColor();
}

// Slider bounds come from the map itself: a *_score map tops out at 1, a
// *_mean_raw map at ~20, so one fixed range would be useless for the other.
function syncThresholdWidgets() {
  const on = !!S.heat;
  for (const id of ["thr", "thr-n", "heat-alpha", "heat-tt", "heat-outline"]) $(id).disabled = !on;
  for (const id of ["c-thr-r", "c-thr-n"]) $(id).disabled = !on;
  $("c-map").textContent = on ? S.heat.name : "none — pick one in Navigate › 1 · Heatmap";
  $("colorbar").style.visibility = on ? "" : "hidden";
  if (!on) { heatBadges(); return; }
  const thr = currentThreshold();
  const step = Math.max(S.heat.max / 200, 1e-4);
  Object.assign($("thr"), { min: 0, max: S.heat.max, step, value: thr });
  Object.assign($("thr-n"), { min: 0, max: S.heat.max, step, value: +thr.toPrecision(4) });
  syncColorbar(thr);
  // The fill condition's own slider is a second handle on the same threshold.
  $("c-map").textContent = S.heat.name;
  Object.assign($("c-thr-r"), { min: 0, max: S.heat.max, step, value: thr });
  Object.assign($("c-thr-n"), { min: 0, max: S.heat.max, step, value: +thr.toPrecision(4) });
  heatBadges();
}

// The loaded heatmap's name and colour bar on every surface panel, a copy of
// the sidebar's #colorbar (same gradient, threshold tick and numbers), so the
// map in view is named on the brain itself.
function heatBadges() {
  const src = $("colorbar");
  for (const el of document.querySelectorAll("#viewers .viewer")) {
    let b = el.querySelector(".heat-badge");
    if (!S.heat) { b?.remove(); continue; }
    if (!b) { b = document.createElement("div"); b.className = "heat-badge"; el.appendChild(b); }
    const bar = src.querySelector(".bar"), mark = $("cb-mark");
    b.innerHTML =
      `<div class="hb-name" title="${esc(S.heat.name)}">${esc(S.heat.name)}</div>` +
      `<div class="bar" style="background:${bar.style.background || ""}">` +
      (mark.hidden ? "" : `<span class="hb-mark" style="left:${mark.style.left}"></span>`) + `</div>` +
      `<div class="ticks"><span>${esc($("cb-lo").textContent)}</span><span>${esc($("cb-mid").textContent)}</span>` +
      `<span>${esc($("cb-hi").textContent)}</span></div>`;
  }
}

// Hard threshold: the bar is thr -> max. Transparent: 0 -> max, faded below the
// threshold the way the surface is, with a tick at the threshold.
function syncColorbar(thr) {
  const max = S.heat.max, fmt = (x) => `${+x.toPrecision(3)}`;
  const bar = document.querySelector("#colorbar .bar");
  $("tt-hint").hidden = !S.heatTT;
  if (!S.heatTT) {
    bar.style.background = "";
    $("cb-mark").hidden = true;
    $("cb-lo").textContent = fmt(thr); $("cb-mid").textContent = ""; $("cb-hi").textContent = fmt(max);
    return;
  }
  const stops = [];
  for (let k = 0; k <= 40; k++) {
    const v = (k / 40) * max;
    const a = v > thr ? 1 : (v / (thr || 1)) ** 2;
    const [r, g, b] = heatColor(k / 40).map(Math.round);
    stops.push(`rgba(${r},${g},${b},${a.toFixed(3)}) ${(k * 2.5).toFixed(1)}%`);
  }
  bar.style.background = `linear-gradient(90deg, ${stops.join(", ")}), #9a9a9a`;
  const mark = $("cb-mark");
  mark.hidden = false;
  mark.style.left = `${(100 * thr) / max}%`;
  $("cb-lo").textContent = "0"; $("cb-mid").textContent = `thr ${fmt(thr)}`; $("cb-hi").textContent = fmt(max);
}

function setThreshold(t) {
  if (!S.heat) return;
  S.thresholds[S.heat.name] = Math.min(Math.max(+t || 0, 0), S.heat.max);
  syncThresholdWidgets();
  view.requestColor();
}

// ---------------------------------------------------------------- layers
async function loadItem(kind, name) {
  const d = await getJSON(`${S.sub}/${S.hemi}/layer?${q({ kind, name, dir: S.templates[kind] })}`);
  if (d.kind === "annot") {
    const labels = b64ToInt32(d.labels);
    const present = new Uint32Array(d.names.length);
    for (const k of labels) if (k >= 0) present[k]++;
    return { kind, name, type: "annot", labels, names: d.names, colors: d.colors, present,
             regions: Uint8Array.from(present, (c) => (c > 0 ? 1 : 0)),
             boundary: M.boundary(S.adj, labels), on: true, fill: false };
  }
  const verts = Int32Array.from(d.vertices.filter((i) => i >= 0 && i < S.n));
  const mask = new Uint8Array(S.n);
  for (const i of verts) mask[i] = 1;
  const edge = M.maskOutline(S.adj, mask);
  const outline = [];
  for (const i of verts) if (edge[i]) outline.push(i);
  return { kind, name, type: "label", verts, mask, outline: Int32Array.from(outline),
           on: true, fill: false };
}

async function setOn(kind, names, on) {
  const missing = on ? names.filter((n) => !S.items.has(key(kind, n))) : [];
  try {
    const loaded = await Promise.all(missing.map((n) => loadItem(kind, n)));
    for (const it of loaded) S.items.set(key(kind, it.name), it);
  } catch (e) { status(`Layer failed — ${e.message}`, true); }
  for (const n of names) {
    const it = S.items.get(key(kind, n));
    if (it) { it.on = on; it.hidden = false; }
  }
  renderLayer(kind);
  renderLegend();
  view.requestColor();
}

const isOn = (kind, name) => !!S.items.get(key(kind, name))?.on;

// One row: tick, colour (labels) or ▸ regions (annots), name, fill.
function itemRow(kind, name, type, { fill = true, indent = false } = {}) {
  const it = S.items.get(key(kind, name));
  const li = document.createElement("li");
  if (indent) li.className = "sub";
  const k = key(kind, name);
  const swatch = type === "annot"
    ? `<button class="expand" title="choose regions" ${it ? "" : "disabled"}>${S.open.has(k) ? "▾" : "▸"}</button>`
    : `<input type="color" value="${rgbHex(colorFor(kind, name))}">`;
  li.innerHTML = `<input type="checkbox" class="on" ${it?.on ? "checked" : ""}>
    ${swatch}
    <span class="name" title="${esc(name)}">${esc(name)}</span>
    ${type === "annot" ? '<span class="kind">annot</span>' : ""}
    ${fill ? `<label class="dim" title="fill instead of outline only"><input type="checkbox" class="fill" ${it?.fill ? "checked" : ""}> fill</label>` : ""}`;
  li.querySelector(".on").onchange = (e) => setOn(kind, [name], e.target.checked);
  li.querySelector(".fill")?.addEventListener("change", (e) => {
    const cur = S.items.get(k);
    if (cur) { cur.fill = e.target.checked; view.requestColor(); }
  });
  if (type === "annot") {
    li.querySelector(".expand").onclick = () => {
      S.open.has(k) ? S.open.delete(k) : S.open.add(k);
      renderLayer(kind);
    };
  } else {
    li.querySelector("input[type=color]").oninput = (e) => {
      S.colors[k] = hexRgb(e.target.value);
      renderLegend();
      view.requestColor();
    };
  }
  return li;
}

// The regions of one annot, each switchable; empty regions are left out.
function regionList(it) {
  const li = document.createElement("li");
  li.className = "regions";
  const rows = it.names.map((name, k) => it.present[k] ? `
    <label><input type="checkbox" data-k="${k}" ${it.regions[k] ? "checked" : ""}>
      <span class="sw" style="background:${rgbHex(it.colors[k])}"></span>${esc(name)}</label>` : "").join("");
  li.innerHTML = `<div class="row"><button data-all="1">all</button><button data-all="0">none</button></div>${rows}`;
  li.onchange = (e) => {
    const k = e.target.dataset.k;
    if (k !== undefined) { it.regions[+k] = e.target.checked ? 1 : 0; view.requestColor(); }
  };
  li.onclick = (e) => {
    if (e.target.dataset.all === undefined) return;
    it.regions = Uint8Array.from(it.present, (c) => (c > 0 ? +e.target.dataset.all : 0));
    renderLayer(it.kind); view.requestColor();
  };
  return li;
}

function renderLayer(kind) {
  const ul = $(kind);
  ul.innerHTML = "";
  const L = S.meta.layers[kind];
  document.querySelector(`.dir[data-kind=${kind}]`).classList.toggle("missing", !L.exists);
  const empty = (msg) => { ul.innerHTML = `<li class="empty">${msg}</li>`; };
  if (!L.exists) return empty("folder not found");

  if (kind === "clusters") {
    const groups = Object.entries(L.by_contrast);
    if (!groups.length) return empty("no *_Cluster_*.label here");
    for (const [contrast, names] of groups) {
      const nOn = names.filter((n) => isOn(kind, n)).length;
      const open = S.open.has(key("contrast", contrast));
      const li = document.createElement("li");
      li.innerHTML = `<input type="checkbox" class="on" ${nOn === names.length ? "checked" : ""}>
        <button class="expand" title="single clusters">${open ? "▾" : "▸"}</button>
        <span class="name">${esc(contrast)}</span>
        <span class="count">${nOn ? `${nOn}/` : ""}${names.length}</span>`;
      const box = li.querySelector(".on");
      box.indeterminate = nOn > 0 && nOn < names.length;
      box.onchange = () => {
        // Ticking a contrast opens it, so each cluster's tick and colour show.
        if (box.checked) S.open.add(key("contrast", contrast));
        setOn(kind, names, box.checked);
      };
      li.querySelector(".expand").onclick = () => {
        open ? S.open.delete(key("contrast", contrast)) : S.open.add(key("contrast", contrast));
        renderLayer(kind);
      };
      ul.appendChild(li);
      if (open) for (const n of names) ul.appendChild(itemRow(kind, n, "label", { fill: false, indent: true }));
    }
    return;
  }

  const filter = (document.querySelector(`.filter[data-kind=${kind}]`)?.value || "").toLowerCase();
  const rows = [...(L.annots || []).map((n) => [n, "annot"]), ...L.items.map((n) => [n, "label"])]
    .filter(([n]) => !filter || n.toLowerCase().includes(filter));
  if (!rows.length) return empty(filter ? "nothing matches" : `no ${S.hemi}.*.label here`);
  for (const [n, type] of rows) {
    ul.appendChild(itemRow(kind, n, type));
    const it = S.items.get(key(kind, n));
    if (type === "annot" && it && S.open.has(key(kind, n))) ul.appendChild(regionList(it));
  }
}

function renderHeatmaps() {
  const L = S.meta.layers.heatmap;
  document.querySelector(".dir[data-kind=heatmap]").classList.toggle("missing", !L.exists);
  $("heat").innerHTML = `<option value="">none</option>` +
    L.items.map((n) => `<option>${esc(n)}</option>`).join("");
}

function renderManualFolders() {
  fillFolderPick();   // the "Save to" dropdown lists the same label/ folders
  const atlas = S.templates.atlas.replace(/\/+$/, "");
  const opts = S.meta.label_folders.map((f) => [`${atlas}/${f}`, `${f}/`]);
  for (const kind of ["manual", "compare"]) {
    const sel = $(`${kind}-folder`);
    sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("") +
      `<option value="${CUSTOM}">other folder (type below)…</option>`;
    sel.value = opts.some(([v]) => v === S.templates[kind]) ? S.templates[kind] : CUSTOM;
  }
  rowTags();
}

// Compare page: name each row after its folder ("tiger_delineation · pial").
const folderName = (tmpl) => (tmpl || "").replace(/\/+$/, "").split("/").pop() || "—";
function rowTags() {
  if (!COMPARE) return;
  const names = [`ref: ${folderName(S.templates.manual)}`, `compare: ${folderName(S.templates.compare)}`];
  for (const v of view.viewers) v.el.querySelector(".tag").textContent = `${names[v.row]} · ${v.surf}`;
}

// Compare page: a reference / compared folder shows all its labels at once.
async function tickAll(kind) {
  if (!COMPARE || !S.meta.layers[kind].exists) return;
  const names = S.meta.layers[kind].items.filter((n) => !isOn(kind, n));
  if (names.length) await setOn(kind, names, true);
}

// ---------------------------------------------------------------- legend
// Every ticked label/cluster, grouped: click hides/shows it on the surface
// (it stays ticked), double-click shows only it within its group, hover fills
// it -- the quick way to go through clusters one by one and map them to ROIs.
const GROUP_TITLES = { atlas: "Atlas", manual: COMPARE ? "Reference (top)" : "Manual", compare: "Compare (bottom)" };

// [title, items, short name] per group: one group per contrast (entries are
// just "#id", in listing order = posterior -> anterior), then atlas, manual.
function legendGroups() {
  const groups = [];
  const shown = (kind, names) =>
    names.map((n) => S.items.get(key(kind, n))).filter((it) => it?.on && it.type === "label");
  for (const [contrast, names] of Object.entries(S.meta.layers.clusters.by_contrast)) {
    const items = shown("clusters", names);
    if (items.length) groups.push([contrast, items, (n) => n.replace(/^.* (#\d+)$/, "$1")]);
  }
  for (const kind of LABEL_KINDS) {
    const items = shown(kind, S.meta.layers[kind].items);
    if (items.length) groups.push([GROUP_TITLES[kind], items, (n) => n]);
  }
  return groups;
}

function renderLegend() {
  const box = $("legend"), ul = $("legend-list");
  const groups = S.meta ? legendGroups() : [];
  box.hidden = !groups.length;
  ul.innerHTML = "";
  for (const [title, items, short] of groups) {
    const head = document.createElement("li");
    head.className = "group";
    head.textContent = `${title} · ${items.filter((it) => !it.hidden).length}/${items.length}`;
    ul.appendChild(head);
    for (const it of items) {
      const kind = it.kind;
      const k = key(kind, it.name);
      const li = document.createElement("li");
      li.className = it.hidden ? "off" : "";
      li.title = `${it.name} · ${it.verts.length} vertices`;
      li.innerHTML = `<span class="sw" style="background:${rgbHex(colorFor(kind, it.name))}"></span>
        <span class="nm">${esc(short(it.name))}</span>`;
      li.onclick = (e) => {
        if (e.detail > 1) return; // part of a double-click
        clearTimeout(li._t);
        li._t = setTimeout(() => { it.hidden = !it.hidden; afterLegend(); }, 220);
      };
      li.ondblclick = () => {
        clearTimeout(li._t);
        const others = items.filter((x) => x !== it);
        const isolated = !it.hidden && others.every((x) => x.hidden);
        for (const x of others) x.hidden = !isolated;
        it.hidden = false;
        afterLegend();
      };
      li.onmouseenter = () => { if (!it.hidden) { S.highlight = k; view.requestColor(); } };
      li.onmouseleave = () => { if (S.highlight === k) { S.highlight = null; view.requestColor(); } };
      ul.appendChild(li);
    }
  }
}

function afterLegend() {
  S.highlight = null;
  renderLegend();
  view.requestColor();
}

// ---------------------------------------------------------------- loading
async function fetchMeta() {
  return getJSON(`${S.sub}/${S.hemi}/meta?${q(S.templates)}`);
}

// Re-list one layer after its folder changed; what was ticked there is dropped.
async function refreshLayer(kind) {
  try {
    S.meta = await fetchMeta();
  } catch (e) { status(`Could not list ${kind} — ${e.message}`, true); return; }
  for (const k of [...S.items.keys()]) if (k.startsWith(`${kind}:`)) S.items.delete(k);
  renderLegend();
  if (kind === "heatmap") { renderHeatmaps(); await setHeatmap(""); }
  else renderLayer(kind);
  if (kind === "atlas") renderManualFolders();
  if (kind === "manual" || kind === "compare") { rowTags(); await tickAll(kind); }
  view.requestColor();
}

async function loadSubject() {
  const sub = $("sub").value, hemi = $("hemi").value;
  if (!sub) return;
  if (isDirty() && !confirm("Unsaved drawn labels will be discarded. Load anyway?")) {
    // Put the pickers back on what is actually shown.
    if (S.meta) { $("sub").value = S.sub; $("hemi").value = S.hemi; }
    return;
  }
  // Switching subject keeps everything that isn't the subject's own data: the
  // camera (mirrored on a hemisphere switch), surface opacity / mesh, the
  // heatmap and its threshold, ticked labels with their fill and legend state,
  // and every contrast whose clusters were all ticked. Single clusters are not
  // carried over -- cluster IDs are numbered per subject.
  const keepView = S.meta ? view.getViewState() : null;
  const mirror = S.meta && S.hemi !== hemi;
  const keepHeat = S.heat?.name ?? null;
  const keepOn = [...S.items.values()]
    .filter((it) => it.on && it.kind !== "clusters")
    .map((it) => ({ kind: it.kind, name: it.name, fill: it.fill, hidden: it.hidden,
                    regions: it.type === "annot" ? it.names.filter((_, k) => it.regions[k]) : null }));
  const keepContrasts = S.meta ? Object.entries(S.meta.layers.clusters.by_contrast)
    .filter(([, names]) => names.every((n) => isOn("clusters", n))).map(([c]) => c) : [];
  status(`Loading ${sub} ${hemi}…`);
  try {
    S.sub = sub; S.hemi = hemi;
    const meta = await fetchMeta();
    const faces = await getBin(`${sub}/${hemi}/faces`, Int32Array);
    const surfaces = await Promise.all(meta.surfaces.map(async (s) =>
      [s, await getBin(`${sub}/${hemi}/surface/${s}`, Float32Array)]));
    S.curv = meta.has_curv ? await getBin(`${sub}/${hemi}/curv`, Float32Array) : null;
    Object.assign(S, { meta, n: meta.n_vertices, heat: null, items: new Map(), highlight: null,
                       coords: Object.fromEntries(surfaces), drawn: new Map() });
    S.contour = { points: [], cursor: "tail", awaitingSeed: null, path: [] };
    renderLegend();
    S.adj = M.buildAdjacency(faces, S.n);
    view.load(surfaces, faces, S.n, COMPARE ? { rows: ["ref", "compare"] } : undefined);
    heatBadges();
    S.cursorV = -1;             // vertex numbers differ between subjects / hemispheres
    showCursorInfo();
    view.surfaceControls($("surf-toggles"));
    if (!meta.surfaces.includes(S.pathSurface)) {
      S.pathSurface = meta.surfaces.includes("inflated") ? "inflated" : meta.surfaces[0];
    }
    $("path-surface").innerHTML = meta.surfaces.map((s) => `<option>${s}</option>`).join("");
    $("path-surface").value = S.pathSurface;
    if (keepView) view.setViewState(keepView, mirror);
    else view.setView("ventral", hemi);
    renderHeatmaps();
    for (const kind of KINDS) renderLayer(kind);
    renderManualFolders();

    const heatNames = meta.layers.heatmap.items;
    // The compare page opens without a heatmap (pick one in Navigate).
    const firstHeat = keepHeat ?? (COMPARE ? null : `${S.session.default_contrast}_score`);
    if (heatNames.includes(firstHeat)) { $("heat").value = firstHeat; await setHeatmap(firstHeat); }
    else syncThresholdWidgets();
    const byContrast = meta.layers.clusters.by_contrast;
    const clusterNames = keepContrasts.flatMap((c) => byContrast[c] || []);
    if (clusterNames.length) await setOn("clusters", clusterNames, true);
    for (const kind of LABEL_KINDS) {
      const avail = new Set([...meta.layers[kind].items, ...(meta.layers[kind].annots || [])]);
      const keep = keepOn.filter((k) => k.kind === kind && avail.has(k.name));
      if (!keep.length) continue;
      await setOn(kind, keep.map((k) => k.name), true);
      for (const k of keep) {
        const it = S.items.get(key(kind, k.name));
        if (!it) continue;
        it.fill = k.fill;
        it.hidden = k.hidden;
        if (k.regions) it.regions = Uint8Array.from(it.names, (n, i) => (it.present[i] && k.regions.includes(n) ? 1 : 0));
      }
      renderLayer(kind);
    }
    await tickAll("manual");
    await tickAll("compare");
    renderLegend();
    await loadDrawn();
    view.requestColor();
    status(`${sub} ${hemi}: ${S.n.toLocaleString()} vertices`);
    $("hover").textContent = "";
  } catch (e) {
    console.error(e);
    status(`Load failed — ${e.message}`, true);
  }
}

// ---------------------------------------------------------------- UI wiring
// Two tabs, Navigate | Draw; Draw holds the Contour / Brush / Erase tools and
// comes back to the last one used.
function setTool(t) {
  if (t === "draw") t = S.lastDrawTool || "contour";
  S.tool = t;
  if (t !== "navigate") S.lastDrawTool = t;
  for (const b of $("tools").children) b.classList.toggle("on", (b.dataset.tool === "navigate") === (t === "navigate"));
  for (const b of $("draw-tools").children) b.classList.toggle("on", b.dataset.tool === t);
  document.body.className = document.body.className.replace(/\btool-\S+/g, "").trim();
  document.body.classList.add(`tool-${t}`);
  // classList, not className: the compare page's "rows" class must stay.
  for (const k of ["navigate", "contour", "brush", "erase"]) $("viewers").classList.toggle(k, k === t);
}
function setSeg(id, attr, val) {
  for (const b of $(id).children) b.classList.toggle("on", b.dataset[attr] === val);
}
function setClickMode(m) {
  S.clickMode = m;
  setSeg("click-mode", "click", m);
  // "Put a dot on a heatmap blob to fill it" needs the map as a bound; without
  // it a fill floods the whole hemisphere. Tick it for the user.
  if (m === "fill" && S.heat && !$("c-heat").checked) {
    $("c-heat").checked = true;
    status(`Click now fills from the seed, inside ${S.heat.name} > ${+currentThreshold().toPrecision(4)}`);
  }
}
function setRadius(r) {
  S.radius = Math.min(10, Math.max(0.5, r));
  $("radius").value = S.radius;
  $("radius-out").textContent = `${S.radius} mm`;
}

function wireDrawing() {
  $("tools").onclick = (e) => e.target.dataset.tool && setTool(e.target.dataset.tool);
  $("draw-tools").onclick = (e) => e.target.dataset.tool && setTool(e.target.dataset.tool);
  $("open-saved").onclick = () => openSaved();
  // Hemisphere switch next to the drawing (the header's Hemi does the same).
  $("draw-hemi").onclick = (e) => {
    const h = e.target.dataset.hemi;
    if (!h || h === S.hemi) return;
    $("hemi").value = h;
    loadSubject();
  };
  $("draw-mode").onclick = (e) => {
    if (!e.target.dataset.mode) return;
    S.drawMode = e.target.dataset.mode;
    setSeg("draw-mode", "mode", S.drawMode);
  };
  $("click-mode").onclick = (e) => e.target.dataset.click && setClickMode(e.target.dataset.click);
  // Ticking the map bound means "fill the blob I click": switch the click to fill
  // (unless a path is being drawn, which the fill may use as a border).
  $("c-heat").addEventListener("change", (e) => {
    if (e.target.checked && S.clickMode === "path" && !S.contour.points.length) {
      setClickMode("fill");
      status("Click now fills from the seed (Click: fills from seed; F switches back to path points)");
    }
  });
  $("path-surface").onchange = (e) => { S.pathSurface = e.target.value; updateContour(); };
  $("seed-fill").onchange = (e) => { S.seedFill = e.target.checked; };
  $("show-hidden").onchange = (e) => { S.showHidden = e.target.checked; updateContour(); };
  $("radius").oninput = (e) => setRadius(+e.target.value);
  $("draw-alpha").oninput = (e) => { S.drawAlpha = +e.target.value; view.requestColor(); };
  $("trim").onclick = () => {
    if (!S.active) { status("Add or pick a label first", true); return; }
    let ok;
    try { ok = valueMask(); } catch (e) { status(`Trim: ${e.message}`, true); return; }
    if (!ok) { status("Trim: tick “inside the thresholded map” or pick sulci/gyri first", true); return; }
    setMask(S.drawn.get(S.active).mask.map((x, i) => x & ok[i]), "Trim");
  };
  const folder = $("draw-folder");
  folder.onkeydown = (e) => { if (e.key === "Enter") folder.blur(); };
  // One click to switch between the delineation steps' folders.
  $("draw-folder-pick").onchange = (e) => {
    const v = e.target.value;
    if (v === CUSTOM) { folder.focus(); folder.select(); fillFolderPick(); return; }
    folder.value = v;
    folder.onchange();
  };
  folder.onchange = async () => {
    const f = folder.value.trim();
    if (!NAME_RE.test(f)) { status("Folder name: letters, digits and . _ + - only", true); folder.value = S.drawFolder; return; }
    if (f === S.drawFolder) return;
    if (isDirty() && !confirm("Unsaved drawn labels will be discarded. Switch folder anyway?")) {
      folder.value = S.drawFolder; return;
    }
    S.drawFolder = f;
    fillFolderPick();
    try { await loadDrawn(); } catch (e) { status(`Could not read the folder — ${e.message}`, true); }
  };
  $("new-label").onclick = () => { addLabel($("new-name").value); $("new-name").value = ""; };
  $("new-name").onkeydown = (e) => { if (e.key === "Enter") $("new-label").click(); };
  $("save").onclick = () => S.active && saveDrawn([S.active]);
  $("save-all").onclick = () => saveDrawn([...S.drawn.keys()]);
  $("delete-file").onclick = () => deleteDrawn(S.active);
  const op = (what, fn) => () => {
    if (!S.active) { status("Add or pick a label first", true); return; }
    setMask(fn(S.drawn.get(S.active).mask), what);
  };
  $("fill-holes").onclick = op("Fill holes", (m) => M.fillHoles(S.adj, m));
  $("dilate").onclick = op("Dilate", (m) => D.dilate(S.adj, m));
  $("erode").onclick = op("Erode", (m) => D.erode(S.adj, m));
  $("clear").onclick = () => {
    if (S.active && confirm(`Clear every vertex of ${S.active}?`)) setMask(new Uint8Array(S.n), "Clear");
  };

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = { n: "navigate", c: "contour", b: "brush", e: "erase" }[k.toLowerCase()];
    if (t) { setTool(t); return; }
    if (isPaintTool() && (k === "[" || k === "]")) { setRadius(S.radius + (k === "]" ? 0.5 : -0.5)); return; }
    if (S.tool !== "contour") return;
    if (k === "Tab") {
      e.preventDefault();
      S.contour.cursor = S.contour.cursor === "tail" ? "head" : "tail";
      updateContour();
    } else if (k === "Backspace" || k === "Delete") {
      e.preventDefault();
      if (S.contour.awaitingSeed) { S.contour.awaitingSeed = null; updateContour(); return; }
      if (S.contour.cursor === "tail") S.contour.points.pop(); else S.contour.points.shift();
      updateContour();
    } else if (k === "Enter") {
      closeContour();
    } else if (k === "Escape") {
      clearContour(); status("Path discarded");
    } else if (k.toLowerCase() === "f") {
      setClickMode(S.clickMode === "path" ? "fill" : "path");
    }
  });
  window.addEventListener("beforeunload", (e) => { if (isDirty()) e.preventDefault(); });
  setTool("navigate");
  setSeg("draw-mode", "mode", S.drawMode);
  setClickMode(S.clickMode);
}

function wire() {
  wireDrawing();
  // Picking a subject or hemisphere loads it straight away.
  $("load").onclick = loadSubject;
  $("sub").onchange = loadSubject;
  $("hemi").onchange = loadSubject;
  const step = (d) => {
    const sel = $("sub");
    const i = sel.selectedIndex + d;
    if (i < 0 || i >= sel.options.length) return;
    sel.selectedIndex = i;
    loadSubject();
  };
  $("prev").onclick = () => step(-1);
  $("next").onclick = () => step(1);
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
    if (e.key === ",") step(-1);
    if (e.key === ".") step(1);
  });
  $("heat").onchange = (e) => setHeatmap(e.target.value);
  $("thr").oninput = (e) => setThreshold(e.target.value);
  $("thr-n").onchange = (e) => setThreshold(e.target.value);
  $("c-thr-r").oninput = (e) => setThreshold(e.target.value);
  $("c-thr-n").onchange = (e) => setThreshold(e.target.value);
  $("heat-alpha").oninput = (e) => { S.heatAlpha = +e.target.value; view.requestColor(); };
  $("heat-tt").onchange = (e) => { S.heatTT = e.target.checked; syncThresholdWidgets(); view.requestColor(); };
  $("heat-outline").onchange = (e) => { S.heatOutline = e.target.checked; view.requestColor(); };
  $("cluster-fill").onchange = (e) => { S.clusterFill = e.target.checked; view.requestColor(); };
  $("fill-alpha").oninput = (e) => { S.fillAlpha = +e.target.value; view.requestColor(); };
  for (const el of document.querySelectorAll(".dir")) {
    const kind = el.dataset.kind;
    el.onkeydown = (e) => { if (e.key === "Enter") el.blur(); };
    el.onchange = () => {
      S.templates[kind] = el.value.trim();
      if (kind === "manual" || kind === "compare") renderManualFolders();
      refreshLayer(kind);
    };
  }
  for (const el of document.querySelectorAll(".filter")) el.oninput = () => renderLayer(el.dataset.kind);
  for (const kind of ["manual", "compare"]) {
    $(`${kind}-folder`).onchange = (e) => {
      const dir = document.querySelector(`.dir[data-kind=${kind}]`);
      if (e.target.value === CUSTOM) { dir.focus(); return; }
      S.templates[kind] = dir.value = e.target.value;
      refreshLayer(kind);
    };
  }
  $("swap-rows").onclick = async () => {
    [S.templates.manual, S.templates.compare] = [S.templates.compare, S.templates.manual];
    for (const kind of ["manual", "compare"]) document.querySelector(`.dir[data-kind=${kind}]`).value = S.templates[kind];
    renderManualFolders();
    await refreshLayer("manual");
    await refreshLayer("compare");
  };
  for (const b of document.querySelectorAll("[data-clear]")) {
    b.onclick = () => {
      const kind = b.dataset.clear;
      for (const it of S.items.values()) if (it.kind === kind) it.on = false;
      renderLayer(kind);
      renderLegend();
      view.requestColor();
    };
  }
  $("legend-all").onclick = () => {
    for (const it of S.items.values()) it.hidden = false;
    afterLegend();
  };
  $("legend-min").onclick = () => {
    const min = $("legend").classList.toggle("min");
    $("legend-min").textContent = min ? "+" : "–";
  };
  $("link").onchange = (e) => { view.link = e.target.checked; };
  $("curv-on").onchange = (e) => { S.curvOn = e.target.checked; view.requestColor(); };
  $("cursor-on").onchange = (e) => { S.cursorOn = e.target.checked; placeCursor(S.cursorV); };
  $("cursor-clear").onclick = () => placeCursor(-1);
  // Threshold / mode / brightness of the curvature shading, remembered in this browser.
  curvatureControls($("curv-opts"), S.curvOpts, () => view.requestColor(), "delineationHelper.curv");
  $("views").onclick = (e) => e.target.dataset.view && view.setView(e.target.dataset.view, S.hemi);
  $("png").onclick = () => {
    if (!S.meta) return;
    const parts = [S.sub, S.hemi];
    if (COMPARE) parts.push(`${folderName(S.templates.manual)}-vs-${folderName(S.templates.compare)}`);
    if (S.heat) parts.push(S.heat.name, `thr${+currentThreshold().toPrecision(3)}`);
    const a = document.createElement("a");
    a.href = view.snapshot();
    a.download = `${parts.join("_")}.png`;
    a.click();
  };
}

async function init() {
  document.body.classList.add(`page-${PAGE}`);
  for (const a of document.querySelectorAll(".pages a")) a.classList.toggle("on", a.dataset.page === PAGE);
  if (COMPARE) {
    document.title = "Delineation Helper · Compare";
    $("app-title").textContent = "Delineation Helper · Compare";
    $("manual-title").textContent = "4 · Reference (top row)";
  }
  wire();
  try {
    S.session = await getJSON("session");
    S.templates = { ...S.session.templates };
    S.drawFolder = S.session.draw_folder;
    $("draw-folder").value = S.drawFolder;
    fillFolderPick();
    for (const el of document.querySelectorAll(".dir")) el.value = S.templates[el.dataset.kind];
    $("sub").innerHTML = S.session.subjects.map((s) => `<option>${s}</option>`).join("");
    if (S.session.default_subject) $("sub").value = S.session.default_subject;
    $("hemi").value = S.session.default_hemi;
    if (!S.session.subjects.length) {
      status(`No sub-* with surf/<hemi>.inflated in ${S.session.fs_dir}`, true);
      return;
    }
    await loadSubject();
  } catch (e) { status(`Could not reach the server — ${e.message}`, true); }
}

// ---------------------------------------------------------------- sidebar
// Hide / show with the header button or "\\". Remembered per browser; narrow
// windows start hidden. The panels resize themselves (ResizeObserver).
const SIDEBAR_KEY = "delineationHelper.sidebar";
function setSidebar(show) {
  document.body.classList.toggle("no-sidebar", !show);
  $("sidebar-toggle").title = show ? "hide the sidebar (\\)" : "show the sidebar (\\)";
  try { localStorage.setItem(SIDEBAR_KEY, show ? "1" : "0"); } catch {}
}
{
  let saved = null;
  try { saved = localStorage.getItem(SIDEBAR_KEY); } catch {}
  setSidebar(saved === null ? window.innerWidth > 900 : saved === "1");
  $("sidebar-toggle").onclick = () => setSidebar(document.body.classList.contains("no-sidebar"));
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
    if (e.key === "\\" && !e.metaKey && !e.ctrlKey) setSidebar(document.body.classList.contains("no-sidebar"));
  });
}

init();
