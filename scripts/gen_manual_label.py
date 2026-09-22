#!/usr/bin/env python3
"""Turn a rater's cluster_mapping.csv into FreeSurfer manual labels.

Each row of the CSV assigns one or more auto-cluster IDs to a manual ROI name.
For every row this script reads the matching ``*_Cluster_<id>.label`` files of
the chosen contrast, merges their vertices into one label, and writes it as
``<hemi>.<ROI>.label`` where the app's "4 · Manual labels" panel will find it:

    <data_root>/<fs_dir>/sub-XX/label/<out-name>/lh.IOG-words.label

With ``--out-dir /some/path`` the labels go to ``/some/path/sub-XX/<out-name>/``
instead, and the matching ``manual_label_dir`` template is printed at the end.

CSV format (header names are matched loosely, extra columns are ignored):

    sub,manual_ROI(from posterior to anterior),cluster_id,note
    1,IOG-words,"0,2",
    1,PON-words,3,

Optional ``hemi`` column (lh/rh) overrides ``--hemi`` per row.  A blank
cluster_id skips the row; a cluster ID that does not exist on disk is an error.
Everything is validated first and nothing is written if any row is wrong, so a
typo in the sheet cannot produce a half-written label set.

Usage
-----
  uv run scripts/gen_manual_label.py --list-contrasts --sub 01
  uv run scripts/gen_manual_label.py --mapping-csv tiger_cluster_mapping.csv
  uv run scripts/gen_manual_label.py --mapping-csv tiger_cluster_mapping.csv \\
        --contrast RWvsSC --out-name manual_v1
  uv run scripts/gen_manual_label.py --mapping-csv tiger_cluster_mapping.csv \\
        --out-dir /tmp/my_labels --sub 02
"""

from __future__ import annotations

import csv
import datetime
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import typer
from rich.console import Console
from rich.table import Table

# This file lives in <repo>/scripts/; utils/ is a sibling of scripts/.
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from utils.config import (  # noqa: E402
    fs_subject_dir,
    load_config,
    normalize_hemi,
    normalize_sub,
    resolve_dir,
)

console = Console()
app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)

DEFAULT_CONFIG = REPO_ROOT / "config.yaml"
DEFAULT_CONTRAST = "RWvsAllNotext"
DEFAULT_OUT_NAME = "manual_v1"

CLUSTER_RE = re.compile(r"hemi-(?P<hemi>[LR])_contrast-(?P<contrast>.+?)_scaled_Cluster_(?P<cid>\d+)\.label$")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class MappingRow:
    """One line of the CSV, parsed."""

    line_no: int
    sub: str            # "sub-01"
    roi: str            # "IOG-words"
    cluster_ids: List[int]
    hemi_fs: str        # "lh" / "rh"
    note: str = ""


@dataclass
class PlannedLabel:
    """One output label, fully resolved (inputs verified to exist)."""

    row: MappingRow
    sources: List[Path]
    out_path: Path


