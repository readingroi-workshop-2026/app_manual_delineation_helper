# Claude.md — app_manual_delineation_helper

Project-specific context. Shared conventions are in `../CLAUDE.md` (uv,
three-way env files, CITATION.cff, tag-driven releases). This repo keeps its
existing **flat layout** (`app.py`, `utils/`, `scripts/`) and is not a package
(`[tool.uv] package = false`).

## What this repo is

A browser surface viewer for the reading-ROI delineation workshop: heatmaps,
auto clusters, atlas and manual labels on inflated + pial side by side, plus
drawing (Contour / Brush / Erase tabs) of labels saved to
`<fs_dir>/<sub>/label/<folder>/`. The brush/contour interaction is ported from
`../app_surface_annotate`'s app.js (not shared code); `static/draw.js` holds
this repo's own DOM-free fill/dilate/erode, so the vendored engine stays an
untouched copy. `scripts/make_annot.py` combines a folder's ROIs into an annot.
The `scripts/`
(`gen_manual_label*.py`, `sync_autoroi_maps.py`, ...) are the CSV → label
pipeline and follow the analysis-script conventions; the viewer does not.

- `app.py` — FastAPI server + typer CLI. Lists the four layer folders and
  serves files; only names its listings return are served.
- `static/app.js` — layer logic, painted into the engine's shared colour buffer.
- `static/vendor/surface_annotate/{viewer.js,mesh.js}` — **vendored copies** of
  surface-annotate's engine. Never edit them here: change them upstream, then
  copy (see the README in that folder). `test_vendored_engine_matches_surface_annotate`
  fails when the sibling checkout exists and the copies differ.
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
- Curvature options, the cursor marker and the x-ray of buried labels come from
  the vendored engine (see app_surface_annotate's Claude.md).
