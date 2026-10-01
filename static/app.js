// Delineation helper — view heatmaps, auto clusters, atlas and manual labels
// on inflated + pial side by side (the surface-annotate engine, vendored).
//
// Everything is painted into the engine's one per-vertex colour buffer, so
// each layer shows on both surfaces, and every toggle is applied in the
// browser immediately — the server only hands out files.

import { SurfaceViewer, blend, paintCurvature } from "./vendor/surface_annotate/viewer.js";
import * as M from "./vendor/surface_annotate/mesh.js";

const $ = (id) => document.getElementById(id);
const KINDS = ["clusters", "atlas", "manual"];
const CUSTOM = "__custom__";

const S = {
  session: null, meta: null,
  sub: null, hemi: "lh", n: 0, adj: null, curv: null, curvOn: true,
  templates: {},        // layer -> folder template ({sub} allowed)
  heat: null,           // {name, values, min, max}
  heatAlpha: 0.85,
  thresholds: {},       // heatmap name -> threshold, kept across subjects
  items: new Map(),     // `${kind}:${name}` -> loaded label/annot layer
  colors: {},           // `${kind}:${name}` -> [r,g,b], kept across subjects
  clusterFill: false,
  fillAlpha: 0.6,
  open: new Set(),      // expanded contrast / annot rows
  highlight: null,      // item key hovered in the legend: drawn filled
};

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
    const roi = Object.entries(S.session.roi_colors).find(([r]) => low.includes(r));
    const pal = S.session.cluster_colors;
    S.colors[k] = hexRgb(roi ? roi[1] : pal[paletteNext++ % pal.length]);
  }
  return S.colors[k];
}

// ---------------------------------------------------------------- engine
const view = new SurfaceViewer($("viewers"), { paint, onHover: hoverAt });
window.delineationHelper = { S, view }; // for the devtools console

// Red -> orange -> yellow, from the threshold up to the map's maximum.
const HEAT = [[190, 25, 0], [255, 120, 0], [255, 235, 60]];
function heatColor(t) {
  const x = Math.min(1, Math.max(0, t)) * 2;
  const [a, b] = x < 1 ? [HEAT[0], HEAT[1]] : [HEAT[1], HEAT[2]];
  const f = x < 1 ? x : x - 1;
  return [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * f);
}

function paint(out) {
  const n = S.n;
  paintCurvature(out, S.curv, n, S.curvOn);
  if (S.heat) {
    const { values, max } = S.heat;
    const thr = currentThreshold();
    const span = max - thr || 1;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v > thr) blend(out, i, heatColor((v - thr) / span), S.heatAlpha);
    }
  }
  // Layer order: clusters, then atlas (annots under labels), then manual.
  for (const kind of KINDS) {
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
}

function hoverAt(v, vi) {
  if (vi < 0) { $("hover").textContent = ""; return; }
  const c = view.coords[v.surf];
  const parts = [`vertex ${vi}`,
    `${v.surf} (${c[3 * vi].toFixed(1)}, ${c[3 * vi + 1].toFixed(1)}, ${c[3 * vi + 2].toFixed(1)})`];
  if (S.curv) parts.push(`curv ${S.curv[vi].toFixed(3)}`);
  if (S.heat) parts.push(`${S.heat.name}: ${S.heat.values[vi].toFixed(3)}`);
  for (const it of S.items.values()) {
    if (!it.on || it.hidden) continue;
    if (it.type === "annot") {
      const k = it.labels[vi];
      parts.push(`${it.name}: ${k >= 0 ? it.names[k] : "—"}`);
    } else if (it.mask[vi]) parts.push(it.name);
  }
  $("hover").textContent = parts.join("  ·  ");
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
  for (const id of ["thr", "thr-n", "heat-alpha"]) $(id).disabled = !on;
  $("colorbar").style.visibility = on ? "" : "hidden";
  if (!on) return;
  const thr = currentThreshold();
  const step = Math.max(S.heat.max / 200, 1e-4);
  Object.assign($("thr"), { min: 0, max: S.heat.max, step, value: thr });
  Object.assign($("thr-n"), { min: 0, max: S.heat.max, step, value: +thr.toPrecision(4) });
  $("cb-lo").textContent = `${+thr.toPrecision(3)}`;
  $("cb-hi").textContent = `${+S.heat.max.toPrecision(3)}`;
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
  const sel = $("manual-folder");
  const atlas = S.templates.atlas.replace(/\/+$/, "");
  const opts = S.meta.label_folders.map((f) => [`${atlas}/${f}`, `${f}/`]);
  sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("") +
    `<option value="${CUSTOM}">other folder (type below)…</option>`;
  sel.value = opts.some(([v]) => v === S.templates.manual) ? S.templates.manual : CUSTOM;
}

