# Manual delineation helper (Streamlit surface viewer)

[![DOI](https://zenodo.org/badge/1315063607.svg)](https://doi.org/10.5281/zenodo.22044800)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What this is for

**A light and fast surface viewer for labels and heatmaps.** It started as a
side project for the 2026 reading-ROI delineation workshop, but nothing in it is
specific to that: point it at any FreeSurfer surface with overlays and labels
and it works. Think of it as a lighter FreeView for a quick look, with every
label toggleable on and off.

The front end is **Streamlit**, the surface itself is rendered by **Plotly**
(WebGL) from geometry and labels read with **nibabel**, and every input path
comes from `config.yaml` — so pointing it at a different study, subject tree or
label set is a config edit, not a code change. Paths are also editable live in
the app.

| Type | Used as |
|------|---------|
| `.inflated`, `.pial` | the surface geometry you view |
| `.curv`              | the two-tone curvature shading underneath |
| `.func.gii`          | the contrast heatmap overlay |
| `.label`             | auto clusters, atlas labels, your own manual labels |

**No threshold picking.** Deciding where to cut a continuous map is arbitrary,
and that arbitrariness is a large source of intra-rater variability: the same
person, on the same data, draws a different ROI at a different threshold. So the
clusters here are not thresholded by hand — they come from an **inverse
watershed** algorithm that segments the map into candidate clusters
automatically. Your job is not to choose a cut-off, but to pick which of the
offered candidates belong to which ROI.

> ### 📋 Note for the ROI delineation workshop
>
> 1. Download [`example_cluster_mapping.csv`](example_cluster_mapping.csv).
> 2. Rename it with your own prefix — `<rater>_cluster_mapping.csv`, e.g.
>    `yongning_cluster_mapping.csv` — so everyone's sheet stays separate and
>    raters can be compared afterwards.
> 3. Fill it in: for each ROI name **we agreed on in the first meeting**, write
>    the cluster ID(s) you assign to it.
> 4. In the 4th column, you can put comment regarding the clusters that you are hesitating
> ```csv
> sub,manual_ROI(from posterior to anterior),cluster_id(From RWvsSC_score),comment
> 1,IOG-words,"0,2"
> 1,PON-words,3
> 1,pOTS-words,3
> 1,mOTS-words,3
> 1,mFus-words,3
> ```
>
> One row per ROI, ordered posterior → anterior; several clusters go in one
> quoted field (`"0,2"`) so the file stays three columns. The app writes
> nothing — that CSV is your output.

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
the **Camera** sliders: azimuth, elevation, roll, azimuth offset, camera centre
and zoom. Each hemisphere keeps its own values, seeded from the preset in
`utils/surface.py`.

| Panel | Controls | Typical content |
|-------|----------|-----------------|
| **1 · Heatmap** | the overlay heatmap: which contrast, threshold, opacity | `*.func.gii` score / mean maps |
| **2 · Auto clusters** | contours of the auto clusters, per contrast or one by one | `*_Cluster_*.label` |
| **3 · Atlas labels** | extra reference labels | aparc **OTS**, Wang atlas **hV4** and **hMT**, **FG1–4** |
| **4 · Manual labels** | extra reference labels you made yourself | e.g. `manual-v1/lh.my-ROI.label` |

Panels 3 and 4 are both "load extra labels for reference" — 3 points at the
atlas/recon labels, 4 at your own. In **both**, every selected label gets its
own colour swatch and its own **fill** tick (unticked = outline only), so you
can, say, show FG1–4 as four differently coloured outlines and fill just the
one you are arguing about. Choices stick per label name, so deselecting and
re-selecting a label brings its colour back.

**Panel 4 is yours to fill.** It is meant for labels *you* generate — a first
manual delineation, a second pass, a colleague's version to compare against.
Save them in the subject's FreeSurfer label directory, either straight in it or
one folder deeper if you want to keep versions apart:

```
freesurfer-with_t2/<sub>/label/lh.my-ROI.label          # flat
freesurfer-with_t2/<sub>/label/manual-v1/lh.my-ROI.label   # one layer deeper
```

Point `manual_label_dir` at whichever level holds the files (the panel's text
box takes a new path live, no restart), and the panel lists every
`<hemi>.*.label` it finds there. Only the selected hemisphere's files show up.

### Rotating, and making a viewpoint stick

You can drag the brain in the plot to any angle, scroll to zoom, and pan — the
usual Plotly 3D controls. But **the sidebar sliders are the only thing the app
actually remembers.** A dragged view lives in the browser only; Python is never
told about it.

⚠️ **So a hand-dragged angle is temporary.** It survives small things like
toggling labels in the legend, but the moment the surface is rebuilt — you press
**🔄 Plot** after loading new clusters, or switch subject / hemisphere /
surface — the figure is redrawn *from the sliders* and your dragged angle is
gone. Losing a view you spent a minute finding, right after loading the next
label, is the usual way to hit this.

For that reason the **📐 Viewpoint** panel under the plot gives a **live
readout**: while you drag, it shows the viewpoint you are currently looking at,
in the same six parameters the sidebar uses — azimuth, elevation, roll, azimuth
offset, centre x and zoom.

It is behind a **Live readout** switch, off by default. While it is on, it
listens to every drag event and recomputes on each frame, so the intended cycle
is: **switch it on → drag until the view is right → copy the numbers into the
sidebar → switch it off.** With the switch off nothing watches the plot at all.

**Remember to move those values into the sidebar** once you have found an angle
worth keeping. Either press **⬅ Copy readout into the sidebar sliders**, or type
them into the boxes underneath (the plot redraws on Enter). Until you do, the
sidebar still holds the old view and the next rebuild will snap back to it. The
copy button works whether the readout is on or off.

To keep a viewpoint **permanently** — across restarts, for everybody — paste the
`DEFAULT_VIEWS` snippet the panel prints into `utils/surface.py`. That is how the
`lh` and `rh` presets were made. Nothing about a session's viewpoint is written
to disk otherwise.

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
   legend, and fill the cluster IDs into your CSV. If you want to keep that
   angle for the next cluster, copy it into the sidebar first (see above) —
   otherwise the next **🔄 Plot** resets it.

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

**First, get `uv` itself** — two ways:

```bash
# 1) curl: the official standalone installer
curl -LsSf https://astral.sh/uv/install.sh | sh
```

```bash
# 2) pipx (recommended if you have it)
pipx install uv
```

[pipx](https://pipx.pypa.io/) installs a PyPI *application* system-wide, each
in its own isolated environment, and puts the command on your `PATH`. That is
what you want for a tool like `uv`: it stays available from any directory and
never lands inside — or clashes with — this project's virtual environment.
`pip install uv` inside a venv would tie the tool to that one env.

**Then install the app's dependencies:**

```bash
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

**Run the command that matches how you installed** — the difference is whether
the tool has to put its environment in front of the command for you.

### If you installed with uv (Option A)

`uv` owns `.venv/`, so nothing gets activated — `uv run` supplies the
environment for that one command:

```bash
uv run ./launch.sh              # port 8501
uv run ./launch.sh 8600         # any other port
```

### If you installed with poetry (Option D)

Same idea, poetry's own prefix:

```bash
poetry run ./launch.sh
poetry run ./launch.sh 8600
```

### If you built a conda / micromamba env (Option B) or a venv (Option C)

You activated the environment yourself, so no prefix — just run the script:

```bash
conda activate votcloc-surface-viewer     # or: source .venv/bin/activate
./launch.sh
./launch.sh 8600
```

If `./launch.sh` gives *permission denied* (common after downloading a zip
instead of cloning, which drops the executable bit), run it through bash
instead — or restore the bit once with `chmod +x launch.sh`:

```bash
bash ./launch.sh
```

### The other command

`launch.sh` just wraps Streamlit with headless, `localhost`-only settings — the
right mode behind an ssh tunnel. To open a browser tab directly instead, swap
in `streamlit run app.py` (same prefix rules):

```bash
uv run streamlit run app.py --server.port 8600      # uv
streamlit run app.py --server.port 8600             # activated env
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
  default `example_dataset/`). It's **relative**, so it resolves next to
  the config file and works right after `git clone` on any machine.
- `data_source: disk` — a full derivatives tree elsewhere (`disk_data_dir`, an
  absolute path), which also has the complete atlas + `manual-v1` labels.

For either path the rule is the same: **relative** → resolved relative to the
config file (in-repo data); **absolute** → used as-is (a real read directory).

```yaml
data_source: repo                   # repo -> repo_data_dir, disk -> disk_data_dir
repo_data_dir: example_dataset      # in-repo example data (relative to this config)
disk_data_dir: /bcbl/home/public/Gari/VOTCLOC/main_exp/derivatives
fs_dir: freesurfer-with_t2          # surface geometry: <data_root>/<fs_dir>/<sub>/surf/
default_subject: "02"
default_hemi: lh
default_surface: inflated
default_contrast: RWvsSC
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

This directory is self-contained and independent of `../visualizing_local_host`.
