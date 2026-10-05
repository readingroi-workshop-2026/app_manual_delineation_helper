# Changelog

All notable changes to the VOTCLOC surface viewer are documented here.
This project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

## [Unreleased]

### Added
- **Transparent thresholding** of the heatmap (Taylor, Aggarwal & Bandettini
  2026, Nature Methods, doi:10.1038/s41592-026-03206-7), on by default:
  suprathreshold opaque and outlined, subthreshold fading as `(v/thr)²`;
  colour bar shows 0 → max with a threshold tick. Toggle back to a hard cut.
- **Drawing.** Sidebar tabs Navigate · Contour · Brush · Erase. Contour draws
  shortest-path paths (close & fill) and FreeView-style seeded fills bounded by
  the path, heatmap > threshold, sulci/gyri, the clicked layer label / annot
  region, and other drawn labels; fills add or remove. Brush/Erase as in
  surface-annotate. Trim to heatmap/curv, fill holes, dilate, erode, undo.
  Labels save to `<fs_dir>/<sub>/label/<folder>/` (folder editable in the page,
  default `draw_label_dir`); word-ROI names are suggested.
- `scripts/make_annot.py`: combine a folder's ROI labels into a `.annot` with
  a fixed colour per ROI (`WORD_ROIS`, adds `LOC-words`).

### Changed
- **New viewer GUI.** Streamlit + Plotly are replaced by a browser page served
  by `app.py` (FastAPI + typer CLI; `uv run app.py`, `./launch.sh`). Surfaces
  are rendered by the three.js engine of surface-annotate, vendored under
  `static/vendor/surface_annotate/`.
  - Inflated and pial side by side with linked cameras (rotate, zoom, pan);
    free trackball rotation; per-surface opacity and triangle-mesh overlay;
    view presets; PNG export of the visible panels.
  - Every layer toggle, colour, fill, threshold and opacity applies instantly —
    no Plot button, and the view is never reset by a change.
  - Atlas panel also shows `<hemi>.*.annot` files, with per-region selection.
  - Manual panel offers the rater folders next to the atlas labels.
  - A legend over the surfaces lists every ticked cluster (grouped per
    contrast) and label: click hides/shows, double-click isolates, hover fills.
  - Picking a subject/hemisphere loads it at once; ◀ ▶ (or `,` `.`) step
    through subjects. The camera (mirrored across hemispheres), surface
    opacity/mesh, heatmap + threshold, label fill/regions/legend state and
    fully ticked contrasts all carry over.
  - Hover readout: vertex, coordinates, curvature, heatmap value, labels.
  - Collapsible sidebar (☰ or `\`), remembered per browser; panels scale with
    the window and browser zoom without cropping the brain.
- `manual_label_dir` defaults to `.../label/tiger_delineation`; new `surfaces`
  config key; `default_surface` is gone (both surfaces are shown).
- Requires Python ≥ 3.10.

### Removed
- Camera sliders, live viewpoint readout and `DEFAULT_VIEWS` presets
  (`utils/camera.py`, `utils/plotting.py`, `.streamlit/`), which only existed
  to work around Plotly resetting the view.
- Dependencies `streamlit`, `plotly`, `watchdog`, `streamlit-js-eval`.

### Added
- `tests/test_app.py`: API tests on a synthetic subject, plus a check that the
  vendored engine matches surface-annotate. Run in the release workflow.
- `scripts/gen_manual_label.py`: build FreeSurfer manual labels from a rater's
  `cluster_mapping.csv` by merging the listed auto-cluster labels of one
  contrast (`--contrast`, default `RWvsAllNotext`) into one label per ROI,
  written under `<sub>/label/<out-name>/` or a local `--out-dir`. Validates
  the whole sheet before writing; `--list-contrasts` shows what is on disk.
- `typer` and `rich` are now declared dependencies (the `scripts/` helpers
  already used them).

## [0.1.0] — 2026-07-28

First tagged release.

### Added
- Streamlit surface viewer rendering one **inflated** or **pial** surface
  (selectable) for either hemisphere, full-width and responsive.
- Four independently path-configured layers, each editable live in the app:
  1. **Heatmap** overlay (`*.func.gii`)
  2. **Auto clusters** (`*_Cluster_*.label`)
  3. **Atlas labels** (`<hemi>.*.label`, FreeSurfer/atlas)
  4. **Manual labels** (`<hemi>.*.label`, e.g. `manual-v1`)
- `{sub}` path templating: relative paths resolve under `data_dir`, absolute
  paths used as-is.
- Per-hemisphere camera presets (`lh`/`rh`) and a rotation-mode switch
  (`turntable` / `orbit`).
- Click-to-render: the 3D mesh rebuilds only on an **Update plot** button
  (sidebar + per-panel), cached between reruns so widget tweaks are instant.
- `pyproject.toml` (uv/pip) + `requirements.txt`, headless `launch.sh`, and a
  README covering install (uv recommended), launch, and `ssh -L` remote viewing.

[0.1.0]: https://example.com/votcloc-surface-viewer/releases/tag/v0.1.0
