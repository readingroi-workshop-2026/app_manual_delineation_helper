#!/usr/bin/env python3
"""Import autoROI surface maps and cluster labels, applying the repo's contrast renaming.

Three operations, all scoped to --dst:

  1. delete   every *_scaled_mean.func.gii under --dst
  2. copy     {contrast}_{suffix}.func.gii overlays from --src
  3. copy     labels/*_contrast-{contrast}_scaled_Cluster_*.label from --src

Contrast renaming
-----------------
Upstream on /bcbl keeps its original contrast names; this repo uses shorter
ones (see RENAME).  Every destination path is passed through the mapping, and
for .label files the header comment is rewritten too — so a copied label
arrives already renamed and self-consistent.  --src is never modified.

Dry-run is the default.  Pass --execute to actually touch the filesystem.

Usage
-----
  python sync_autoroi_maps.py                             # dry run, all defaults
  python sync_autoroi_maps.py --execute --n-workers 8
  python sync_autoroi_maps.py --no-delete --no-overlays --execute   # labels only
  python sync_autoroi_maps.py --contrast RWvsAllnoWordnoLEX --execute
"""

from __future__ import annotations

import datetime
import shutil
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Tuple

import typer
from rich.console import Console
from rich.table import Table

console = Console()
app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)

ANALYSIS = "analysis-27_5ses_VOTC_IMOG_1.5T_real_height0.15"

# This file lives in <repo>/scripts/, so the repo root is one level up.
REPO_ROOT = Path(__file__).resolve().parents[1]

DATA_DIR_FALLBACK = "example_dataset"


def _repo_data_dir() -> Path:
    """The repo's bundled data root, as named by config.yaml's `repo_data_dir`.

    Read from the config rather than hardcoded so that renaming the data
    directory only ever has to happen in one place.  pyyaml is a dependency of
    the app but not of every env this script gets run from, so a missing import
    degrades to the fallback instead of failing.
    """
    try:
        import yaml

        cfg = yaml.safe_load((REPO_ROOT / "config.yaml").read_text()) or {}
        raw = cfg.get("repo_data_dir") or cfg.get("data_dir") or DATA_DIR_FALLBACK
    except Exception:
        raw = DATA_DIR_FALLBACK
    p = Path(str(raw)).expanduser()
    return p if p.is_absolute() else REPO_ROOT / p


SRC_DEFAULT = (
    "/bcbl/home/public/Gari/VOTCLOC/main_exp/derivatives/autoROI/individual/" + ANALYSIS
)
DST_DEFAULT = str(_repo_data_dir() / "autoROI" / "individual" / ANALYSIS)

# Source-side contrast names.  Keep in sync with rename_contrasts.py.
RENAME: Dict[str, str] = {
    "CSvsAllnoCSnoWordnoFF": "CSvsAllNotext",
    "RWvsAllnoWordnoLEX": "RWvsAllNotext",
    "RWvsPER": "RWvsSC",
}

# Every contrast the repo currently carries, named as they appear in --src.
CONTRAST_DEFAULT = [
    "CSvsAllnoCSnoWordnoFF",
    "FacesvsAllnoFace",
    "FacesvsAllnoFacenoCS",
    "LimbsvsAllnoLimbs",
    "LimbsvsAllnoLimbsnoCS",
    "RWvsAllnoWordnoLEX",
    "RWvsFF",
    "RWvsPER",
]
SUFFIX_DEFAULT = ["mean_raw", "score"]

PRUNE_GLOB = "*_scaled_mean.func.gii"
LABEL_DIR = "labels"


def _apply(text: str, mapping: Dict[str, str]) -> str:
    """Substitute every old token. Longest first so a token that is a prefix
    of another can never shadow it."""
    for old in sorted(mapping, key=len, reverse=True):
        text = text.replace(old, mapping[old])
    return text


def _assert_disjoint(src: Path, dst: Path) -> None:
    """Refuse to run if src and dst overlap — protects the source data."""
    if src == dst:
        console.print("[red]ERROR[/red] --src and --dst are the same directory")
        raise typer.Exit(code=1)
    if dst.is_relative_to(src) or src.is_relative_to(dst):
        console.print(
            f"[red]ERROR[/red] --src and --dst overlap:\n  src {src}\n  dst {dst}"
        )
        raise typer.Exit(code=1)


def _subject_dirs(src: Path) -> List[Path]:
    return sorted(p for p in src.iterdir() if p.is_dir() and p.name.startswith("sub-"))


def _find_prunable(dst: Path) -> List[Path]:
    """Every *_scaled_mean.func.gii under dst, sorted."""
    return sorted(dst.rglob(PRUNE_GLOB))


