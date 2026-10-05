# Manual delineation helper (surface viewer)

[![DOI](https://zenodo.org/badge/1315063607.svg)](https://doi.org/10.5281/zenodo.22044800)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What this is for

**A light and fast surface viewer for labels and heatmaps.** It started as a
side project for the 2026 reading-ROI delineation workshop, but nothing in it is
specific to that: point it at any FreeSurfer surface with overlays and labels
and it works. Think of it as a lighter FreeView for a quick look, with every
label toggleable on and off.

It runs in the browser: the **inflated and pial surfaces side by side**, with
linked cameras, rendered by the three.js engine of
[surface-annotate](https://github.com/yongninglei/app_surface_annotate). A small
Python server (FastAPI + **nibabel**) reads the files, and every input path
comes from `config.yaml`, so pointing it at a different study, subject tree or
label set is a config edit, not a code change. Paths are also editable live in
the page.

| Type | Used as |
|------|---------|
| `.inflated`, `.pial` | the surface geometry you view |
| `.curv`              | the two-tone curvature shading underneath |
| `.func.gii`          | the contrast heatmap overlay |
| `.label`             | auto clusters, atlas labels, your own manual labels |
| `.annot`             | atlas parcellations (e.g. `aparc.a2009s`), per region |

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
>
> 5. Turn the finished sheet into FreeSurfer labels with
>    [`scripts/gen_manual_label.py`](scripts/gen_manual_label.py)
>    (see [Generating manual labels from the sheet](#generating-manual-labels-from-the-sheet)).

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

The header picks the **subject** and **hemisphere**; picking one loads it
straight away (**◀ ▶** or the `,` `.` keys step through subjects; **Reload**
re-reads the files). The sidebar
has the four layer panels and the view controls. The main area shows the
**inflated** surface on the left and the **pial** on the right.

**Everything applies instantly.** Ticking a label, changing a colour, fill,
threshold or opacity redraws straight away. There is no Plot button, and your
view is never reset.

| Panel | Controls | Typical content |
|-------|----------|-----------------|
| **1 · Heatmap** | which map, threshold (slider + exact box, bounded by the map's own range), opacity, transparent threshold + outline, colour bar | `*.func.gii` score / mean maps |
| **2 · Auto clusters** | tick a whole **contrast**, or **▸** to tick single clusters; one **fill** switch | `*_Cluster_*.label` |
| **3 · Atlas labels** | each label: tick, colour, fill. Each annot: tick, fill, **▸** to pick regions | aparc **OTS**, Wang **hV4**/**hMT**, **FG1–4**, `aparc.a2009s` |
| **4 · Manual labels** | pick a **rater folder** (`tiger_delineation/`, `anat_label_tiger/`, …) or type a path; then as panel 3 | labels you or a colleague drew |

Colours stick per label name, so unticking and re-ticking a label brings its
colour back. Word-ROI names (IOG, PON, pOTS, mOTS, mFus) always start from the
same colour for every rater. **fill opacity** under *Labels* sets how strong
every filled label is.

**Panel 4 is yours to fill.** It is meant for labels *you* generate — a first
manual delineation, a second pass, a colleague's version to compare against.
Keep each set in its own folder in the subject's FreeSurfer label directory:

```
freesurfer-with_t2/<sub>/label/tiger_delineation/lh.mFus-words.label
freesurfer-with_t2/<sub>/label/anat_label_tiger/lh.fusiform-gyrus.label
```

Every folder there is offered in the panel's folder list. To use a folder
elsewhere, type its path in the box (`{sub}` = subject, Enter to apply). Only
the selected hemisphere's files show up.

### Seeing clusters inside the sulci (x-ray)

Lower a surface's opacity (View → the slider next to *pial*) and the clusters, labels and
heatmap that lie **behind** the front surface, down a sulcus or on the far bank, show through
it. That gives the full spatial pattern on the pial, not only the patches that face you. The
lower the opacity, the stronger they show. Rotating does not make them flash: the x-ray pass is
offset slightly so it never z-fights with the front surface. The grey surface stays a single clean front layer,
and buried parts are drawn flat (unlit), so you can tell them from the ones in front.
*x-ray* (next to *mesh*) turns this off per surface. Clusters read best with **fill** on.

### Where drawn labels go: one folder per delineation step

*Save to* (Drawn labels) decides the folder, `<subject>/label/<folder>/`. The dropdown under it
switches in one click between the steps listed in `config.yaml` → `draw_label_folders`:

| folder | step |
|---|---|
| `tiger_ROI_auto` | ROIs from the auto clusters (e.g. `RWvsAllNotext_score`) |
| `tiger_ROI_manual` | ROIs from a t-threshold map (e.g. `RWvsAllNotext_mean_raw`) |
| `tiger_anat_landmark` | anatomical landmarks drawn by hand |

Below them it lists the subject's other `label/` folders, plus *custom…* to type a new name.
Switching loads that folder's saved labels (it asks first if there are unsaved ones). The page
starts in `draw_label_dir` (`tiger_ROI_auto`).

### Filling a heatmap blob with one click

1. **Navigate › 1 · Heatmap**: pick the map and the threshold.
2. **Contour** tool (<kbd>C</kbd>), then tick **inside the thresholded map**. *Click* switches to
   **fills from seed** by itself (or press <kbd>F</kbd>).
3. **Click a blob.** Every connected vertex above the threshold is added to the active label.
   With *Fills: remove*, it is taken out instead.

A click just outside the blob, e.g. on the faded below-threshold rim that transparent
thresholding shows, **snaps to the nearest vertex above the threshold within 3 mm**. The
status line says so. A click farther away says why nothing was filled. A leftover path with
*up to and including the path* ticked acts as a border: press <kbd>Esc</kbd> to clear it.

### Cutting a big region in two with a path

When one blob (or label region) is too big, draw a path across it and fill one side:

1. **Contour** tool, *Click: adds path point*. Click points **across** the region, with both ends
   **past its edge** (outside the blob, below the threshold). The path is a wall.
2. Press <kbd>F</kbd> (*fills from seed*). Keep **up to and including the path** ticked, together
   with **inside the thresholded map** (or *inside the clicked layer label* for a label).
3. **Click one side.** Only that side fills, up to and including the path.
4. For the other side as a second ROI: add a new label, tick **out of other drawn labels** (so
   the path vertices are not in both), and click the other side.

The wall is the path **exactly as drawn**: an open line. <kbd>Enter</kbd> instead closes the path
and fills the loop. If an end stops inside the region, the fill flows round it. Then the status
line warns "the path does not split this region" and you can extend that end (<kbd>Tab</kbd>
switches which end new points go to). A wiggly path can also cut off a small extra pocket.
Click it to add it.

### The cursor: where did I click?

In **Navigate**, a click on either surface puts a **cursor** (green ring + cross) on that vertex,
on the inflated and the pial panel at once, so you see where the same point lies on both. Where
the pial surface hides it (down a sulcus), it is drawn dim. The **Cursor** section of the Navigate
panel lists the vertex number, its inflated and pial coordinates, curvature, heatmap value and the
labels it falls in. *show cursor* turns it on and off; *clear* removes it. It is cleared when you
switch subject or hemisphere, because vertex numbers differ between them.

**Which coordinates?** The bottom bar always gives the vertex's **pial** position (x, y, z in
FreeSurfer surface RAS), even while you hover the inflated panel. Inflated coordinates are
positions on the inflated balloon, not in the brain, and the readout marks them *not
anatomical*.

**Where is it in the T1w?** Under the readout, *T1w space* gives the clicked vertex on the
**white** and the **pial** surface as scanner RAS coordinates (the T1w's world coordinates, as
in Freeview's "RAS" or an fMRIPrep `space-T1w` image), and the **voxel** of `mri/T1.mgz` it
falls in. Everything is in **x, y, z** order (R, A, S): the voxel is counted along x, y and z,
the same numbers the sampling tool and its WM page show. The raw file index is listed under it
for Freeview. A conformed `.mgz` is stored **L, I, A**, so that index reads (x, z, y), flipped:
e.g. x,y,z voxel `[71, 96, 130]` is file index `[184, 125, 96]`. The inflated surface has no T1w position, so only white
and pial are reported. The transform is `Norig · Torig⁻¹` from `mri/orig.mgz`, or the `c_ras`
stored in the surface file when there is no `mri/` folder.

### Transparent thresholding

By default the heatmap is shown with **transparent thresholding**
(Taylor, Aggarwal & Bandettini, 2026): the whole map is coloured by value,
vertices above the threshold are opaque and **outlined** (dark, so small blobs keep their colour), and those
below it are not hidden but fade out quadratically (opacity `(v / thr)²`). A
cluster is then seen in its context — whether it sits on a broad
subthreshold ridge or stands alone, and whether the cut-off splits one blob in
two. Untick **transparent threshold** for the classic hard cut (only
`v > thr`, coloured from the threshold up); **outline suprathreshold** works in
both modes. The threshold still means the same thing everywhere else — the
Contour tab's "inside the thresholded map" fill uses the binary `v > thr`.

> Taylor PA, Aggarwal H, Bandettini PA (2026). Go figure: transparency in
> neuroscience images preserves context and clarifies interpretation.
> *Nature Methods*. [doi:10.1038/s41592-026-03206-7](https://doi.org/10.1038/s41592-026-03206-7)
> (preprint: [arXiv:2504.07824](https://arxiv.org/abs/2504.07824))

### The legend: toggling single clusters

Everything you tick in panels 2–4 is listed in a **legend floating over the
surfaces**, one group per contrast (entries `#0`, `#3`, … in posterior →
anterior order), then atlas and manual labels. It is the quick way to go
through the clusters of a contrast and map them to ROIs:

- **click** an entry: hide / show it on the surface (it stays ticked);
- **double-click**: show only that one in its group; double-click it again to
  bring the others back;
- **hover**: fill it, so you can see where it is on inflated and pial;
- **show all** brings every hidden entry back; **–** collapses the legend.

Ticking a contrast also opens its cluster list in panel 2, where each cluster
has its own tick and colour swatch.

### Switching subject keeps your setup

Moving to another subject (or hemisphere) changes only the subject's own
data — surfaces, heatmap values, clusters, labels. Everything else stays:

- the **camera** (angle, zoom, pan; mirrored across the midline when you
  switch hemisphere, so lateral stays lateral);
- per-surface **opacity**, **mesh** and hidden panels;
- the **heatmap** and its **threshold**, heatmap opacity, fill opacity;
- ticked **atlas / manual labels** with their colour, fill, annot regions and
  legend hide/show state;
- every **contrast you had fully ticked** in panel 2 — ticked again with the
  new subject's own clusters. Single clusters are not carried over, because
  cluster IDs are numbered per subject.

### Drawing labels (Contour · Brush · Erase)

The tabs at the top of the sidebar pick the tool. **Navigate** is the viewer
described above. The other three draw into a label of your own, on top of
every layer you have ticked — the heatmap panel stays in view, so you can
draw against the map and its threshold.

Under **Drawn labels**, set the save folder (`label/<folder>`, default
`draw_label_dir` in `config.yaml`) and add a label — the six word-ROI names
(`LOC-words`, `IOG-words`, `PON-words`, `pOTS-words`, `mOTS-words`,
`mFus-words`) are suggested, so every rater saves the same names. Click a
label's name to draw into it. Labels already in that folder load for editing.

| Tab | What a click does |
|-----|-------------------|
| **Contour** | *adds path point*: points are joined by shortest paths along the mesh; <kbd>Enter</kbd> closes the path and fills it. *fills from seed* (<kbd>F</kbd> switches): floods out from the clicked vertex, FreeView's "custom fill" |
| **Brush** / **Erase** | paints / erases a disc (radius slider, <kbd>[</kbd> <kbd>]</kbd>); hold <kbd>Shift</kbd> and drag to paint a stroke |

**Fills** *add* to or *remove* from the active label (closed paths and seeded
fills alike). A seeded fill stays:

- **up to and including the path** — a drawn path (open or closed) is a wall;
- **inside the thresholded map** — whichever map is picked in panel 1, made
  binary at its threshold (also adjustable right there), so a click on a blob
  takes the connected suprathreshold patch;
- on **sulci only** (curv > 0) or **gyri only** (curv < 0);
- **inside the clicked layer label / region** — a ticked cluster, atlas or
  manual label, or the clicked annot region (click inside cluster #3 to take
  exactly cluster #3);
- **out of other drawn labels**, so neighbouring ROIs don't overlap.

A fill that nothing bounds and that would cover a quarter of the hemisphere
asks first. **Trim label to map / curvature** removes the active label's
vertices outside the thresholded map or off the chosen curvature. **Fill holes**, **Dilate**,
**Erode** and **Clear** act on the active label; <kbd>Ctrl/⌘ Z</kbd> undoes.

**Save active** / **Save all** write
`<fs_dir>/<sub>/label/<folder>/<hemi>.<name>.label` (xyz from `<hemi>.white`),
overwriting a file of the same name; empty labels are not saved. The folder
then shows up in panel 4's folder list. Switching subject, hemisphere or
folder with unsaved changes asks first.

### Combining the ROIs into an annot

`scripts/make_annot.py` turns a folder of ROI labels into one FreeSurfer
annotation per hemisphere, in the same folder (needs FreeSurfer's
`mris_label2annot` on `PATH`):

```bash
uv run scripts/make_annot.py --folder manual_delineation              # every subject that has it
uv run scripts/make_annot.py --folder tiger_delineation --annot-name tiger_6ROIs --sub 02 --hemi lh
# -> <fs_dir>/sub-02/label/tiger_delineation/lh.tiger_6ROIs.annot (+ lh.tiger_6ROIs.ctab)
```

The colours come from `WORD_ROIS` in `utils/discovery.py` (`--ctab` takes
your own `index name R G B A` table). A missing or empty label is skipped with
a warning, without shifting the other ROIs' names or colours, and vertices
claimed by two ROIs are reported.

### Generating manual labels from the sheet

`scripts/gen_manual_label.py` reads a filled-in `<rater>_cluster_mapping.csv`,
merges the listed cluster labels of one contrast into one FreeSurfer label per
ROI, and writes them where panel 4 looks by default:

```bash
uv run scripts/gen_manual_label.py --list-contrasts --sub 01        # what is on disk
uv run scripts/gen_manual_label.py --mapping-csv tiger_cluster_mapping.csv \
    --contrast RWvsSC --out-name manual_v1
# -> example_dataset/freesurfer-with_t2/sub-01/label/manual_v1/lh.IOG-words.label ...
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--mapping-csv` | — | the rater's sheet (`sub, ROI, cluster_id[, note][, hemi]`) |
| `--contrast` | `RWvsAllNotext` | which contrast's clusters the ids refer to (case-insensitive) |
| `--out-name` | `manual_v1` | sub-folder created under `<sub>/label/` |
| `--hemi` | config `default_hemi` | hemisphere for rows without a `hemi` column |
| `--sub` | all subjects in the sheet | only this subject |
| `--out-dir` | FreeSurfer label dir | write to `<out-dir>/sub-XX/<out-name>/` instead |
| `--clean` | off | delete existing `*.label` in the output folder first |

Every row is checked before anything is written: a cluster id that does not
exist for that contrast, a duplicated ROI name, or a subject with no clusters on
disk stops the run and prints the ids that *are* available. A blank
`cluster_id` writes no label (the ROI is listed under `skipped` in the
summary); a cluster assigned to two ROIs only warns. Each label's header line
records the subject, contrast, cluster ids and source sheet, a `summary.yaml`
next to the labels records the same per ROI, and the script ends by printing the
`manual_label_dir` value to paste into panel 4 or `config.yaml`.

**All raters at once.** Put one `<rater>_*.csv` per rater in
`inter-rater_variability_check/` and run:

```bash
uv run scripts/gen_manual_label_batch.py            # --contrast RWvsAllNotext by default
# -> example_dataset/freesurfer-with_t2/sub-01/label/alex_delineation/lh.*.label + summary.yaml
```

The rater name is the file name up to the first `_`. A sheet with any bad row
writes nothing and is reported; the other sheets still run.

### Rotating and viewing

- **☰** (top left) or the `\` key hides the sidebar, to give the panels the
  whole window on a small screen; the browser remembers your choice, and
  windows narrower than 900 px start with it hidden. The panels follow the
  window size (and browser zoom), and the brain keeps its size relative to the
  panel's shorter side, so it never gets cropped in a narrow panel.
- **Drag** rotates (free trackball), **right-drag** pans, the **wheel** zooms.
  The two panels are **linked**: moving either one moves both. Untick
  **link cameras** to move them separately.
- **Lateral / Medial / Ventral / …** reset both panels to that view. The page
  opens on **Ventral**.
- Under **View**, each surface has its own row: show/hide the panel, an
  **opacity** slider, and a **mesh** toggle that overlays the triangle mesh
  (zoom in to see single edges). Below full opacity the front surface turns
  see-through like glass.
- The footer shows the vertex under the mouse: its coordinates, curvature,
  heatmap value, and every visible label or annot region it falls in.
- **Save PNG** (top right) saves the visible panels as one image, named after
  the subject, hemisphere, heatmap and threshold.

Nothing about the view is stored on the server, and nothing needs to be. A
view only resets when you press a view button or load another subject.

**The mapping loop:**

1. Pick the subject and hemisphere, press **Load**.
2. Panel 1: pick the heatmap for the contrast you're working on and set the
   threshold. The slider is bounded by that map's own value range; type an
   exact value in the box next to it.
3. Panel 2: tick the matching contrast to show all its clusters, or open it
   (**▸**) and tick single ones. Cluster IDs run posterior → anterior, so a
   higher index is a more anterior cluster. Hover a cluster to read its name.
4. Panels 3 / 4: switch on whichever reference labels help you decide.
5. Use the **legend** to go through the clusters one by one (hover to find,
   click to hide, double-click to isolate), compare on inflated and pial, and
   fill the cluster IDs into your CSV.
6. Press **▶** for the next subject: same view, same heatmap, same contrast,
   that subject's clusters.

Each layer's directory comes from a `config.yaml` field but is **editable live**
in the panel's text box (Enter to apply). In every path `{sub}` is replaced by
the selected subject; relative paths resolve under the data root, absolute
paths are used as-is.

| # | Layer         | config field       | scans for            |
|---|---------------|--------------------|----------------------|
| 1 | Heatmap       | `heatmap_dir`      | `*.func.gii`         |
| 2 | Auto clusters | `clusters_dir`     | `*_Cluster_*.label`  |
| 3 | Atlas labels  | `atlas_label_dir`  | `<hemi>.*.label`, `<hemi>.*.annot` |
| 4 | Manual labels | `manual_label_dir` | `<hemi>.*.label` (e.g. `tiger_delineation/`) |

---

# Setup

Everything below is one-time setup: installing the environment, pointing the app
at your data, and running it on a remote machine.

## Requirements

- Python **≥ 3.10**
- Read access to the derivatives tree pointed to by `config.yaml` (`data_dir`).
- Dependencies: `fastapi`, `uvicorn`, `numpy`, `nibabel`, `pyyaml`, `typer`, `rich`.
- A browser with WebGL and internet access: the page loads three.js from
  jsDelivr. The machine running `app.py` needs no internet.

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
cd app_manual_delineation_helper
```

---

## Install

Four equivalent routes — use the one your setup already has. Each ends with an
environment that can run `python app.py`.

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
conda install -c conda-forge fastapi uvicorn numpy nibabel pyyaml typer rich
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
poetry run python app.py
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

`launch.sh` just runs `app.py` without opening a browser, bound to
`localhost` — the right mode behind an ssh tunnel. On your own machine, run
`app.py` directly and it opens a browser tab for you (same prefix rules):

```bash
uv run app.py                      # uv; opens http://localhost:8501
uv run app.py --port 8600          # another port
python app.py                      # activated env
python app.py --help               # all options (--config, --host, --no-open)
```

---

## Remote host (ssh tunnel)

Run the app on the host, then forward the port to your laptop with `ssh -L`.
The app stays bound to the host's `localhost` (not network-exposed), which is
the safe default on a shared machine.

```bash
# 1) on the remote host
ssh <user>@cajal03
cd <path-to-clone>/app_manual_delineation_helper
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
default_contrast: RWvsSC            # its *_score map is shown on load
surfaces: [inflated, pial]          # panels, left to right
heatmap_dir:      autoROI/individual/analysis-27.../{sub}
clusters_dir:     autoROI/individual/analysis-27.../{sub}/labels
atlas_label_dir:  freesurfer-with_t2/{sub}/label
manual_label_dir: freesurfer-with_t2/{sub}/label/tiger_delineation
```

To point the app at a different tree, edit `data_source` / `disk_data_dir`, or
start it with another config: `uv run app.py --config my_config.yaml`.

---

## Files

```
app.py                 server (FastAPI) + CLI: serves the page and the files it asks for
static/index.html      the page: tool tabs, layer panels, drawing panels, view controls
static/app.js          layer logic (heatmap, clusters, atlas, manual) + drawing, on top of the engine
static/draw.js         DOM-free seeded fill / dilate / erode (node --test tests/draw.test.mjs)
static/style.css       page style
static/vendor/surface_annotate/  vendored viewer engine (viewer.js, mesh.js); see its README
utils/config.py        config loading + sub/hemi naming + resolve_dir (path templates)
utils/surface.py       read surface geometry (inflated & pial) and curvature
utils/labels.py        .label / .func.gii readers, .label writer
scripts/make_annot.py  combine a folder's ROI labels into a .annot
utils/discovery.py     scan one layer directory -> {display_name: path} (+ palette)
tests/test_app.py      API tests on a synthetic subject (uv run pytest)
config.yaml            data_dir + fs_dir + one directory per layer (all editable in-app)
example_cluster_mapping.csv  template for recording cluster -> ROI assignments
pyproject.toml         project metadata + dependencies (uv / poetry / pip)
requirements.txt       same dependency list, for the plain pip path
environment.yml        same dependency list, for conda / micromamba
launch.sh              headless launcher for remote use
```

This directory is self-contained and independent of `../visualizing_local_host`.
