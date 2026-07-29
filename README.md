# Manual delineation helper (Streamlit surface viewer)

## What this is for

This app comes with the **ROI delineation workshop**, where we assess and try to
minimize inter-rater variability — so it is deliberately light and fast, for
everybody to run.

It's an HTML-based viewer that loads a subject's contrast **heatmap**, the
**auto clusters** derived from it, and a few **reference labels** on one 3D
surface: a lighter FreeView, with every label toggleable on and off.

Once you can see which cluster sits where, you record the mapping by hand:
download [`example_cluster_mapping.csv`](example_cluster_mapping.csv) and, for
each ROI, write the cluster ID(s) that belong to it.

```csv
sub,maunal_ROI(from posteroir to anteroir),cluster_id
11,OWA,"0,2"
11,pOTS-words,3
```

One row per ROI, posterior → anterior; several clusters go in one quoted field
(`"0,2"`). The app writes nothing — that CSV is the output.

---

## How to run

Once the environment is installed and `config.yaml` points at your data
(both below):

```bash
./launch.sh
```

Then open the URL it prints in your browser:

```
http://localhost:8501
```

Running on a remote host instead? See [Remote host (ssh tunnel)](#remote-host-ssh-tunnel).

---

## Using the app

One sidebar and four panels.

**Sidebar** — subject, hemisphere, surface (inflated / pial), rotation mode, and
the camera preset (per hemisphere, with sliders to fine-tune the viewpoint).

| Panel | Controls | Typical content |
|-------|----------|-----------------|
| **1 · Heatmap** | the overlay heatmap: which contrast, threshold, opacity | `*.func.gii` score / mean maps |
| **2 · Auto clusters** | contours of the auto clusters, per contrast or one by one | `*_Cluster_*.label` |
| **3 · Atlas labels** | extra reference labels | aparc **OTS**, Wang atlas **hV4** and **hMT**, **FG1–4** |
| **4 · Manual labels** | extra reference labels you made yourself | e.g. `manual-v1` |

Panels 3 and 4 are both "load extra labels for reference" — 3 points at the
atlas/recon labels, 4 at your own.

**The mapping loop:**

1. Pick the subject and hemisphere in the sidebar.
2. Panel 1 — load the heatmap for the contrast you're working on, and set the
   threshold (the slider is bounded by that map's own value range, shown as a
   caption; type an exact value in the box next to it).
3. Panel 2 — load the matching clusters. Selecting a **contrast** loads all of
   its clusters at once; you can also pick them individually. Cluster IDs run
   posterior → anterior, so a higher index is a more anterior cluster.
4. Panel 3 / 4 — switch on whichever reference labels help you decide.
5. Press **🔄 Plot** (or **🔄 Update plot** in the sidebar) to rebuild the
   surface. The 3D mesh is only rebuilt on demand, so tweaking controls stays
   instant.
6. Rotate to a good viewpoint, toggle individual labels on and off in the plot
   legend, and fill the cluster IDs into your CSV.

Each layer's directory comes from a `config.yaml` field but is **editable live**
in the panel's text box, so you can point one panel elsewhere without
restarting. In every path `{sub}` is replaced by the selected subject; relative
paths resolve under the data root, absolute paths are used as-is.

| # | Layer         | config field       | scans for            |
|---|---------------|--------------------|----------------------|
| 1 | Heatmap       | `heatmap_dir`      | `*.func.gii`         |
| 2 | Auto clusters | `clusters_dir`     | `*_Cluster_*.label`  |
| 3 | Atlas labels  | `atlas_label_dir`  | `<hemi>.*.label` (FreeSurfer/atlas) |
| 4 | Manual labels | `manual_label_dir` | `<hemi>.*.label` (e.g. `manual-v1`) |

---

# Setup

Everything below is one-time setup: installing the environment, pointing the app
at your data, and running it on a remote machine.

## Requirements

- Python **≥ 3.9**
- Read access to the derivatives tree pointed to by `config.yaml` (`data_dir`).
- Dependencies: `streamlit`, `plotly`, `numpy`, `nibabel`, `pyyaml`, `watchdog`.

The same dependency set is declared three times, one per install style — pick
whichever matches your tooling, they are interchangeable:

| File | Used by |
|------|---------|
| `pyproject.toml`   | uv, poetry, `pip install .` |
| `requirements.txt` | plain `pip` (venv, or any existing env) |
| `environment.yml`  | conda, micromamba, mamba |

All commands below assume you start from the root of the cloned repo:

```bash
git clone <repo-url>
cd app_manual_delination_helper
```

---

## Install

Four equivalent routes — use the one your setup already has. Each ends with an
environment that can run `streamlit run app.py`.

### Option A — uv (recommended)

[uv](https://docs.astral.sh/uv/) creates the virtual environment and installs
everything from `pyproject.toml` in one step.

```bash
# one-time: install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

# create .venv and install the dependencies
uv sync
```

`uv sync` makes a `.venv/` here and installs the pinned dependency set (from
`uv.lock`, so everyone gets identical versions). Nothing to activate — prefix
commands with `uv run …` (see below).

If you already have another environment active (a conda env, say), `uv sync`
still targets `.venv/` and warns about the mismatch. To install into the
*active* environment instead: `uv sync --active`.

### Option B — conda / micromamba / mamba

```bash
conda env create -f environment.yml       # micromamba create -f environment.yml
conda activate votcloc-surface-viewer     # micromamba activate votcloc-surface-viewer
```

Update it after the dependency list changes:

```bash
conda env update -f environment.yml --prune
```

To install into an environment you already have (e.g. the `votcloc` env on the
BCBL machines) rather than creating a new one:

```bash
conda activate votcloc
conda install -c conda-forge streamlit plotly numpy nibabel pyyaml watchdog
```

### Option C — venv + pip

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Works the same in any already-activated environment — just run the
`pip install -r requirements.txt` line.

### Option D — poetry

`pyproject.toml` uses the standard `[project]` table, which **Poetry ≥ 2.0**
reads directly. This app isn't a package, so install the dependencies only:

```bash
poetry install --no-root
poetry run streamlit run app.py
```

On Poetry 1.x, which doesn't read `[project]`, use the requirements file
instead: `poetry run pip install -r requirements.txt`.

---

## Launch options

`./launch.sh` (above) is the short path. In full, there are two commands:

| Command | When |
|---------|------|
| `streamlit run app.py` | on your own machine — opens a browser tab |
| `./launch.sh [port]`   | headless, `localhost`-only, no telemetry, port defaults to 8501 — also the right mode behind an ssh tunnel |

The prefix depends on how you installed:

| Install | Prefix | Example |
|---------|--------|---------|
| uv      | `uv run`     | `uv run ./launch.sh` |
| poetry  | `poetry run` | `poetry run ./launch.sh` |
| conda / micromamba / venv | none, once activated | `./launch.sh` |

To use a port other than 8501:

```bash
streamlit run app.py --server.port 8600     # local
./launch.sh 8600                            # headless
```

---

## Remote host (ssh tunnel)

Run the app on the host, then forward the port to your laptop with `ssh -L`.
The app stays bound to the host's `localhost` (not network-exposed), which is
the safe default on a shared machine.

```bash
# 1) on the remote host
ssh <user>@cajal03
cd <path-to-clone>/app_manual_delination_helper
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
example_cluster_mapping.csv  template for recording cluster -> ROI assignments
pyproject.toml         project metadata + dependencies (uv / poetry / pip)
requirements.txt       same dependency list, for the plain pip path
environment.yml        same dependency list, for conda / micromamba
.streamlit/config.toml dark theme
launch.sh              headless launcher for remote use
```

This directory is self-contained and independent of `../visulizing_local_host`.
