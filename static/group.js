// Group view (/group) — one surface (inflated or pial) per subject, 6 x 2 panels.
//
// Each panel is its own SurfaceViewer (subjects have different meshes), with
// its own subject dropdown and a 📌 "fixed" switch. Fixed panels move
// together: a camera change in one is copied to the others as direction, up,
// zoom and pan relative to each mesh's size (getViewState / setViewState), so
// every brain is framed the same way. An unfixed panel turns on its own.
// The heatmap, the two label sets (A anatomy, B ROI), surface and curvature
// settings apply to every panel.

import { SurfaceViewer, blend, paintCurvature, curvatureControls } from "./engine/viewer.js";
import * as M from "./engine/mesh.js";

const $ = (id) => document.getElementById(id);
const N_PANELS = 12;            // 6 columns x 2 rows (#grid in style.css)

const G = {
  session: null, hemi: "lh",
  heat: "", thr: 0.1, heatAlpha: 0.85, heatTT: true, heatOutline: true,
  surf: "inflated",
  look: { opacity: 1, wire: false, xray: true },   // every panel's surface display
  // Two label sets, each one label/ sub-folder read for every panel's subject:
  // A (anatomical landmarks) under B (your ROIs). Read through the server's
  // "manual" and "compare" layers with a folder override.
  sets: [
    { kind: "manual", folder: "tiger_anat_landmark", fill: false, hidden: new Set() },
    { kind: "compare", folder: "tiger_ROI_auto", fill: false, hidden: new Set() },
  ],
  fillAlpha: 0.6,
  curvOn: true, curvOpts: {},
  colors: {},                   // `${set}:${name}` -> [r,g,b], the same in every panel
  panels: [],
};
window.groupView = G; // for the devtools console

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
const labelDir = (s) => `${G.session.templates.atlas.replace(/\/+$/, "")}/${G.sets[s].folder}`;

// Landmark names (FG, IOG, ... exact) take their aparc.a2009s colour, names
// containing a word ROI (IOG-words, MOG-words brown, ...) their fixed ROI
// colour, in both sets as on the single page; everything else the next
// palette colour. By set + name, so one label is one colour in all panels.
let paletteNext = 0;
function colorFor(s, name) {
  const k = `${s}:${name}`;
  if (!G.colors[k]) {
    const low = name.toLowerCase();
    const anat = G.session.anat_colors?.[low];   // landmarks: exact name, aparc colours
    const roi = Object.entries(G.session.roi_colors).find(([r]) => low.includes(r));
    const pal = G.session.cluster_colors;
    G.colors[k] = hexRgb(anat || (roi ? roi[1] : pal[paletteNext++ % pal.length]));
  }
  return G.colors[k];
}

// Same ramp and transparent thresholding as the single page (app.js).
const HEAT = [[190, 25, 0], [255, 120, 0], [255, 235, 60]];
function heatColor(t) {
  const x = Math.min(1, Math.max(0, t)) * 2;
  const [a, b] = x < 1 ? [HEAT[0], HEAT[1]] : [HEAT[1], HEAT[2]];
  const f = x < 1 ? x : x - 1;
  return [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * f);
}

// ---------------------------------------------------------------- panels
function paintPanel(p, out) {
  const n = p.n;
  paintCurvature(out, p.curv, n, G.curvOn, G.curvOpts);
  if (p.heat) {
    const { values, max } = p.heat, thr = G.thr;
    if (G.heatTT) {
      for (let i = 0; i < n; i++) {
        const v = values[i];
        if (v > 0) blend(out, i, heatColor(v / max), G.heatAlpha * (v > thr ? 1 : (v / thr) ** 2));
      }
    } else {
      const span = max - thr || 1;
      for (let i = 0; i < n; i++) if (values[i] > thr) blend(out, i, heatColor((values[i] - thr) / span), G.heatAlpha);
    }
    if (G.heatOutline) {
      const edge = M.maskOutline(p.adj, Uint8Array.from(values, (v) => (v > thr ? 1 : 0)));
      for (let i = 0; i < n; i++) if (edge[i]) blend(out, i, [20, 20, 20], 0.85);
    }
  }
  for (const l of p.labels) {
    const set = G.sets[l.set];
    if (set.hidden.has(l.name)) continue;
    const c = colorFor(l.set, l.name);
    if (set.fill) for (const i of l.verts) blend(out, i, c, G.fillAlpha);
    for (const i of l.outline) blend(out, i, c, 1);
  }
}

