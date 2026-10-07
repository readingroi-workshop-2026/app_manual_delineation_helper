// Both hemispheres (/both) — one subject, lh and rh together in each panel
// (inflated | pial, as on the single page).
//
// The engine draws one mesh per panel, so the two hemispheres are joined into
// one: rh's vertices follow lh's (offset[h]), its faces shifted by nL. Every
// per-vertex array (curvature, heatmap, labels, colours) uses that joined
// index. On inflated the hemispheres overlap in space, so each is moved
// sideways by GAP_MM; pial stays in brain space. View only: drawing stays on
// the single page.

import { SurfaceViewer, blend, paintCurvature, curvatureControls } from "./engine/viewer.js";
import * as M from "./engine/mesh.js";

const $ = (id) => document.getElementById(id);
const HEMIS = ["lh", "rh"];
const FLAT = "__flat__";        // the subject's own label/ folder
const GAP_MM = 8;               // space between the inflated hemispheres
const SET_KINDS = ["manual", "compare", "atlas"];   // server layers, one per label set

const B = {
  session: null, sub: null,
  show: { lh: true, rh: true },
  data: {},                     // hemi -> loaded data of the current subject
  n: 0, offset: {}, adj: null, curv: null, heat: null, labels: [],
  heatName: "", thr: 0.1, heatAlpha: 0.85, heatTT: true, heatOutline: true,
  sets: [
    { folder: "tiger_anat_landmark", fill: false, hidden: new Set() },
    { folder: "tiger_ROI_auto", fill: false, hidden: new Set() },
    { folder: "", fill: false, hidden: new Set() },
  ],
  fillAlpha: 0.6,
  curvOn: true, curvOpts: {}, cursorOn: true, cursorV: -1,
  colors: {},
  token: 0,
};
window.bothView = B; // for the devtools console

// ---------------------------------------------------------------- utilities
async function api(path) {
  const r = await fetch(`/api/${path}`);
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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbHex = (c) => "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");
function status(msg, bad = false) {
  $("status").textContent = msg;
  $("status").style.color = bad ? "var(--danger)" : "";
}
const atlasDir = () => B.session.templates.atlas.replace(/\/+$/, "");
const setDir = (s) => (B.sets[s].folder === FLAT ? atlasDir() : `${atlasDir()}/${B.sets[s].folder}`);

// Same colour rules as the single and group pages: landmark / aparc names
// exact, word ROIs by substring, else the palette -- by set + name.
let paletteNext = 0;
function colorFor(s, name) {
  const k = `${s}:${name}`;
  if (!B.colors[k]) {
    const low = name.toLowerCase();
    const anat = B.session.anat_colors?.[low.replace(/^aparc\./, "")];
    const roi = Object.entries(B.session.roi_colors).find(([r]) => low.includes(r));
    const pal = B.session.cluster_colors;
    B.colors[k] = hexRgb(anat || (roi ? roi[1] : pal[paletteNext++ % pal.length]));
  }
  return B.colors[k];
}

const HEAT = [[190, 25, 0], [255, 120, 0], [255, 235, 60]];
function heatColor(t) {
  const x = Math.min(1, Math.max(0, t)) * 2;
  const [a, b] = x < 1 ? [HEAT[0], HEAT[1]] : [HEAT[1], HEAT[2]];
  const f = x < 1 ? x : x - 1;
  return [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * f);
}

// ---------------------------------------------------------------- engine
const view = new SurfaceViewer($("viewers"), {
  paint,
  onHover: (v, vi) => { $("hover").textContent = vi < 0 ? "" : describe(vi); },
  onClick: (v, vi) => { if (B.cursorOn && vi >= 0) placeCursor(vi); },
});

function paint(out) {
  const n = B.n;
  paintCurvature(out, B.curv, n, B.curvOn, B.curvOpts);
  if (B.heat) {
    const { values, max } = B.heat, thr = B.thr;
    if (B.heatTT) {
      for (let i = 0; i < n; i++) {
        const v = values[i];
        if (v > 0) blend(out, i, heatColor(v / max), B.heatAlpha * (v > thr ? 1 : (v / thr) ** 2));
      }
    } else {
      const span = max - thr || 1;
      for (let i = 0; i < n; i++) if (values[i] > thr) blend(out, i, heatColor((values[i] - thr) / span), B.heatAlpha);
    }
    if (B.heatOutline) {
      const edge = M.maskOutline(B.adj, Uint8Array.from(values, (v) => (v > thr ? 1 : 0)));
      for (let i = 0; i < n; i++) if (edge[i]) blend(out, i, [20, 20, 20], 0.85);
    }
  }
  for (const l of B.labels) {
    const set = B.sets[l.set];
    if (set.hidden.has(l.name)) continue;
    const c = colorFor(l.set, l.name);
    if (set.fill) for (const i of l.verts) blend(out, i, c, B.fillAlpha);
    for (const i of l.outline) blend(out, i, c, 1);
  }
}

