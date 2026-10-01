# Claude.md — app_manual_delineation_helper

Project-specific context. Shared conventions are in `../CLAUDE.md` (uv,
three-way env files, CITATION.cff, tag-driven releases). This repo keeps its
existing **flat layout** (`app.py`, `utils/`, `scripts/`) and is not a package
(`[tool.uv] package = false`).

## What this repo is

A browser surface viewer for the reading-ROI delineation workshop: heatmaps,
auto clusters, atlas and manual labels on inflated + pial side by side. It is
view-only — drawing lives in `../app_surface_annotate`. The `scripts/`
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
- `example_dataset/freesurfer-with_t2/<sub>/label/anat_label_tiger/` is written
  by surface-annotate; it is the maintainer's data, not repo content — don't
  commit it unless asked.