def _find_overlays(
    src: Path, dst: Path, contrasts: List[str], suffixes: List[str], mapping: Dict[str, str]
) -> List[Tuple[Path, Path]]:
    """(source, destination) pairs for the ses-5sesavg overlay maps.

    Only ses-5sesavg maps carry the mean_raw/score suffixes, so the glob is
    anchored on the subject directory rather than on a session list.
    """
    pairs: List[Tuple[Path, Path]] = []
    for subj_dir in _subject_dirs(src):
        for contrast in contrasts:
            for suffix in suffixes:
                pattern = f"*_desc-GDscaled_{contrast}_{suffix}.func.gii"
                for f in sorted(subj_dir.glob(pattern)):
                    pairs.append((f, dst / subj_dir.name / _apply(f.name, mapping)))
    return pairs


def _find_labels(
    src: Path, dst: Path, contrasts: List[str], mapping: Dict[str, str]
) -> List[Tuple[Path, Path]]:
    """(source, destination) pairs for the s3 cluster labels of each contrast."""
    pairs: List[Tuple[Path, Path]] = []
    for subj_dir in _subject_dirs(src):
        lbl_dir = subj_dir / LABEL_DIR
        if not lbl_dir.is_dir():
            continue
        for contrast in contrasts:
            pattern = f"*_contrast-{contrast}_scaled_Cluster_*.label"
            for f in sorted(lbl_dir.glob(pattern)):
                pairs.append(
                    (f, dst / subj_dir.name / LABEL_DIR / _apply(f.name, mapping))
                )
    return pairs


def _copy_one(src_f: Path, dst_f: Path, overwrite: bool, mapping: Dict[str, str]) -> str:
    """Copy one file, renaming tokens inside .label headers. Returns 'copied' or 'skipped'.

    .func.gii payloads are GZip+base64 and carry no contrast token, so they are
    copied byte-for-byte.  .label files are plain text whose first line names
    the contrast, so they are rewritten to match their new filename.
    """
    if dst_f.exists() and not overwrite:
        return "skipped"
    dst_f.parent.mkdir(parents=True, exist_ok=True)

    if src_f.suffix == ".label":
        text = src_f.read_text(encoding="utf-8")
        new_text = _apply(text, mapping)
        if new_text != text:
            dst_f.write_text(new_text, encoding="utf-8")
            shutil.copystat(src_f, dst_f)
            return "copied"

    shutil.copy2(src_f, dst_f)
    return "copied"


def _run_pass(
    pairs: List[Tuple[Path, Path]],
    dst_p: Path,
    label: str,
    execute: bool,
    overwrite: bool,
    mapping: Dict[str, str],
    n_workers: int,
) -> Tuple[int, int]:
    """Execute (or preview) one copy pass. Returns (n_copied, n_skipped)."""
    console.print(f"[bold]{label}[/bold]  {len(pairs)} file(s)")
    if not pairs:
        console.print("  [yellow]SKIP[/yellow] nothing matched — check --contrast spelling")
        return 0, 0

    if not execute:
        # One line per subject × contrast; a per-file dump would run to
        # thousands of lines for the labels.
        groups: Counter = Counter()
        n_exists = 0
        for s_f, d_f in pairs:
            groups[(d_f.parent.relative_to(dst_p))] += 1
            n_exists += d_f.exists()
        for d, n in sorted(groups.items()):
            console.print(f"  [dim]would copy[/dim] {n:>4}  →  {d}/")
        if n_exists:
            verb = "overwrite" if overwrite else "SKIP (already present)"
            console.print(f"  [yellow]{n_exists} of these would {verb}[/yellow]")
        return 0, 0

    def _run(pair: Tuple[Path, Path]) -> str:
        return _copy_one(pair[0], pair[1], overwrite, mapping)

    outcomes: List[str] = []
    if n_workers > 1:
        with ThreadPoolExecutor(max_workers=n_workers) as pool:
            futures = [pool.submit(_run, p) for p in pairs]
            for fut in as_completed(futures):
                outcomes.append(fut.result())
    else:
        outcomes = [_run(p) for p in pairs]

    n_copied = outcomes.count("copied")
    n_skipped = outcomes.count("skipped")
    console.print(f"  [green]saved[/green] {n_copied} file(s)")
    if n_skipped:
        console.print(f"  [yellow]SKIP[/yellow] {n_skipped} already present")
    return n_copied, n_skipped


