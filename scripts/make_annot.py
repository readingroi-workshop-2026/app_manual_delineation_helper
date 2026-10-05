#!/usr/bin/env python3
"""Combine the ROI labels of one label folder into a FreeSurfer annotation.

For every subject and hemisphere, reads the labels named in the colour table

    <fs_dir>/<sub>/label/<folder>/<hemi>.<ROI>.label      (e.g. lh.mFus-words.label)

and writes, next to them,

    <hemi>.<annot-name>.ctab     the colour table that went into the annot
    <hemi>.<annot-name>.annot    via FreeSurfer's mris_label2annot

The folder is whatever you saved from the app's drawing tabs (or wrote with
gen_manual_label.py); because every rater saves the same ROI names, one run
works for any folder. The default colour table is the six word-ROIs in
utils/discovery.py (WORD_ROIS); ``--ctab`` takes your own (FreeSurfer LUT
format: ``index name R G B A``).

A missing or empty label is skipped with a warning. mris_label2annot maps the
k-th ``--l`` label to ctab index k, so the ctab written per hemisphere lists
only the labels that are actually passed -- each ROI keeps its colour and name
even when an earlier one is missing. Unlabelled vertices belong to no region. Vertices claimed by two ROIs are reported.

Needs FreeSurfer (mris_label2annot on PATH).

Usage
-----
  uv run scripts/make_annot.py --folder manual_delineation
  uv run scripts/make_annot.py --folder tiger_delineation --annot-name tiger_5ROIs \\
        --sub 02 --sub 03 --hemi lh
  uv run scripts/make_annot.py --folder manual_delineation --ctab my_rois.ctab
"""

from __future__ import annotations

import datetime
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from itertools import combinations
from pathlib import Path
from typing import List, Optional, Tuple

import typer
from rich.console import Console

# This file lives in <repo>/scripts/; utils/ is a sibling of scripts/.
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from utils.config import fs_dir, load_config, normalize_sub  # noqa: E402
from utils.discovery import WORD_ROIS  # noqa: E402
from utils.labels import read_label_vertices  # noqa: E402

console = Console()
app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)

DEFAULT_CONFIG = REPO_ROOT / "config.yaml"
Roi = Tuple[str, Tuple[int, int, int]]


@dataclass
class AnnotResult:
    sub: str
    hemi: str
    annot: Path
    included: List[Tuple[str, int]] = field(default_factory=list)  # (ROI, n vertices)
    missing: List[str] = field(default_factory=list)
    empty: List[str] = field(default_factory=list)
    overlaps: List[Tuple[str, str, int]] = field(default_factory=list)
    error: str = ""


def read_ctab(path: Path) -> List[Roi]:
    """``index name R G B A`` lines (FreeSurfer LUT) -> [(name, (r, g, b))], in index order."""
    rows = []
    for line in path.read_text().splitlines():
        parts = line.split("#", 1)[0].split()
        if not parts:
            continue
        if len(parts) < 5:
            raise ValueError(f"{path}: bad ctab line {line!r}")
        rows.append((int(parts[0]), parts[1], tuple(int(x) for x in parts[2:5])))
    return [(name, rgb) for _, name, rgb in sorted(rows)]


def write_ctab(path: Path, rois: List[Roi]) -> None:
    lines = ["# ROI colour table (written by make_annot.py)\n"]
    for idx, (name, (r, g, b)) in enumerate(rois):
        lines.append(f"{idx}  {name}  {r}  {g}  {b}  0\n")
    path.write_text("".join(lines))


def make_annot(
    fs_root: Path, sub: str, hemi: str, folder: str, annot_name: str,
    rois: List[Roi], surf: str = "white",
) -> AnnotResult:
    """Build ``<hemi>.<annot_name>.annot`` for one subject and hemisphere. No printing."""
    label_dir = fs_root / sub / "label" / folder
    res = AnnotResult(sub, hemi, label_dir / f"{hemi}.{annot_name}.annot")
    used: List[Roi] = []
    verts = {}
    for name, rgb in rois:
        path = label_dir / f"{hemi}.{name}.label"
        if not path.is_file():
            res.missing.append(name)
            continue
        v = read_label_vertices(path)
        if not v:
            res.empty.append(name)
            continue
        used.append((name, rgb))
        verts[name] = set(v)
        res.included.append((name, len(verts[name])))
    if not used:
        res.error = f"no {hemi}.<ROI>.label to combine in {label_dir}"
        return res
    for a, b in combinations(verts, 2):
        n = len(verts[a] & verts[b])
        if n:
            res.overlaps.append((a, b, n))

    ctab = label_dir / f"{hemi}.{annot_name}.ctab"
    write_ctab(ctab, used)
    # --no-unknown: label k -> ctab index k (from 0) and unlabelled vertices get no
    # region. Without it they become index 0, which then needs an "unknown" ctab
    # row, or nibabel (and so the app) reads every region name off by one.
    cmd = ["mris_label2annot", "--sd", str(fs_root), "--s", sub, "--hemi", hemi,
           "--surf", surf, "--ctab", str(ctab), "--annot-path", str(res.annot), "--no-unknown"]
    for name, _ in used:
        cmd += ["--l", str(label_dir / f"{hemi}.{name}.label")]
    # mris_label2annot refuses to overwrite an existing annot.
    res.annot.unlink(missing_ok=True)
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        msg = (proc.stderr.strip() or proc.stdout.strip() or "no output").splitlines()[-1]
        res.error = f"mris_label2annot exit {proc.returncode}: {msg}"
    return res