// Joined index -> [hemi, vertex in that hemisphere].
function local(vi) {
  for (const h of HEMIS) {
    const o = B.offset[h];
    if (o !== undefined && vi >= o && vi < o + B.data[h].n) return [h, vi - o];
  }
  return [null, -1];
}

function describe(vi) {
  const [h, v] = local(vi);
  if (!h) return "";
  const parts = [`${B.sub} ${h} · vertex ${v}`];
  if (B.heat) parts.push(`${B.heatName} = ${+B.heat.values[vi].toPrecision(4)}`);
  const pial = B.data[h].coords.pial;
  if (pial) parts.push(`pial (${[0, 1, 2].map((d) => pial[3 * v + d].toFixed(1)).join(", ")})`);
  for (const l of B.labels) if (l.mask[vi]) parts.push(l.name);
  return parts.join("  ·  ");
}

function placeCursor(vi) {
  B.cursorV = vi;
  view.setCursor(B.cursorOn ? vi : -1);
  if (vi >= 0) $("hover").textContent = `cursor: ${describe(vi)}`;
}

// ---------------------------------------------------------------- loading
// One hemisphere of the current subject: mesh, curvature, heatmap, label sets.
async function loadHemi(sub, h) {
  const meta = await getJSON(`${sub}/${h}/meta?${q({
    heatmap: B.session.templates.heatmap,
    ...Object.fromEntries(B.sets.map((set, s) => [SET_KINDS[s], set.folder ? setDir(s) : ""])),
  })}`);
  const surfs = B.session.surfaces.filter((s) => meta.surfaces.includes(s));
  const [faces, curv, ...coords] = await Promise.all([
    getBin(`${sub}/${h}/faces`, Int32Array),
    meta.has_curv ? getBin(`${sub}/${h}/curv`, Float32Array) : null,
    ...surfs.map((s) => getBin(`${sub}/${h}/surface/${s}`, Float32Array)),
  ]);
  let heat = null;
  if (B.heatName && meta.layers.heatmap.items.includes(B.heatName)) {
    heat = await getBin(`${sub}/${h}/heatmap?${q({ name: B.heatName, dir: B.session.templates.heatmap })}`, Float32Array);
  }
  const wanted = B.sets.flatMap((set, s) => {
    const L = meta.layers[SET_KINDS[s]];
    return set.folder && L.exists ? L.items.map((name) => [s, name]) : [];
  });
  const labels = await Promise.all(wanted.map(async ([s, name]) => {
    const d = await getJSON(`${sub}/${h}/layer?${q({ kind: SET_KINDS[s], name, dir: setDir(s) })}`);
    return { set: s, name, hemi: h, verts: d.vertices.filter((i) => i >= 0 && i < meta.n_vertices) };
  }));
  return { n: meta.n_vertices, faces, curv, heat, labels, meta,
           coords: Object.fromEntries(surfs.map((s, k) => [s, coords[k]])) };
}

async function loadSubject() {
  const sub = $("sub").value;
  if (!sub) return;
  const token = ++B.token;
  const keepView = view.viewers.length ? view.getViewState() : null;
  status(`Loading ${sub} lh + rh…`);
  try {
    const [lh, rh] = await Promise.all(HEMIS.map((h) => loadHemi(sub, h)));
    if (token !== B.token) return;
    B.sub = sub;
    B.data = { lh, rh };
    build(keepView);
    status(`${sub}: lh ${lh.n.toLocaleString()} + rh ${rh.n.toLocaleString()} vertices`);
    $("hover").textContent = "Hover a surface for hemisphere, vertex, value and labels · click to place the cursor";
  } catch (e) {
    if (token === B.token) status(`Load failed — ${e.message}`, true);
  }
}