let syncing = false;
function onCamera(p) {
  if (syncing || !p.fixed || !p.n) return;
  const st = p.view.getViewState();
  if (!st) return;
  syncing = true;
  for (const o of G.panels) if (o !== p && o.fixed && o.n) o.view.setViewState(st);
  syncing = false;
}
const groupState = (except) => G.panels.find((o) => o !== except && o.fixed && o.n)?.view.getViewState();

function makePanel(k) {
  const el = document.createElement("div");
  el.className = "gpanel";
  el.innerHTML = `<div class="ghead">
      <select class="gsub" title="subject in this panel"></select>
      <label class="gfix" title="fixed: rotates / zooms with the other fixed panels"><input type="checkbox" checked> 📌</label>
      <span class="gstat dim"></span>
    </div><div class="gview"></div>`;
  $("grid").appendChild(el);
  const p = { k, el, sub: "", fixed: true, n: 0, labels: [], heat: null, curv: null, adj: null, token: 0 };
  p.view = new SurfaceViewer(el.querySelector(".gview"), {
    paint: (out) => paintPanel(p, out),
    onCamera: () => onCamera(p),
    onHover: (v, vi) => {
      $("hover").textContent = vi < 0 ? "" : `${p.sub} ${G.hemi} · vertex ${vi}` +
        (p.heat ? ` · ${G.heat} = ${+p.heat.values[vi].toPrecision(4)}` : "") +
        (p.labels.filter((l) => l.mask[vi]).map((l) => ` · ${l.name}`).join(""));
    },
  });
  const sel = el.querySelector(".gsub");
  sel.innerHTML = `<option value="">—</option>` + G.session.subjects.map((s) => `<option value="${esc(s)}">${esc(s.replace(/^sub-/, ""))}</option>`).join("");
  sel.onchange = () => { p.sub = sel.value; loadPanel(p); };
  const fix = el.querySelector(".gfix input");
  fix.onchange = () => setFixed(p, fix.checked);
  return p;
}

function setFixed(p, on) {
  p.fixed = on;
  p.el.querySelector(".gfix input").checked = on;
  p.el.classList.toggle("free", !on);
  // Re-joining the group snaps to it.
  const st = on ? groupState(p) : null;
  if (st && p.n) p.view.setViewState(st);
}

// Everything for one panel: mesh, curvature, heatmap, labels. `token` drops
// a load overtaken by a newer one (fast subject switching).
async function loadPanel(p) {
  const token = ++p.token;
  const stat = p.el.querySelector(".gstat");
  if (!p.sub) {
    Object.assign(p, { n: 0, labels: [], heat: null });
    p.view.load([], new Int32Array(0), 0);
    stat.textContent = "";
    return;
  }
  stat.textContent = "loading…";
  try {
    const sub = p.sub, hemi = G.hemi;
    const meta = await getJSON(`${sub}/${hemi}/meta?${q({ heatmap: G.session.templates.heatmap,
      manual: G.sets[0].folder ? labelDir(0) : "", compare: G.sets[1].folder ? labelDir(1) : "" })}`);
    const SURF = G.surf;
    if (!meta.surfaces.includes(SURF)) throw new Error(`no ${hemi}.${SURF}`);
    const [faces, coords, curv] = await Promise.all([
      getBin(`${sub}/${hemi}/faces`, Int32Array),
      getBin(`${sub}/${hemi}/surface/${SURF}`, Float32Array),
      meta.has_curv ? getBin(`${sub}/${hemi}/curv`, Float32Array) : null,
    ]);
    if (token !== p.token) return;
    const n = meta.n_vertices, adj = M.buildAdjacency(faces, n);
    let heat = null;
    if (G.heat && meta.layers.heatmap.items.includes(G.heat)) {
      const values = await getBin(`${sub}/${hemi}/heatmap?${q({ name: G.heat, dir: G.session.templates.heatmap })}`, Float32Array);
      let max = 0;
      for (const v of values) if (Number.isFinite(v) && v > max) max = v;
      heat = { values, max: Math.max(max, 1e-6) };
    }
    const wanted = G.sets.flatMap((set, s) => {
      const L = meta.layers[set.kind];
      return set.folder && L.exists ? L.items.map((name) => [s, name]) : [];
    });
    const labels = await Promise.all(wanted.map(async ([s, name]) => {
      const d = await getJSON(`${sub}/${hemi}/layer?${q({ kind: G.sets[s].kind, name, dir: labelDir(s) })}`);
      const verts = Int32Array.from(d.vertices.filter((i) => i >= 0 && i < n));
      const mask = new Uint8Array(n);
      for (const i of verts) mask[i] = 1;
      const edge = M.maskOutline(adj, mask);
      return { set: s, name, verts, mask, outline: verts.filter((i) => edge[i]) };
    }));
    if (token !== p.token) return;
    Object.assign(p, { n, adj, curv, heat, labels });
    p.view.load([[SURF, coords]], faces, n);
    applyLook(p);
    p.el.querySelector(".tag").textContent = sub;
    const st = p.fixed ? groupState(p) : null;
    if (st) p.view.setViewState(st); else p.view.setView("ventral", hemi);
    const nSet = (s) => labels.filter((l) => l.set === s).length;
    stat.textContent = (G.heat && !heat ? "no map · " : "") + `A ${nSet(0)} · B ${nSet(1)}`;
    stat.title = G.heat && !heat ? `${sub} has no ${G.heat}` : "";
    renderNames();
    updateRange();
  } catch (e) {
    if (token !== p.token) return;
    stat.textContent = "failed";
    stat.title = e.message;
    status(`${p.sub}: ${e.message}`, true);
  }
}

