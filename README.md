# Manual delineation helper (Streamlit surface viewer)

A self-contained Streamlit app for visually inspecting VOTCLOC surfaces while
delineating manual ROIs. Renders **one** 3D map — **inflated** or **pial**
(selectable, default inflated) — for either hemisphere, driven by a compact
sidebar. The surface fills the whole main area and stays large as the window
shrinks. The 3D mesh rebuilds only when you press **Update plot**, so tweaking
controls is instant.

Four layer categories, each pointing at its own directory. The directory comes
from a `config.yaml` field but is **editable live** in each layer's text box.
In every path, `{sub}` is replaced by the selected subject; relative paths
resolve under `data_dir`, absolute paths are used as-is.

| # | Layer         | config field       | scans for            |
|---|---------------|--------------------|----------------------|
| 1 | Heatmap       | `heatmap_dir`      | `*.func.gii`         |
| 2 | Auto clusters | `clusters_dir`     | `*_Cluster_*.label`  |
| 3 | Atlas labels  | `atlas_label_dir`  | `<hemi>.*.label` (FreeSurfer/atlas) |
| 4 | Manual labels | `manual_label_dir` | `<hemi>.*.label` (e.g. `manual-v1`) |

The camera has per-hemisphere presets (`lh`/`rh`) and a rotation-mode switch
(`turntable` vs `orbit`).

---

## Requirements

- Python **≥ 3.9**
- Read access to the derivatives tree pointed to by `config.yaml` (`data_dir`).
- Dependencies: `streamlit`, `plotly`, `numpy`, `nibabel`, `pyyaml`
  (declared in both `pyproject.toml` and `requirements.txt`).

All commands below assume you start from this directory:

```bash
cd /bcbl/home/public/Gari/VOTCLOC/main_exp/code/app_manual_delination_helper
```

---

## Install

### Option A — uv (recommended)

[uv](https://docs.astral.sh/uv/) creates the virtual environment and installs
everything from `pyproject.toml` in one step.

```bash
# one-time: install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

# create .venv and install the dependencies
uv sync
```

`uv sync` makes a `.venv/` here and installs the pinned dependency set. Nothing
else to activate — use `uv run …` to run inside it (see below).

### Option B — venv + pip

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

(There is also a conda env on the BCBL machines: `conda activate votcloc`
already has these packages, so you can skip the venv there and just run.)

---

## Launch

### With uv

```bash
uv run streamlit run app.py            # default port 8501
uv run streamlit run app.py --server.port 8600
# or the headless launcher (used for remote/ssh):
uv run ./launch.sh 8501
```

### With an activated venv / conda env

```bash
streamlit run app.py                   # default port 8501
./launch.sh 8501                       # headless, pick any free port
```

`launch.sh [port]` runs Streamlit headless on `localhost` (no browser opened,
no telemetry) — the right mode for a remote host behind an ssh tunnel.

---

## View it

### A) Running on your own machine

Just open the URL Streamlit prints:

```
http://localhost:8501
```

### B) Running on a remote host (e.g. cajal03) via an ssh tunnel

Run the app on the host, then forward the port to your laptop with `ssh -L`.
The app stays bound to the host's `localhost` (not network-exposed), which is
the safe default on a shared machine.

```bash
# 1) on the remote host
ssh <user>@cajal03
cd /bcbl/home/public/Gari/VOTCLOC/main_exp/code/app_manual_delination_helper
conda activate votcloc          # or: uv sync (first time)
./launch.sh 8501                # or: uv run ./launch.sh 8501

# 2) on your local machine (new terminal)
ssh -L 8501:localhost:8501 <user>@cajal03

# 3) open in your local browser
http://localhost:8501
```

Notes:
- If port `8501` is taken (another user), pick another: `./launch.sh 8600` and
  forward that one — `ssh -L 8600:localhost:8600 <user>@cajal03`.
- Keep the `ssh -L` session open while you use the app; closing it drops the
  tunnel.
- Left side `8501` (local) and right side `8501` (remote) are independent — you
  can map e.g. `9000:localhost:8501` if 8501 is busy locally.

---

## Configure

`config.yaml` holds only the roots and the initial dropdown selections; every
layer directory is also editable live in the app.

One field, `data_source`, chooses where data comes from:

- `data_source: repo` — the example data bundled in the repo (`repo_data_dir`,
  default `ROI_delination_DATA/`). It's **relative**, so it resolves next to
  the config file and works right after `git clone` on any machine.
- `data_source: disk` — a full derivatives tree elsewhere (`disk_data_dir`, an
  absolute path), which also has the complete atlas + `manual-v1` labels.

For either path the rule is the same: **relative** → resolved relative to the
config file (in-repo data); **absolute** → used as-is (a real read directory).

```yaml
data_source: repo                   # repo -> repo_data_dir, disk -> disk_data_dir
repo_data_dir: ROI_delination_DATA  # in-repo example data (relative to this config)
disk_data_dir: /bcbl/home/public/Gari/VOTCLOC/main_exp/derivatives
fs_dir: freesurfer-with_t2          # surface geometry: <data_root>/<fs_dir>/<sub>/surf/
default_subject: "02"
default_hemi: lh
default_surface: inflated
default_contrast: RWvsPER
heatmap_dir:      autoROI/individual/analysis-27.../{sub}
clusters_dir:     autoROI/individual/analysis-27.../{sub}/labels
atlas_label_dir:  freesurfer-with_t2/{sub}/label
manual_label_dir: freesurfer-with_t2/{sub}/label/manual-v1
```

To point the app at a different tree, edit `data_dir` (or type a new path in
the sidebar's **Config YAML** box at runtime).

---

## Files

```
app.py                 Streamlit UI only
utils/config.py        config loading + sub/hemi naming + resolve_dir (path templates)
utils/surface.py       surface geometry (inflated & pial), per-hemi camera, vertex normals
utils/labels.py        readers for .label and .func.gii files
utils/discovery.py     scan one layer directory -> {display_name: path} (+ palette)
utils/plotting.py      build the Plotly figure (curvature + overlay + label traces)
config.yaml            data_dir + fs_dir + one directory per layer (all editable in-app)
pyproject.toml         project metadata + dependencies (for uv / pip)
requirements.txt       same dependency list, for the pip path
.streamlit/config.toml dark theme
launch.sh              headless launcher for remote use
```

This directory is self-contained and independent of `../visulizing_local_host`.
