# Changelog

All notable changes to the VOTCLOC surface viewer are documented here.
This project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

## [Unreleased]

### Added
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