// Join the shown hemispheres into one mesh per surface and hand it to the engine.
function build(keepView = null) {
  const shown = HEMIS.filter((h) => B.show[h] && B.data[h]);
  if (!shown.length) { status("Tick lh or rh", true); return; }
  B.offset = {};
  let n = 0;
  for (const h of shown) { B.offset[h] = n; n += B.data[h].n; }
  B.n = n;
  const surfs = B.session.surfaces.filter((s) => shown.every((h) => B.data[h].coords[s]));
  // Inflated hemispheres overlap: move lh left of x = -GAP/2 and rh right of +GAP/2.
  const shift = (s, h) => {
    if (s !== "inflated" || shown.length < 2) return 0;
    const c = B.data[h].coords[s];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < c.length; i += 3) { if (c[i] < lo) lo = c[i]; if (c[i] > hi) hi = c[i]; }
    return h === "lh" ? -GAP_MM / 2 - hi : GAP_MM / 2 - lo;
  };
  const surfaces = surfs.map((s) => {
    const out = new Float32Array(n * 3);
    for (const h of shown) {
      const c = B.data[h].coords[s], o = B.offset[h], dx = shift(s, h);
      out.set(c, 3 * o);
      if (dx) for (let i = 3 * o; i < 3 * (o + B.data[h].n); i += 3) out[i] += dx;
    }
    return [s, out];
  });
  const faces = new Int32Array(shown.reduce((k, h) => k + B.data[h].faces.length, 0));
  let fk = 0;
  for (const h of shown) {
    const f = B.data[h].faces, o = B.offset[h];
    for (let i = 0; i < f.length; i++) faces[fk + i] = f[i] + o;
    fk += f.length;
  }
  B.adj = M.buildAdjacency(faces, n);
  B.curv = new Float32Array(n);
  for (const h of shown) if (B.data[h].curv) B.curv.set(B.data[h].curv, B.offset[h]);
  B.heat = null;
  if (shown.some((h) => B.data[h].heat)) {
    const values = new Float32Array(n);
    for (const h of shown) if (B.data[h].heat) values.set(B.data[h].heat, B.offset[h]);
    let max = 0;
    for (const v of values) if (Number.isFinite(v) && v > max) max = v;
    B.heat = { values, max: Math.max(max, 1e-6) };
  }
  B.labels = shown.flatMap((h) => B.data[h].labels.map((l) => {
    const mask = new Uint8Array(n);
    const verts = Int32Array.from(l.verts, (v) => v + B.offset[h]);
    for (const i of verts) mask[i] = 1;
    const edge = M.maskOutline(B.adj, mask);
    return { set: l.set, name: l.name, hemi: h, verts, mask, outline: verts.filter((i) => edge[i]) };
  }));
  view.load(surfaces, faces, n);
  view.surfaceControls($("surf-toggles"));
  if (keepView) view.setViewState(keepView); else view.setView("ventral", "lh");
  B.cursorV = -1;
  renderNames();
  syncHeatWidgets();
}

// ---------------------------------------------------------------- sidebar
function syncHeatWidgets() {
  const on = !!B.heat;
  for (const id of ["thr", "thr-n", "heat-alpha", "heat-tt", "heat-outline"]) $(id).disabled = !on;
  $("colorbar").style.visibility = on ? "" : "hidden";
  if (!on) { view.requestColor(); return; }
  const max = B.heat.max, step = Math.max(max / 200, 1e-4);
  B.thr = Math.min(B.thr, max);
  Object.assign($("thr"), { min: 0, max, step, value: B.thr });
  Object.assign($("thr-n"), { min: 0, max, step, value: +B.thr.toPrecision(4) });
  const fmt = (x) => `${+x.toPrecision(3)}`, bar = document.querySelector("#colorbar .bar");
  if (B.heatTT) {
    const stops = [];
    for (let k = 0; k <= 40; k++) {
      const v = (k / 40) * max, a = v > B.thr ? 1 : (v / (B.thr || 1)) ** 2;
      const [r, g, b] = heatColor(k / 40).map(Math.round);
      stops.push(`rgba(${r},${g},${b},${a.toFixed(3)}) ${(k * 2.5).toFixed(1)}%`);
    }
    bar.style.background = `linear-gradient(90deg, ${stops.join(", ")}), #9a9a9a`;
    $("cb-mark").hidden = false;
    $("cb-mark").style.left = `${(100 * B.thr) / max}%`;
    $("cb-lo").textContent = "0"; $("cb-mid").textContent = `thr ${fmt(B.thr)}`; $("cb-hi").textContent = fmt(max);
  } else {
    bar.style.background = "";
    $("cb-mark").hidden = true;
    $("cb-lo").textContent = fmt(B.thr); $("cb-mid").textContent = ""; $("cb-hi").textContent = fmt(max);
  }
  view.requestColor();
}

function renderNames() {
  B.sets.forEach((set, s) => {
    const mine = B.labels.filter((l) => l.set === s);
    const names = [...new Set(mine.map((l) => l.name))].sort();
    const hemis = (n) => mine.filter((l) => l.name === n).map((l) => l.hemi).join(" ");
    $(`names-${s}`).innerHTML = names.length ? names.map((n) => `<li>
        <input type="checkbox" data-n="${esc(n)}" ${set.hidden.has(n) ? "" : "checked"}>
        <input type="color" data-c="${esc(n)}" value="${rgbHex(colorFor(s, n))}">
        <span class="name" title="${esc(n)}">${esc(n)}</span><span class="count" title="hemispheres with this label">${hemis(n)}</span></li>`).join("")
      : `<li class="empty">${set.folder ? "no labels in this folder" : "pick a folder"}</li>`;
  });
}