const loadAll = () => Promise.all(G.panels.map(loadPanel));

// Opacity / mesh / x-ray (the engine's per-surface display), on every panel.
function applyLook(p) {
  for (const v of p.view.viewers) {
    p.view.setOpacity(v, G.look.opacity);
    p.view.setWire(v, G.look.wire);
    p.view.setXray(v, G.look.xray);
  }
}
const applyLookAll = () => { for (const p of G.panels) applyLook(p); };
const repaint = () => { for (const p of G.panels) p.view.requestColor(); };

// ---------------------------------------------------------------- sidebar
// Threshold slider up to the largest maximum among the loaded maps.
function updateRange() {
  const max = Math.max(1e-6, ...G.panels.map((p) => p.heat?.max || 0));
  for (const id of ["thr", "thr-n"]) Object.assign($(id), { max, step: Math.max(max / 200, 1e-4) });
  $("thr").value = G.thr;
}
function setThr(t) {
  G.thr = Math.max(0, +t || 0);
  $("thr").value = G.thr;
  $("thr-n").value = +G.thr.toPrecision(4);
  repaint();
}

function renderNames() {
  G.sets.forEach((set, s) => {
    const mine = (p) => p.labels.filter((l) => l.set === s);
    const names = [...new Set(G.panels.flatMap((p) => mine(p).map((l) => l.name)))].sort();
    const count = (n) => G.panels.filter((p) => mine(p).some((l) => l.name === n)).length;
    $(`names-${s}`).innerHTML = names.length ? names.map((n) => `<li>
        <input type="checkbox" data-n="${esc(n)}" ${set.hidden.has(n) ? "" : "checked"}>
        <input type="color" data-c="${esc(n)}" value="${rgbHex(colorFor(s, n))}">
        <span class="name">${esc(n)}</span><span class="count" title="panels with this label">${count(n)}</span></li>`).join("")
      : `<li class="empty">${set.folder ? "no labels in this folder" : "pick a folder"}</li>`;
  });
}

async function fillFolders() {
  // The label/ sub-folders of the first subject, plus the step folders.
  let folders = [];
  try {
    const meta = await getJSON(`${G.session.subjects[0]}/${G.hemi}/meta`);
    folders = meta.label_folders;
  } catch {}
  folders = [...new Set([...(G.session.draw_folders || []), ...folders])].sort();
  G.sets.forEach((set, s) => {
    $(`folder-${s}`).innerHTML = `<option value="">none</option>` + folders.map((f) => `<option>${esc(f)}</option>`).join("");
    $(`folder-${s}`).value = folders.includes(set.folder) ? set.folder : "";
    set.folder = $(`folder-${s}`).value;
  });
}

async function fillHeatmaps() {
  let items = [];
  try {
    const meta = await getJSON(`${G.session.subjects[0]}/${G.hemi}/meta`);
    items = meta.layers.heatmap.items;
  } catch {}
  $("heat").innerHTML = `<option value="">none</option>` + items.map((n) => `<option>${esc(n)}</option>`).join("");
  $("heat").value = items.includes(G.heat) ? G.heat : "";
  G.heat = $("heat").value;
}

