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
- `example_dataset/freesurfer-with_t2/<sub>/label/anat_label_tiger/` is written
  by surface-annotate; it is the maintainer's data, not repo content — don't
  commit it unless asked.
