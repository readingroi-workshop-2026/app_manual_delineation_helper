# Claude.md — app_manual_delineation_helper

Project-specific context. Shared conventions are in `../CLAUDE.md` (uv,
three-way env files, CITATION.cff, tag-driven releases). This repo keeps its
existing **flat layout** (`app.py`, `utils/`, `scripts/`) and is not a package
(`[tool.uv] package = false`).

## What this repo is

A browser surface viewer for the reading-ROI delineation workshop: heatmaps,
auto clusters, atlas and manual labels on inflated + pial side by side, plus
drawing (Contour / Brush / Erase tabs) of labels saved to
`<fs_dir>/<sub>/label/<folder>/`. The brush/contour interaction was ported from
app_surface_annotate (retired 2026-10-05); `static/draw.js` holds this repo's
own DOM-free fill/dilate/erode, so the engine stays app-agnostic. `scripts/make_annot.py` combines a folder's ROIs into an annot.
The `scripts/`
(`gen_manual_label*.py`, `sync_autoroi_maps.py`, ...) are the CSV → label
pipeline and follow the analysis-script conventions; the viewer does not.

- `app.py` — FastAPI server + typer CLI. Lists the four layer folders and
  serves files; only names its listings return are served.
- `static/app.js` — layer logic, painted into the engine's shared colour buffer.
- `static/engine/{viewer.js,mesh.js}` — the surface engine, **master copy
  here** since app_surface_annotate was retired (2026-10-05). Edit it here,
  then copy both files to `../app_surface_t1w_labeling/src/surface_t1w_labeling/static/vendor/engine/`
  (see `static/engine/README.md`); `test_engine_copy_matches_t1w_labeling`
  fails while that copy differs. `node --test tests/mesh.test.mjs` tests mesh.js
  (moved here from surface-annotate). Keep the engine free of app UI / state.
- `utils/` — config/path templates (`config.py`, also used by `scripts/`),
  discovery of layer files, label/gifti readers, surface loading.

## Non-obvious facts

- **Static files are live, Python is not.** A page reload picks up JS/CSS/HTML
  edits; `app.py`, `utils/` or `config.yaml` changes need the server restarted.
  Tell the maintainer which one a change needs.
- **Cluster IDs are per subject.** On a subject switch only fully ticked
  contrasts are re-ticked, never single cluster IDs.
- Heatmap/cluster files are matched by BIDS `hemi-L/R`; atlas/manual labels by
  FreeSurfer `lh./rh.` prefix (`normalize_hemi` returns both).
- **The only write endpoints are `POST` and `DELETE /api/{sub}/{hemi}/drawn`**:
  folder and label name must match `NAME_RE` (one path component, no leading
  dot), so they can only write / delete `<fs_dir>/<sub>/label/<folder>/<hemi>.<name>.label`
  (delete also removes its `.contour.json` sidecar). The page's *Delete active*
  button and each row's 🗑 call DELETE after a confirm showing the full path;
  × only drops a label from the session.
- **mris_label2annot maps the k-th `--l` to ctab index k.** `make_annot.py`
  writes the ctab from the labels actually passed, and uses `--no-unknown`
  with a 0-based ctab: without it unlabelled vertices are index 0 and nibabel
  (so this app) reads every region name off by one.