function wire() {
  $("hemi").onchange = async () => { G.hemi = $("hemi").value; await fillHeatmaps(); await loadAll(); };
  $("heat").onchange = () => { G.heat = $("heat").value; loadAll(); };
  $("thr").oninput = (e) => setThr(e.target.value);
  $("thr-n").onchange = (e) => setThr(e.target.value);
  $("heat-alpha").oninput = (e) => { G.heatAlpha = +e.target.value; repaint(); };
  $("heat-tt").onchange = (e) => { G.heatTT = e.target.checked; repaint(); };
  $("heat-outline").onchange = (e) => { G.heatOutline = e.target.checked; repaint(); };
  $("fill-alpha").oninput = (e) => { G.fillAlpha = +e.target.value; repaint(); };
  G.sets.forEach((set, s) => {
    $(`folder-${s}`).onchange = (e) => { set.folder = e.target.value; set.hidden.clear(); loadAll(); };
    $(`fill-${s}`).onchange = (e) => { set.fill = e.target.checked; repaint(); };
    $(`names-${s}`).onchange = (e) => {
      const n = e.target.dataset.n;
      if (n === undefined) return;
      e.target.checked ? set.hidden.delete(n) : set.hidden.add(n);
      repaint();
    };
    $(`names-${s}`).oninput = (e) => {
      const n = e.target.dataset.c;
      if (n === undefined) return;
      G.colors[`${s}:${n}`] = hexRgb(e.target.value);
      repaint();
    };
  });
  $("surf").onchange = (e) => { G.surf = e.target.value; loadAll(); };
  $("surf-alpha").oninput = (e) => { G.look.opacity = +e.target.value; applyLookAll(); };
  $("surf-wire").onchange = (e) => { G.look.wire = e.target.checked; applyLookAll(); };
  $("surf-xray").onchange = (e) => { G.look.xray = e.target.checked; applyLookAll(); };
  $("curv-on").onchange = (e) => { G.curvOn = e.target.checked; repaint(); };
  curvatureControls($("curv-opts"), G.curvOpts, repaint, "delineationHelper.curv");
  $("views").onclick = (e) => {
    const name = e.target.dataset.view;
    if (name) for (const p of G.panels) if (p.fixed && p.n) p.view.setView(name, G.hemi);
  };
  $("fix-all").onclick = () => { for (const p of G.panels) setFixed(p, true); };
  $("free-all").onclick = () => { for (const p of G.panels) setFixed(p, false); };
  $("png").onclick = savePNG;
}

// All panels in their grid places, each with its subject written on it.
async function savePNG() {
  const shots = await Promise.all(G.panels.map(async (p) => {
    if (!p.n) return null;
    const img = new Image();
    img.src = p.view.snapshot();
    await img.decode();
    return img;
  }));
  const first = shots.find(Boolean);
  if (!first) return;
  const w = first.width, h = first.height, cols = 6;
  const out = document.createElement("canvas");
  out.width = w * cols;
  out.height = h * Math.ceil(N_PANELS / cols);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#0f1115";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.font = `${Math.round(h / 16)}px system-ui, sans-serif`;
  ctx.fillStyle = "#e3e5ea";
  shots.forEach((img, k) => {
    if (!img) return;
    const x = (k % cols) * w, y = Math.floor(k / cols) * h;
    ctx.drawImage(img, x, y, w, h);
    ctx.fillText(G.panels[k].sub, x + 10, y + h / 12);
  });
  const a = document.createElement("a");
  a.href = out.toDataURL("image/png");
  a.download = ["group", G.hemi, G.surf, G.heat, ...G.sets.map((s) => s.folder)].filter(Boolean).join("_") + ".png";
  a.click();
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
    G.session = await getJSON("session");
  } catch (e) { status(`Could not reach the server — ${e.message}`, true); return; }
  G.hemi = G.session.default_hemi || "lh";
  $("hemi").value = G.hemi;
  G.heat = "";   // opens without a heatmap; pick one in the sidebar
  $("surf").innerHTML = G.session.surfaces.map((s) => `<option>${esc(s)}</option>`).join("");
  G.surf = G.session.surfaces.includes("inflated") ? "inflated" : G.session.surfaces[0];
  $("surf").value = G.surf;
  wire();
  await Promise.all([fillHeatmaps(), fillFolders()]);
  for (let k = 0; k < N_PANELS; k++) G.panels.push(makePanel(k));
  // The first 12 subjects, in order; the dropdowns change them one by one.
  G.panels.forEach((p, k) => {
    p.sub = G.session.subjects[k] || "";
    p.el.querySelector(".gsub").value = p.sub;
  });
  status(`${G.session.subjects.length} subjects`);
  await loadAll();
  $("hover").textContent = "Hover a surface for its value · 📌 fixed panels move together";
}

init();
