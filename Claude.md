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
- **The only write endpoint is `POST /api/{sub}/{hemi}/drawn`**: folder and
  label name must match `NAME_RE` (one path component, no leading dot), so it
  can only write `<fs_dir>/<sub>/label/<folder>/<hemi>.<name>.label`.
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
- A hidden browser tab pauses `requestAnimationFrame` and ResizeObserver, so
  camera matrices go stale; `pick()` calls `updateMatrixWorld()` for that.

