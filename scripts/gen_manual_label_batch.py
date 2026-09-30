#!/usr/bin/env python3
"""Build every rater's manual labels from the sheets in inter-rater_variability_check/.

Each ``<rater>_*.csv`` in the rater folder is one rater's cluster mapping.  For
every subject in it, the listed clusters are merged into one label per ROI via
``gen_manual_label`` and written to

    <data_root>/<fs_dir>/sub-XX/label/<rater>_<suffix>/lh.<ROI>.label
    <data_root>/<fs_dir>/sub-XX/label/<rater>_<suffix>/summary.yaml

The rater name is the file name up to the first underscore
(``alex_WordClusters.csv`` -> ``alex``).  A sheet with any bad row is reported
and nothing is written for it; the other sheets still run.

Usage
-----
  uv run scripts/gen_manual_label_batch.py
  uv run scripts/gen_manual_label_batch.py --contrast RWvsAllNotext --clean
"""

from __future__ import annotations

import datetime
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import typer
from rich.console import Console

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_manual_label import (  # noqa: E402
    DEFAULT_CONFIG,
    DEFAULT_CONTRAST,
    REPO_ROOT,
    WrittenLabel,
    load_config,
    normalize_hemi,
    plan_subject,
    read_mapping_csv,
    write_subject,
    write_summary,
)

console = Console()
app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)

DEFAULT_RATER_DIR = REPO_ROOT / "inter-rater_variability_check"
DEFAULT_SUFFIX = "delineation"


@dataclass
class SheetResult:
    """Outcome of one rater's sheet."""

    csv: Path
    rater: str
    out_name: str
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    written: dict = field(default_factory=dict)  # sub -> (out_dir, List[WrittenLabel])
    skipped: dict = field(default_factory=dict)  # sub -> ROI names with no cluster id


def rater_name(csv_path: Path) -> str:
    """'alex_WordClusters.csv' -> 'alex'."""
    return csv_path.stem.split("_", 1)[0]


def run_sheet(
    csv_path: Path, contrast: str, suffix: str, config: dict, hemi_fs: str, clean: bool
) -> SheetResult:
    """Plan and write all subjects of one sheet.  No printing; errors land in the result."""
    rater = rater_name(csv_path)
    res = SheetResult(csv_path, rater, f"{rater}_{suffix}")
    try:
        rows = read_mapping_csv(csv_path, hemi_fs)
    except ValueError as e:
        res.errors.append(str(e))
        return res

    subjects = sorted({r.sub for r in rows})
    plans = [
        plan_subject(s, [r for r in rows if r.sub == s], contrast, res.out_name, config, None)
        for s in subjects
    ]
    for plan in plans:
        res.warnings += [f"{plan.sub}: {w}" for w in plan.warnings]
        res.errors += [f"{plan.sub}: {e}" for e in plan.errors]
    if res.errors:
        return res

    for plan in plans:
        if clean and plan.out_dir.is_dir():
            for old in plan.out_dir.glob("*.label"):
                old.unlink()
        try:
            written: List[WrittenLabel] = write_subject(plan, config, csv_path.name)
            write_summary(plan, written, csv_path)
        except (OSError, ValueError) as e:
            res.errors.append(f"{plan.sub}: {e}")
            return res
        res.written[plan.sub] = (plan.out_dir, written)
        res.skipped[plan.sub] = [r.roi for r in plan.skipped]
    return res


@app.command()
def main(
    rater_dir: Path = typer.Option(
        DEFAULT_RATER_DIR, "--rater-dir", help="Folder holding one <rater>_*.csv per rater"
    ),
    contrast: str = typer.Option(
        DEFAULT_CONTRAST, "--contrast", help="Contrast whose clusters the ids refer to"
    ),
    suffix: str = typer.Option(
        DEFAULT_SUFFIX, "--suffix", help="Output folder is <sub>/label/<rater>_<suffix>/"
    ),
    hemi: Optional[str] = typer.Option(
        None, "--hemi", help="lh or rh for rows without a hemi column (default: config default_hemi)"
    ),
    config_path: Path = typer.Option(DEFAULT_CONFIG, "--config", help="App config.yaml"),
    clean: bool = typer.Option(
        False, "--clean", help="Delete existing *.label in each output folder first"
    ),
) -> None:
    console.rule("[bold]gen_manual_label_batch[/bold]")
    t0 = time.time()

    config = load_config(config_path)
    hemi_fs, _ = normalize_hemi(hemi or str(config.get("default_hemi", "lh")))
    sheets = sorted(rater_dir.glob("*.csv"))
    if not sheets:
        console.print(f"[red]ERROR[/red] no *.csv in {rater_dir}")
        raise typer.Exit(1)
    console.print(f"rater dir : {rater_dir}\ncontrast  : {contrast}\nsheets    : {len(sheets)}")

    n_failed = 0
    for csv_path in sheets:
        res = run_sheet(csv_path, contrast, suffix, config, hemi_fs, clean)
        console.rule(f"{res.rater}  ({csv_path.name})  -> {res.out_name}")
        for w in res.warnings:
            console.print(f"  [yellow]WARN[/yellow] {w}")
        for e in res.errors:
            console.print(f"  [red]ERROR[/red] {e}")
        if res.errors:
            console.print(f"  [red]nothing written for {res.rater}[/red]")
            n_failed += 1
            continue
        for sub, (out_dir, written) in res.written.items():
            skipped = res.skipped[sub]
            console.print(
                f"  [green]saved[/green] {sub}: {len(written)} labels"
                + (f" ([yellow]skipped {', '.join(skipped)}[/yellow])" if skipped else "")
                + f" + summary.yaml  [dim]{out_dir}[/dim]"
            )

    console.print(
        "\nTo view in the app, set panel 4 to:\n"
        f"  [bold]{config.get('fs_dir', 'freesurfer-with_t2')}/{{sub}}/label/<rater>_{suffix}[/bold]"
    )
    console.rule(
        f"Done {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ({time.time() - t0:.1f} s)"
        + (f" — [red]{n_failed} sheet(s) failed[/red]" if n_failed else "")
    )
    if n_failed:
        raise typer.Exit(1)


if __name__ == "__main__":
    app()