// ---------------------------------------------------------------- legend
// Every ticked label/cluster, grouped: click hides/shows it on the surface
// (it stays ticked), double-click shows only it within its group, hover fills
// it -- the quick way to go through clusters one by one and map them to ROIs.
const GROUP_TITLES = { atlas: "Atlas", manual: "Manual" };

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
  for (const kind of ["atlas", "manual"]) {
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
  view.requestColor();
}

async function loadSubject() {
  const sub = $("sub").value, hemi = $("hemi").value;
  if (!sub) return;
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
    Object.assign(S, { meta, n: meta.n_vertices, heat: null, items: new Map(), highlight: null });
    renderLegend();
    S.adj = M.buildAdjacency(faces, S.n);
    view.load(surfaces, faces, S.n);
    view.surfaceControls($("surf-toggles"));
    if (keepView) view.setViewState(keepView, mirror);
    else view.setView("ventral", hemi);
    renderHeatmaps();
    for (const kind of KINDS) renderLayer(kind);
    renderManualFolders();

    const heatNames = meta.layers.heatmap.items;
    const firstHeat = keepHeat ?? `${S.session.default_contrast}_score`;
    if (heatNames.includes(firstHeat)) { $("heat").value = firstHeat; await setHeatmap(firstHeat); }
    else syncThresholdWidgets();
    const byContrast = meta.layers.clusters.by_contrast;
    const clusterNames = keepContrasts.flatMap((c) => byContrast[c] || []);
    if (clusterNames.length) await setOn("clusters", clusterNames, true);
    for (const kind of ["atlas", "manual"]) {
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
    renderLegend();
    view.requestColor();
    status(`${sub} ${hemi}: ${S.n.toLocaleString()} vertices`);
    $("hover").textContent = "";
  } catch (e) {
    console.error(e);
    status(`Load failed — ${e.message}`, true);
  }
}

// ---------------------------------------------------------------- UI wiring
function wire() {
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
  $("heat-alpha").oninput = (e) => { S.heatAlpha = +e.target.value; view.requestColor(); };
  $("cluster-fill").onchange = (e) => { S.clusterFill = e.target.checked; view.requestColor(); };
  $("fill-alpha").oninput = (e) => { S.fillAlpha = +e.target.value; view.requestColor(); };
  for (const el of document.querySelectorAll(".dir")) {
    const kind = el.dataset.kind;
    el.onkeydown = (e) => { if (e.key === "Enter") el.blur(); };
    el.onchange = () => {
      S.templates[kind] = el.value.trim();
      if (kind === "manual") renderManualFolders();
      refreshLayer(kind);
    };
  }
  for (const el of document.querySelectorAll(".filter")) el.oninput = () => renderLayer(el.dataset.kind);
  $("manual-folder").onchange = (e) => {
    if (e.target.value === CUSTOM) { document.querySelector(".dir[data-kind=manual]").focus(); return; }
    S.templates.manual = e.target.value;
    document.querySelector(".dir[data-kind=manual]").value = e.target.value;
    refreshLayer("manual");
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
  $("views").onclick = (e) => e.target.dataset.view && view.setView(e.target.dataset.view, S.hemi);
  $("png").onclick = () => {
    if (!S.meta) return;
    const parts = [S.sub, S.hemi];
    if (S.heat) parts.push(S.heat.name, `thr${+currentThreshold().toPrecision(3)}`);
    const a = document.createElement("a");
    a.href = view.snapshot();
    a.download = `${parts.join("_")}.png`;
    a.click();
  };
}

async function init() {
  wire();
  try {
    S.session = await getJSON("session");
    S.templates = { ...S.session.templates };
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
init();