@app.command()
def main(
    folder: str = typer.Option(..., "--folder", help="Label sub-folder: <sub>/label/<folder>/"),
    annot_name: Optional[str] = typer.Option(
        None, "--annot-name", help="Writes <hemi>.<annot-name>.annot (default: the folder name)"
    ),
    subs: Optional[List[str]] = typer.Option(
        None, "--sub", help="Subject, e.g. 02 (repeatable; default: every sub-* that has the folder)"
    ),
    hemi: str = typer.Option("both", "--hemi", help="lh, rh or both"),
    ctab: Optional[Path] = typer.Option(
        None, "--ctab", help="Own colour table (index name R G B A); default: the word-ROIs"
    ),
    surf: str = typer.Option("white", "--surf", help="Surface mris_label2annot reads the vertex count from"),
    config_path: Path = typer.Option(DEFAULT_CONFIG, "--config", help="App config.yaml"),
) -> None:
    console.rule(f"[bold]make_annot — label/{folder}[/bold]")
    t0 = time.time()
    if not shutil.which("mris_label2annot"):
        console.print("[red]ERROR[/red] mris_label2annot not on PATH — source FreeSurfer first")
        raise typer.Exit(1)
    if hemi not in ("lh", "rh", "both"):
        console.print(f"[red]ERROR[/red] --hemi must be lh, rh or both, not {hemi!r}")
        raise typer.Exit(1)
    rois = read_ctab(ctab) if ctab else list(WORD_ROIS)
    annot_name = annot_name or folder
    root = fs_dir(load_config(config_path))
    if subs:
        subjects = [normalize_sub(s) for s in subs]
    else:
        subjects = sorted(d.name for d in root.glob("sub-*") if (d / "label" / folder).is_dir())
    if not subjects:
        console.print(f"[red]ERROR[/red] no sub-*/label/{folder}/ under {root}")
        raise typer.Exit(1)
    console.print(f"freesurfer : {root}\nROIs       : {', '.join(n for n, _ in rois)}")

    n_failed = 0
    for sub in subjects:
        for h in (("lh", "rh") if hemi == "both" else (hemi,)):
            res = make_annot(root, sub, h, folder, annot_name, rois, surf)
            if res.error and not res.included:
                # Nothing for this hemisphere: only an error when it was asked for by name.
                tag = "[red]ERROR[/red]" if hemi != "both" else "[yellow]SKIP[/yellow]"
                n_failed += hemi != "both"
                console.print(f"{tag} {sub} {h}: {res.error}")
                continue
            for name in res.missing:
                console.print(f"  [yellow]WARN[/yellow] {sub} {h}: missing {h}.{name}.label")
            for name in res.empty:
                console.print(f"  [yellow]WARN[/yellow] {sub} {h}: empty {h}.{name}.label, skipped")
            for a, b, n in res.overlaps:
                console.print(f"  [yellow]WARN[/yellow] {sub} {h}: {a} and {b} share {n} vertices")
            if res.error:
                console.print(f"[red]ERROR[/red] {sub} {h}: {res.error}")
                n_failed += 1
                continue
            rois_txt = ", ".join(f"{n} ({k})" for n, k in res.included)
            console.print(f"[green]saved[/green] {sub} {h}: {res.annot.name}  [dim]{rois_txt}[/dim]")

    console.rule(
        f"Done {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ({time.time() - t0:.1f} s)"
        + (f" — [red]{n_failed} failed[/red]" if n_failed else "")
    )
    if n_failed:
        raise typer.Exit(1)


if __name__ == "__main__":
    app()