@dataclass
class SubjectPlan:
    sub: str
    hemi_fs: str
    contrast: str
    clusters_dir: Path
    out_dir: Path
    labels: List[PlannedLabel] = field(default_factory=list)
    skipped: List[Tuple[MappingRow, str]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


@dataclass
class WrittenLabel:
    roi: str
    path: Path
    n_vertices: int
    cluster_ids: List[int]
    replaced: bool


# ---------------------------------------------------------------------------
# CSV parsing
# ---------------------------------------------------------------------------

def _find_col(header: List[str], *needles: str) -> Optional[int]:
    """Index of the first header cell containing any needle (case-insensitive)."""
    low = [h.strip().lower() for h in header]
    for needle in needles:
        for i, h in enumerate(low):
            if needle in h:
                return i
    return None


def _norm_sub(raw: str) -> str:
    """'1' / '01' / 'sub-1' / 'sub-01' -> 'sub-01' (numeric labels zero-padded to 2)."""
    s = raw.strip()
    if s.lower().startswith("sub-"):
        s = s[4:]
    if s.isdigit():
        s = s.zfill(2)
    return normalize_sub(s)


def _parse_ids(raw: str) -> List[int]:
    """'0,2' / '0;2' / '0 2' / '3' -> [0, 2] / [3]; '' -> []."""
    parts = [p for p in re.split(r"[,;\s]+", raw.strip()) if p]
    ids: List[int] = []
    for p in parts:
        if not p.isdigit():
            raise ValueError(f"cluster id {p!r} is not an integer")
        ids.append(int(p))
    # De-duplicate but keep order so the label header reads like the sheet.
    seen: set = set()
    return [i for i in ids if not (i in seen or seen.add(i))]


def read_mapping_csv(path: Path, default_hemi_fs: str) -> List[MappingRow]:
    """Parse the rater's sheet.  Raises ValueError with the line number on any bad row."""
    with Path(path).open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        rows = list(reader)
    if not rows:
        raise ValueError(f"{path}: empty file")

    header = rows[0]
    i_sub = _find_col(header, "sub")
    i_roi = _find_col(header, "roi", "label", "name")
    i_cid = _find_col(header, "cluster")
    i_hemi = _find_col(header, "hemi")
    i_note = _find_col(header, "note", "comment")
    missing = [n for n, i in (("sub", i_sub), ("ROI", i_roi), ("cluster_id", i_cid)) if i is None]
    if missing:
        raise ValueError(
            f"{path}: header {header!r} lacks a column for {', '.join(missing)} "
            "(expected e.g. 'sub,manual_ROI,cluster_id,note')"
        )

    out: List[MappingRow] = []
    for line_no, cells in enumerate(rows[1:], start=2):
        if not any(c.strip() for c in cells) or cells[0].lstrip().startswith("#"):
            continue

        def cell(i: Optional[int]) -> str:
            return cells[i].strip() if i is not None and i < len(cells) else ""

        sub_raw, roi = cell(i_sub), cell(i_roi)
        if not sub_raw or not roi:
            raise ValueError(f"{path}:{line_no}: sub and ROI name are both required: {cells!r}")
        try:
            ids = _parse_ids(cell(i_cid))
        except ValueError as e:
            raise ValueError(f"{path}:{line_no}: {e}") from None
        hemi_raw = cell(i_hemi)
        try:
            hemi_fs, _ = normalize_hemi(hemi_raw) if hemi_raw else (default_hemi_fs, "")
        except ValueError:
            raise ValueError(f"{path}:{line_no}: hemi must be lh/rh, got {hemi_raw!r}") from None
        out.append(MappingRow(line_no, _norm_sub(sub_raw), roi, ids, hemi_fs, cell(i_note)))
    return out


# ---------------------------------------------------------------------------
# Cluster discovery
# ---------------------------------------------------------------------------

def scan_clusters(clusters_dir: Path) -> Dict[str, Dict[str, Dict[int, Path]]]:
    """``{hemi_bids: {contrast: {cluster_id: path}}}`` for every cluster label in a dir."""
    out: Dict[str, Dict[str, Dict[int, Path]]] = {}
    if not clusters_dir.is_dir():
        return out
    for f in clusters_dir.glob("*_Cluster_*.label"):
        m = CLUSTER_RE.search(f.name)
        if not m:
            continue
        out.setdefault(m["hemi"], {}).setdefault(m["contrast"], {})[int(m["cid"])] = f
    return out


def resolve_contrast(available: List[str], wanted: str) -> Optional[str]:
    """Match the requested contrast to an on-disk name, case-insensitively."""
    for c in available:
        if c == wanted:
            return c
    for c in available:
        if c.lower() == wanted.lower():
            return c
    return None


def contrast_table(sub: str, by_hemi: Dict[str, Dict[str, Dict[int, Path]]]) -> Table:
    t = Table(title=f"Cluster contrasts available for {sub}", show_lines=False)
    t.add_column("hemi")
    t.add_column("contrast")
    t.add_column("n", justify="right")
    t.add_column("cluster ids")
    for hemi_bids in sorted(by_hemi):
        for contrast in sorted(by_hemi[hemi_bids]):
            ids = sorted(by_hemi[hemi_bids][contrast])
            t.add_row(hemi_bids, contrast, str(len(ids)), " ".join(map(str, ids)))
    return t


# ---------------------------------------------------------------------------
# Label IO
# ---------------------------------------------------------------------------

def read_label_rows(path: Path) -> np.ndarray:
    """(n, 5) float array: vertex, x, y, z, stat.  Skips the 2-line header."""
    arr = np.loadtxt(path, skiprows=2, ndmin=2)
    if arr.size == 0:
        return np.empty((0, 5))
    if arr.shape[1] != 5:
        raise ValueError(f"{path}: expected 5 columns per vertex, got {arr.shape[1]}")
    return arr


def merge_label_rows(arrays: List[np.ndarray]) -> np.ndarray:
    """Union of several labels; a vertex present in more than one keeps its first row."""
    if not arrays:
        return np.empty((0, 5))
    stacked = np.vstack(arrays)
    _, first = np.unique(stacked[:, 0].astype(int), return_index=True)
    return stacked[np.sort(first)]


def write_label(path: Path, rows: np.ndarray, comment: str) -> None:
    """FreeSurfer ASCII label: comment line, vertex count, then 'v x y z stat' rows."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        f.write(f"#!ascii label {comment}\n")
        f.write(f"{len(rows)}\n")
        for v, x, y, z, s in rows:
            f.write(f"{int(v)}  {x:.6f}  {y:.6f}  {z:.6f} {s:.10g}\n")


def surface_n_vertices(fs_sub_dir: Path, hemi_fs: str) -> Optional[int]:
    """Vertex count of the subject's surface, or None if no surface is readable."""
    for name in ("white", "pial", "inflated"):
        surf = fs_sub_dir / "surf" / f"{hemi_fs}.{name}"
        if surf.is_file():
            try:
                import nibabel as nib

                coords, _ = nib.freesurfer.read_geometry(str(surf))
                return int(coords.shape[0])
            except Exception:
                continue
    return None


# ---------------------------------------------------------------------------
# Plan (pure: no writing, no printing) and execute
# ---------------------------------------------------------------------------

def plan_subject(
    sub: str,
    rows: List[MappingRow],
    contrast: str,
    out_name: str,
    config: dict,
    out_dir: Optional[Path],
) -> SubjectPlan:
    """Resolve every row of one subject to concrete input and output files.

    Returns a plan whose ``errors`` list is non-empty if anything is missing;
    the caller decides whether to abort.  Rows with no cluster id are recorded
    under ``skipped``.
    """
    clusters_dir = resolve_dir(config, str(config.get("clusters_dir", "")), sub)
    fs_sub = fs_subject_dir(config, sub)
    dest = (out_dir / sub / out_name) if out_dir else (fs_sub / "label" / out_name)

    hemis = sorted({r.hemi_fs for r in rows})
    plan = SubjectPlan(sub, "+".join(hemis), contrast, clusters_dir, dest)

    by_hemi = scan_clusters(clusters_dir)
    if not by_hemi:
        plan.errors.append(f"no *_Cluster_*.label files under {clusters_dir}")
        return plan

    # Duplicate ROI names within a subject/hemi would silently overwrite each other.
    seen_roi: Dict[Tuple[str, str], int] = {}
    # A cluster assigned to two ROIs is almost always a sheet mistake — warn.
    owner: Dict[Tuple[str, int], str] = {}

    for row in rows:
        _, hemi_bids = normalize_hemi(row.hemi_fs)
        key = (row.hemi_fs, row.roi)
        if key in seen_roi:
            plan.errors.append(
                f"line {row.line_no}: ROI {row.roi!r} ({row.hemi_fs}) already defined on line {seen_roi[key]}"
            )
            continue
        seen_roi[key] = row.line_no

        if not row.cluster_ids:
            plan.skipped.append((row, "no cluster id"))
            continue

        contrasts = by_hemi.get(hemi_bids, {})
        real = resolve_contrast(list(contrasts), contrast)
        if real is None:
            plan.errors.append(
                f"line {row.line_no}: contrast {contrast!r} has no clusters for {sub} {row.hemi_fs}; "
                f"available: {', '.join(sorted(contrasts)) or 'none'}"
            )
            continue
        ids_on_disk = contrasts[real]
        missing = [i for i in row.cluster_ids if i not in ids_on_disk]
        if missing:
            plan.errors.append(
                f"line {row.line_no}: {row.roi}: cluster id(s) {missing} not found for "
                f"{real} {row.hemi_fs}; available: {' '.join(map(str, sorted(ids_on_disk)))}"
            )
            continue
        for cid in row.cluster_ids:
            k = (row.hemi_fs, cid)
            if k in owner:
                plan.warnings.append(
                    f"line {row.line_no}: cluster {cid} ({row.hemi_fs}) is assigned to both "
                    f"{owner[k]!r} and {row.roi!r}"
                )
            else:
                owner[k] = row.roi

        safe_roi = re.sub(r"[\s/\\]+", "-", row.roi)
        out_path = dest / f"{row.hemi_fs}.{safe_roi}.label"
        plan.labels.append(PlannedLabel(row, [ids_on_disk[i] for i in row.cluster_ids], out_path))

    return plan


def write_subject(plan: SubjectPlan, config: dict, csv_name: str) -> List[WrittenLabel]:
    """Merge and write every planned label.  Raises on unreadable input or out-of-range vertices."""
    fs_sub = fs_subject_dir(config, plan.sub)
    n_vert_cache: Dict[str, Optional[int]] = {}
    written: List[WrittenLabel] = []
    for pl in plan.labels:
        row = pl.row
        rows = merge_label_rows([read_label_rows(p) for p in pl.sources])
        if row.hemi_fs not in n_vert_cache:
            n_vert_cache[row.hemi_fs] = surface_n_vertices(fs_sub, row.hemi_fs)
        n_vert = n_vert_cache[row.hemi_fs]
        if n_vert is not None and len(rows) and int(rows[:, 0].max()) >= n_vert:
            raise ValueError(
                f"{row.roi}: vertex {int(rows[:, 0].max())} exceeds surface size {n_vert} "
                f"for {plan.sub} {row.hemi_fs} — wrong subject or hemisphere?"
            )
        ids = ",".join(map(str, row.cluster_ids))
        comment = (
            f", from subject {plan.sub} {row.hemi_fs} ROI={row.roi} "
            f"contrast={plan.contrast} clusters={ids} source={csv_name}"
        )
        replaced = pl.out_path.exists()
        write_label(pl.out_path, rows, comment)
        written.append(WrittenLabel(row.roi, pl.out_path, len(rows), row.cluster_ids, replaced))
    return written


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@app.command()
def main(
    mapping_csv: Optional[Path] = typer.Option(
        None, "--mapping-csv", "--mapping_csv", help="Rater's cluster_mapping.csv"
    ),
    contrast: str = typer.Option(
        DEFAULT_CONTRAST, "--contrast", help="Contrast whose clusters the ids refer to"
    ),
    out_name: str = typer.Option(
        DEFAULT_OUT_NAME, "--out-name", "--out_name", help="Sub-folder written under <sub>/label/"
    ),
    hemi: Optional[str] = typer.Option(
        None, "--hemi", help="lh or rh for rows without a hemi column (default: config default_hemi)"
    ),
    sub: Optional[str] = typer.Option(None, "--sub", help="Only this subject, e.g. 02"),
    out_dir: Optional[Path] = typer.Option(
        None, "--out-dir", "--out_dir",
        help="Write to <out-dir>/sub-XX/<out-name>/ instead of the FreeSurfer label dir",
    ),
    config_path: Path = typer.Option(DEFAULT_CONFIG, "--config", help="App config.yaml"),
    list_contrasts: bool = typer.Option(
        False, "--list-contrasts", help="Print the contrasts/cluster ids on disk and exit"
    ),
    clean: bool = typer.Option(
        False, "--clean", help="Delete existing <hemi>.*.label in the output folder first"
    ),
) -> None:
    console.rule("[bold]gen_manual_label[/bold]")
    t0 = time.time()

    config = load_config(config_path)
    default_hemi_fs, _ = normalize_hemi(hemi or str(config.get("default_hemi", "lh")))
    sub_filter = _norm_sub(sub) if sub else None

    # --- what is on disk -------------------------------------------------
    if list_contrasts or mapping_csv is None:
        if sub_filter is None:
            sub_filter = _norm_sub(str(config.get("default_subject", "01")))
        clusters_dir = resolve_dir(config, str(config.get("clusters_dir", "")), sub_filter)
        by_hemi = scan_clusters(clusters_dir)
        if not by_hemi:
            console.print(f"[red]ERROR[/red] no cluster labels under {clusters_dir}")
            raise typer.Exit(1)
        console.print(f"[dim]{clusters_dir}[/dim]")
        console.print(contrast_table(sub_filter, by_hemi))
        if mapping_csv is None:
            console.print("Pass [bold]--mapping-csv <file>[/bold] to build labels from a sheet.")
        raise typer.Exit(0)

    # --- parse the sheet -------------------------------------------------
    if not mapping_csv.is_file():
        console.print(f"[red]ERROR[/red] mapping csv not found: {mapping_csv}")
        raise typer.Exit(1)
    try:
        rows = read_mapping_csv(mapping_csv, default_hemi_fs)
    except ValueError as e:
        console.print(f"[red]ERROR[/red] {e}")
        raise typer.Exit(1)
    if sub_filter:
        rows = [r for r in rows if r.sub == sub_filter]
    if not rows:
        console.print(f"[red]ERROR[/red] no usable rows in {mapping_csv}"
                      + (f" for {sub_filter}" if sub_filter else ""))
        raise typer.Exit(1)

    subjects = sorted({r.sub for r in rows})
    console.print(
        f"sheet     : {mapping_csv}\n"
        f"contrast  : {contrast}\n"
        f"out name  : {out_name}\n"
        f"subjects  : {', '.join(subjects)}  ({len(rows)} rows)"
    )

    # --- plan everything, abort before writing if anything is wrong -----
    plans = [
        plan_subject(s, [r for r in rows if r.sub == s], contrast, out_name, config, out_dir)
        for s in subjects
    ]
    n_err = 0
    for plan in plans:
        for w in plan.warnings:
            console.print(f"  [yellow]WARN[/yellow] {plan.sub}: {w}")
        for e in plan.errors:
            console.print(f"  [red]ERROR[/red] {plan.sub}: {e}")
            n_err += 1
    if n_err:
        # Show what *is* there so the sheet can be fixed without a second run.
        first = plans[0]
        by_hemi = scan_clusters(first.clusters_dir)
        if by_hemi:
            console.print(contrast_table(first.sub, by_hemi))
        console.print(f"[red]{n_err} problem(s) in the sheet — nothing written.[/red]")
        raise typer.Exit(1)

    # --- write -----------------------------------------------------------
    for plan in plans:
        console.rule(f"{plan.sub}  {plan.hemi_fs}  {plan.contrast}")
        if clean and plan.out_dir.is_dir():
            for old in plan.out_dir.glob("*.label"):
                old.unlink()
                console.print(f"  [yellow]removed[/yellow] {old.name}")
        for row, why in plan.skipped:
            console.print(f"  [yellow]SKIP[/yellow] line {row.line_no} {row.roi}: {why}")
        try:
            written = write_subject(plan, config, mapping_csv.name)
        except (OSError, ValueError) as e:
            console.print(f"  [red]ERROR[/red] {e}")
            raise typer.Exit(1)
        for w in written:
            tag = "replaced" if w.replaced else "saved"
            console.print(
                f"  [green]{tag}[/green] {w.path.name:<32} "
                f"{w.n_vertices:>6} vertices  <- clusters {','.join(map(str, w.cluster_ids))}"
            )
        console.print(f"  -> {plan.out_dir}")

    # --- how to load it in the app ---------------------------------------
    if out_dir:
        template = f"{out_dir.expanduser().resolve()}/{{sub}}/{out_name}"
    else:
        template = f"{config.get('fs_dir', 'freesurfer-with_t2')}/{{sub}}/label/{out_name}"
    console.print(
        "\nTo view in the app, set panel 4 (or config.yaml) to:\n"
        f"  [bold]manual_label_dir: {template}[/bold]"
    )
    console.rule(
        f"Done {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ({time.time() - t0:.1f} s)"
    )


if __name__ == "__main__":
    app()