- **Drawn-label folders = delineation steps.** The maintainer works in three
  steps, one `label/` folder each (`config.yaml` → `draw_label_folders`,
  offered in the "Save to" dropdown `#draw-folder-pick`, filled by
  `fillFolderPick()` from the session list + the subject's own folders):
  `tiger_ROI_auto` (ROIs from the auto clusters, e.g. RWvsAllNotext_score),
  `tiger_ROI_manual` (ROIs from a t-threshold map, e.g. RWvsAllNotext_mean_raw),
  `tiger_anat_landmark` (anatomical landmarks by hand). `draw_label_dir` is the
  start folder. On 2026-10-05 sub-02's `tiger_delineation_autocluster`,
  `tiger_delineation_t-threshold` and `anat_label_tiger` were renamed to these
  three, and the three (empty) folders were created for every subject. Empty
  folders are not in git.
- **Three pages, one server.** `/` and `/compare` both serve `index.html`;
  `app.js` reads `location.pathname` (`PAGE`, `COMPARE`). `/group` is its own
  `group.html` + `group.js`. Header links `.pages` switch between them.
- **Compare page = engine rows.** `view.load(..., { rows: ["ref", "compare"] })`
  gives two rows of panels, each row its own colour buffer; `paint(out, row)`
  skips layer `manual` (the reference) in row 1 and layer `compare` outside
  row 1. Everything else (heatmap, clusters, atlas, drawn labels, path,
  cursor) is painted in both rows, so drawing in any panel edits one label
  set. `compare` is a fifth layer kind on the server (`LAYER_KEYS`,
  config `compare_label_dir`), listed / served like `manual`. `tickAll()`
  ticks every label of both folders on listing; `rowTags()` names rows after
  their folders.
- **Group page = one SurfaceViewer per panel** (subjects have different
  meshes; 12 WebGL contexts, browsers allow ~16). Linking is done in
  `group.js`, not the engine: the engine's `onCamera(v)` hook fires on every
  camera change, and a fixed panel copies `getViewState()` to the other fixed
  panels with `setViewState()` (relative to mesh size, so subjects of
  different size frame alike). The echo back from the followers converges
  (identical state), no loop. Labels come from `label/<folder>/` through the
  `manual` layer with a `dir` override.
- **Navigate | Draw tabs.** `#tools` has Navigate and Draw; `#draw-tools`
  inside Draw has Contour / Brush / Erase (`setTool("draw")` returns to
  `S.lastDrawTool`). The heatmap section is Navigate-only. `setTool` toggles
  tool classes on `#viewers` with classList: assigning `className` dropped the
  compare page's `rows` class and collapsed it to one row.
- **Drawn labels are not auto-opened** (maintainer: one place controls what is
  shown). `loadDrawn()` only points at the Save-to folder; `openSaved()`
  ("Open saved labels to edit (N)") loads its files into `S.drawn`. On the
  compare page `drawRow()` paints drawn labels only in the row whose folder
  is the Save-to folder (both if neither). Compare and group pages open with
  no heatmap.
- **Group page label sets**: A (anatomy, server layer `manual`) and B (ROI,
  layer `compare`), each with a `dir` override per folder; colours keyed
  `set:name`, fixed ROI colours (`ROI_COLORS`, MOG brown) in both sets.
  *View › Surface* picks inflated / pial (config `surfaces`).
  Opacity / mesh / x-ray (`G.look`) are applied by `applyLook()` to every
  panel and again after each panel load (a surface switch makes new viewers).
- **Label colours**: landmarks by exact name from `ANAT_COLORS`
  (`utils/discovery.py`; aparc.a2009s colours for FG, IOG, ITG, MOG, OTS;
  maintainer's MFS green, PON cyan -- not in aparc), then word ROIs by
  substring from `ROI_COLORS` (MOG-words brown), then the palette. Session key
  `anat_colors`; used by app.js and group.js `colorFor`.
- **No-cache headers** on everything outside `/api/` (`revalidate_static`
  middleware): without them the browser kept an old `viewer.js` next to a new
  `index.html` while testing the compare page.
- **Heatmap badge on each surface panel.** `heatBadges()` (called from
  `syncThresholdWidgets()` and after `view.load`) puts the loaded map's name
  and a copy of the sidebar `#colorbar` (gradient, threshold tick, numbers)
  bottom-right of every `.viewer`; removed when no heatmap is loaded. It is
  DOM, not canvas, so *Save PNG* does not include it.
- **Name suggestions follow the Save-to folder.** `config.yaml` →
  `draw_label_names` maps a folder to its names (tiger_anat_landmark: FG, IOG,
  ITG, MFS, PON, OTS, MOG); `roiNames()` fills the `#roi-names` datalist from
  it in `fillFolderPick()`, falling back to the word-ROI names. Before this the
  list was always the word ROIs, so landmark names only appeared for subjects
  that already had them saved.
- **What the compare page compares (2026-10-06).** `tiger_delineation` is the
  OLD delineation: real words vs scrambled words (RWvsSC), a 5-ROI framework
  (IOG, PON, pOTS, mOTS, mFus -words) that did NOT separate IOG from MOG.
  `tiger_ROI_auto` is the NEW one, from the RWvsAllNotext auto clusters, which
  DOES separate IOG from MOG (6 ROIs: + LOC-words). Expect the differences in
  the IOG / MOG territory; they come from the framework change.
- The example dataset's `label/` folders are the maintainer's data. Commit
  them only when asked (sub-02's renamed folders were, on request).
- **Cursor (Navigate tab).** A click calls the engine's `setCursor(vertex)`;
  `describe()` builds both the readout and the bottom bar. The bottom bar always
  shows an ANATOMICAL surface (pial, else white), never inflated: inflated
  coordinates are not positions in the brain and read as nonsense (x = 4.8 for
  a left-hemisphere vertex). The readout marks them "not anatomical".
- **T1w coordinates: `GET /api/{sub}/{hemi}/t1w/{vertex}`** -> white and pial
  in tkr RAS, scanner RAS (`Norig @ inv(Torig)` from mri/orig.mgz, else the
  surface's c_ras; `utils/surface.tkr_to_scanner`) and the T1.mgz voxel. The
  voxel is given in **x, y, z (RAS+ canonical) order** -- identical to the
  sampling tool's / WM page's -- and separately as the raw file index
  (`voxel_file`). A conformed .mgz is stored LIA, so the file index reads
  (x, z, y) flipped; showing only that one was mistaken for z-first.
- **Fill from seed** (Contour, Click: fills from seed, F). Ticking "inside the
  thresholded map" switches the click to fill, and choosing fill with a heatmap
  loaded ticks it: without that bound a fill floods 100% of the hemisphere.
  A seed below the bound snaps to the nearest passing vertex within `SNAP_MM`
  (3 mm, on pial) -- transparent thresholding draws the sub-threshold rim, so
  people click it.
- **Cutting a region with a path.** With "up to and including the path" the
  wall is the path EXACTLY as drawn, i.e. OPEN (`contourPath(false)`). It used
  to be closed last -> first once it had 3 points, which cut a big region a
  second time; Enter is what closes a path. `seedFill` re-floods without the
  wall and warns when the path does not split the region (an end inside it).
- Curvature options, the cursor marker and the x-ray of buried labels live in
  the engine (`static/engine/viewer.js`); see "Engine facts" below.

## Engine facts (static/engine/, carried over from app_surface_annotate)

- **One colour buffer, two meshes.** Both geometries share the same
  `BufferAttribute` for vertex colours; that is what makes a drawing show on
  both surfaces at no cost. They must NOT share the index buffer: MeshBVH
  reorders the index in place, and a shared one silently breaks picking on
  the first mesh.
- **three.js comes from jsDelivr** (import map in `index.html`). The browser
  needs internet; the server does not. three-mesh-bvh is optional — if it
  fails to load, picking falls back to brute-force raycasting.
- **Depth-cued contour.** The contour line and points are drawn twice from
  one shared geometry: a depth-tested bright pass, and a `GreaterDepth` pass
  (dim, dashed) that only shows where the surface is in front. Don't switch
  depth testing off for the line: an always-on-top line looks the same on a
  gyrus and in a sulcus, which is exactly what the maintainer complained about.
- **Opacity = glass, not x-ray.** Below 1 the mesh is transparent but a
  depth-only prepass (`depthPre`) keeps only the front layer; buried layers are
  never blended in (that looked flat and grey). The same prepass keeps the
  wireframe front-only.
- **...except the coloured vertices** (`v.xray`): below opacity 1 an unlit
  GreaterDepth pass draws what lies behind the front layer, weighted by how
  coloured each vertex is (`hlAttr`, from the shared colour buffer: curvature
  is grey, so only labels / clusters / heatmap show). Strength rises as opacity
  falls; per-surface `x-ray` switch in `surfaceControls`.
- **Lighting**: Phong, a key light above-left of the camera, a weak headlight
  and low ambient, so gyral crowns catch light and sulcal walls fall into shade.
- **Linked cameras** sync rotation, zoom and pan as fractions of each mesh's
  bounding radius (`syncFrom`), because inflated and pial differ in size.
- **Rows** (`load(surfaces, faces, n, { rows })`): one colour + x-ray buffer
  per row, `.viewer-row` divs and `#viewers.rows` only when there are 2+ rows
  (the T1w tool's single-row DOM is unchanged). `surfaceControls` shows one
  control row per surface, applied in every row; `snapshot()` stacks rows.
  `onCamera(v)` hook: any camera change, for linking across instances.
- A hidden browser tab pauses `requestAnimationFrame` and ResizeObserver, so
  camera matrices go stale; `pick()` calls `updateMatrixWorld()` for that.