@app.command()
def main(
    src: str = typer.Option(SRC_DEFAULT, "--src", help="Source analysis dir (read-only)."),
    dst: str = typer.Option(DST_DEFAULT, "--dst", help="Destination analysis dir."),
    contrast: List[str] = typer.Option(
        CONTRAST_DEFAULT, "--contrast", help="Contrast to import, named as in --src. Repeatable."
    ),
    suffix: List[str] = typer.Option(
        SUFFIX_DEFAULT, "--suffix", help="Overlay suffix to import. Repeatable."
    ),
    delete: bool = typer.Option(
        True, "--delete/--no-delete", help=f"Delete {PRUNE_GLOB} under --dst."
    ),
    overlays: bool = typer.Option(
        True, "--overlays/--no-overlays", help="Copy the .func.gii overlay maps."
    ),
    labels: bool = typer.Option(
        True, "--labels/--no-labels", help="Copy the s3 cluster .label files."
    ),
    rename: bool = typer.Option(
        True, "--rename/--no-rename", help="Apply the contrast renaming to copied files."
    ),
    overwrite: bool = typer.Option(
        False, "--overwrite", help="Overwrite destination files that already exist."
    ),
    execute: bool = typer.Option(
        False, "--execute", help="Actually modify the filesystem (default: dry run)."
    ),
    n_workers: int = typer.Option(1, "--n-workers", help="Parallel copy workers."),
) -> None:
    console.rule("[bold]sync_autoroi_maps[/bold]")
    t0 = time.time()

    src_p, dst_p = Path(src).resolve(), Path(dst).resolve()
    for p, lbl in ((src_p, "--src"), (dst_p, "--dst")):
        if not p.is_dir():
            console.print(f"[red]ERROR[/red] {lbl} is not a directory: {p}")
            raise typer.Exit(code=1)
    _assert_disjoint(src_p, dst_p)

    mapping = dict(RENAME) if rename else {}
    contrasts, suffixes = list(contrast), list(suffix)

    mode = "[bold red]EXECUTE[/bold red]" if execute else "[bold yellow]DRY RUN[/bold yellow]"
    info = Table.grid(padding=(0, 2))
    info.add_column(style="dim", no_wrap=True)
    info.add_column()
    info.add_row("Mode", mode)
    info.add_row("Source", f"{src_p}  [dim](read-only)[/dim]")
    info.add_row("Dest", str(dst_p))
    info.add_row("Contrasts", f"{len(contrasts)}  [dim]{', '.join(contrasts)}[/dim]")
    info.add_row("Suffixes", ", ".join(suffixes))
    info.add_row(
        "Renaming",
        "  ".join(f"[cyan]{o}[/cyan]→[bold]{n}[/bold]" for o, n in mapping.items())
        or "[dim]off[/dim]",
    )
    info.add_row("Overwrite", str(overwrite))
    info.add_row("Workers", str(n_workers))
    console.print(info)
    console.print()

    # --- step 1: prune scaled_mean maps ------------------------------------
    n_deleted = 0
    if delete:
        victims = _find_prunable(dst_p)
        console.print(f"[bold]1. delete[/bold]  {len(victims)} file(s) matching {PRUNE_GLOB}")
        for f in victims:
            # Belt and braces: every victim must live under dst.
            if not f.resolve().is_relative_to(dst_p):
                console.print(f"  [red]ERROR[/red] outside --dst, refusing: {f}")
                raise typer.Exit(code=1)
            if execute:
                f.unlink()
                n_deleted += 1
            else:
                console.print(f"  [dim]would delete[/dim] {f.relative_to(dst_p)}")
        if execute:
            console.print(f"  [green]deleted[/green] {n_deleted} file(s)")
        console.print()

    # --- step 2: overlays ---------------------------------------------------
    ov_pairs = _find_overlays(src_p, dst_p, contrasts, suffixes, mapping) if overlays else []
    ov_copied = ov_skipped = 0
    if overlays:
        ov_copied, ov_skipped = _run_pass(
            ov_pairs, dst_p, "2. copy overlays", execute, overwrite, mapping, n_workers
        )
        console.print()

    # --- step 3: labels -----------------------------------------------------
    lb_pairs = _find_labels(src_p, dst_p, contrasts, mapping) if labels else []
    lb_copied = lb_skipped = 0
    if labels:
        lb_copied, lb_skipped = _run_pass(
            lb_pairs, dst_p, "3. copy labels", execute, overwrite, mapping, n_workers
        )
        # A contrast with overlays but no labels upstream means s3 was never
        # run for it — worth saying out loud rather than silently importing 0.
        have = {c for c in contrasts
                if any(f"contrast-{c}_scaled_Cluster" in p.name for p, _ in lb_pairs)}
        for c in contrasts:
            if c not in have:
                console.print(f"  [yellow]SKIP[/yellow] no labels upstream for {c}")
        console.print()

    summary = Table(title="Summary", header_style="bold magenta")
    summary.add_column("Step", style="dim")
    summary.add_column("Files", justify="right")
    summary.add_column("Done" if execute else "Planned", justify="right")
    if delete:
        summary.add_row("delete scaled_mean",
                        str(n_deleted if execute else len(_find_prunable(dst_p))),
                        str(n_deleted) if execute else "—")
    if overlays:
        summary.add_row("copy overlays", str(len(ov_pairs)),
                        f"{ov_copied} copied / {ov_skipped} skipped" if execute else "—")
    if labels:
        summary.add_row("copy labels", str(len(lb_pairs)),
                        f"{lb_copied} copied / {lb_skipped} skipped" if execute else "—")
    console.print(summary)

    if not execute:
        console.print("\n[bold yellow]DRY RUN[/bold yellow] — rerun with --execute to apply.")

    console.rule(
        f"Done {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ({time.time() - t0:.1f} s)"
    )


if __name__ == "__main__":
    app()