async function fillFolders() {
  let folders = [];
  try { folders = (await getJSON(`${B.session.subjects[0]}/lh/meta`)).label_folders; } catch {}
  folders = [...new Set([...(B.session.draw_folders || []), ...folders])].sort();
  B.sets.forEach((set, s) => {
    $(`folder-${s}`).innerHTML = `<option value="">none</option><option value="${FLAT}">label/ (flat: atlas, aparc.*)</option>` +
      folders.map((f) => `<option>${esc(f)}</option>`).join("");
    $(`folder-${s}`).value = set.folder === FLAT || folders.includes(set.folder) ? set.folder : "";
    set.folder = $(`folder-${s}`).value;
  });
}

async function fillHeatmaps() {
  let items = [];
  try { items = (await getJSON(`${B.session.subjects[0]}/lh/meta`)).layers.heatmap.items; } catch {}
  $("heat").innerHTML = `<option value="">none</option>` + items.map((n) => `<option>${esc(n)}</option>`).join("");
  $("heat").value = items.includes(B.heatName) ? B.heatName : "";
  B.heatName = $("heat").value;
}

function wire() {
  const step = (d) => {
    const sel = $("sub"), i = sel.selectedIndex + d;
    if (i < 0 || i >= sel.options.length) return;
    sel.selectedIndex = i;
    loadSubject();
  };
  $("sub").onchange = loadSubject;
  $("prev").onclick = () => step(-1);
  $("next").onclick = () => step(1);
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
    if (e.key === ",") step(-1);
    if (e.key === ".") step(1);
  });
  for (const h of HEMIS) {
    $(`show-${h}`).onchange = (e) => { B.show[h] = e.target.checked; build(view.getViewState()); };
  }
  $("heat").onchange = () => { B.heatName = $("heat").value; loadSubject(); };
  const setThr = (t) => { B.thr = Math.max(0, +t || 0); syncHeatWidgets(); };
  $("thr").oninput = (e) => setThr(e.target.value);
  $("thr-n").onchange = (e) => setThr(e.target.value);
  $("heat-alpha").oninput = (e) => { B.heatAlpha = +e.target.value; view.requestColor(); };
  $("heat-tt").onchange = (e) => { B.heatTT = e.target.checked; syncHeatWidgets(); };
  $("heat-outline").onchange = (e) => { B.heatOutline = e.target.checked; view.requestColor(); };
  $("fill-alpha").oninput = (e) => { B.fillAlpha = +e.target.value; view.requestColor(); };
  B.sets.forEach((set, s) => {
    $(`folder-${s}`).onchange = (e) => { set.folder = e.target.value; set.hidden.clear(); loadSubject(); };
    $(`fill-${s}`).onchange = (e) => { set.fill = e.target.checked; view.requestColor(); };
    $(`names-${s}`).onchange = (e) => {
      const n = e.target.dataset.n;
      if (n === undefined) return;
      e.target.checked ? set.hidden.delete(n) : set.hidden.add(n);
      view.requestColor();
    };
    $(`names-${s}`).oninput = (e) => {
      const n = e.target.dataset.c;
      if (n === undefined) return;
      B.colors[`${s}:${n}`] = hexRgb(e.target.value);
      view.requestColor();
    };
  });
  $("link").onchange = (e) => { view.link = e.target.checked; };
  $("cursor-on").onchange = (e) => { B.cursorOn = e.target.checked; view.setCursor(B.cursorOn ? B.cursorV : -1); };
  $("curv-on").onchange = (e) => { B.curvOn = e.target.checked; view.requestColor(); };
  curvatureControls($("curv-opts"), B.curvOpts, () => view.requestColor(), "delineationHelper.curv");
  $("views").onclick = (e) => {
    const { view: name, hemi } = e.target.dataset;
    if (name) view.setView(name, hemi || "lh");
  };
  $("png").onclick = () => {
    if (!B.n) return;
    const a = document.createElement("a");
    a.href = view.snapshot();
    a.download = [B.sub, "lh+rh", B.heatName].filter(Boolean).join("_") + ".png";
    a.click();
  };
}

// ---------------------------------------------------------------- sidebar toggle
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

async function init() {
  try {
    B.session = await getJSON("session");
  } catch (e) { status(`Could not reach the server — ${e.message}`, true); return; }
  B.heatName = "";   // opens without a heatmap; pick one in the sidebar
  // Pial opens see-through at 75 % with x-ray on, so labels down a sulcus
  // show; the engine keeps per-surface settings across subjects.
  view.surfState.pial = { visible: true, opacity: 0.75, wire: false, xray: true };
  wire();
  await Promise.all([fillHeatmaps(), fillFolders()]);
  $("sub").innerHTML = B.session.subjects.map((s) => `<option>${esc(s)}</option>`).join("");
  if (B.session.default_subject) $("sub").value = B.session.default_subject;
  await loadSubject();
}

init();
