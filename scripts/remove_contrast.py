#!/usr/bin/env python3
"""Delete every file belonging to a contrast, under one or more roots.

Matches on the contrast token appearing anywhere in a *filename*, so it sweeps
overlays, per-session maps, cluster .pkl/.csv and .label files alike.

Dry-run is the default and prints the full inventory grouped by file type.
Deletion happens only with --execute, and a manifest of everything removed is
written first so the list survives the run.

Safety
------
  * A token shorter than MIN_TOKEN characters is refused.
  * A token that is a prefix of some *other* file's contrast is refused —
    that would delete more than asked.
  * Every victim is re-checked to live under a declared root before unlinking.
  * Directories are never removed, only files.

Usage
-----
  # dry run (default) — the two targets from the current cleanup
  python remove_contrast.py \\
      --target /bcbl/.../analysis-27_5ses_VOTC_IMOG_1.5T_real_height0.15=RWvsAllnoWordnoCS \\
      --target /home/tlei/.../app_manual_delineation_helper=RWvsAllnoletterstring

  # same, actually deleting
  python remove_contrast.py --target ...=... --execute
"""

from __future__ import annotations

import datetime
import re
import time
from collections import Counter
from pathlib import Path
from typing import List, Optional, Tuple

import typer
from rich.console import Console
from rich.table import Table

console = Console()
app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)

MIN_TOKEN = 6
EXCLUDE_DIRS = {".git", "__pycache__", ".venv"}

# Collapse subject/session/hemi so the dry-run inventory stays readable.
_NORMALISE = (
    (re.compile(r"^sub-[0-9]+_"), ""),
    (re.compile(r"ses-[0-9]+"), "ses-XX"),
    (re.compile(r"hemi-[LR]"), "hemi-H"),
)


def _kind(name: str) -> str:
    for pat, repl in _NORMALISE:
        name = pat.sub(repl, name)
    return name


def _walk(root: Path) -> List[Path]:
    out: List[Path] = []

    def _rec(d: Path) -> None:
        for p in sorted(d.iterdir()):
            if p.is_dir():
                if p.name not in EXCLUDE_DIRS:
                    _rec(p)
            else:
                out.append(p)

    _rec(root)
    return out


def _find(root: Path, token: str) -> List[Path]:
    return [p for p in _walk(root) if token in p.name]


def _check_not_prefix(root: Path, token: str, victims: List[Path]) -> Optional[str]:
    """Reject a token that also matches a longer contrast name.

    `CSvsAllnoCSnoWord` inside `CSvsAllnoCSnoWordnoFF` is the failure this
    guards against: deleting on the short token would take both contrasts.
    """
    longer = set()
    for p in victims:
        for m in re.finditer(re.escape(token) + r"[A-Za-z0-9]+", p.name):
            longer.add(m.group(0))
    if longer:
        return (
            f"token '{token}' also matches longer name(s): {', '.join(sorted(longer))}"
        )
    return None


@app.command()
def main(
    target: List[str] = typer.Option(
        ...,
        "--target",
        help="ROOT=TOKEN pair. Repeat for multiple roots.",
    ),
    manifest: Optional[str] = typer.Option(
        None, "--manifest", help="Where to write the deleted-file list (default: alongside cwd)."
    ),
    execute: bool = typer.Option(
        False, "--execute", help="Actually delete (default: dry run)."
    ),
) -> None:
    console.rule("[bold]remove_contrast[/bold]")
    t0 = time.time()

    pairs: List[Tuple[Path, str]] = []
    for spec in target:
        if "=" not in spec:
            console.print(f"[red]ERROR[/red] --target needs ROOT=TOKEN, got: {spec}")
            raise typer.Exit(code=1)
        root_s, token = spec.rsplit("=", 1)
        root, token = Path(root_s).resolve(), token.strip()
        if len(token) < MIN_TOKEN:
            console.print(f"[red]ERROR[/red] token '{token}' is too short (min {MIN_TOKEN})")
            raise typer.Exit(code=1)
        if not root.is_dir():
            console.print(f"[red]ERROR[/red] root is not a directory: {root}")
            raise typer.Exit(code=1)
        pairs.append((root, token))

    mode = "[bold red]EXECUTE[/bold red]" if execute else "[bold yellow]DRY RUN[/bold yellow]"
    console.print(f"Mode  {mode}\n")

    all_victims: List[Path] = []
    roots: List[Path] = []
    for root, token in pairs:
        victims = _find(root, token)
        problem = _check_not_prefix(root, token, victims)
        if problem:
            console.print(f"[red]ERROR[/red] {problem}")
            raise typer.Exit(code=1)

        total_mb = sum(p.stat().st_size for p in victims) / 1048576
        console.print(f"[bold]{root}[/bold]")
        console.print(f"  token [cyan]{token}[/cyan] — {len(victims)} file(s), {total_mb:.1f} MB")
        if not victims:
            console.print("  [yellow]SKIP[/yellow] nothing matched\n")
            continue

        kinds: Counter = Counter(_kind(p.name) for p in victims)
        table = Table(show_header=True, header_style="bold magenta", box=None, pad_edge=False)
        table.add_column("  count", justify="right", style="dim")
        table.add_column("file type")
        for k, n in sorted(kinds.items()):
            table.add_row(str(n), k)
        console.print(table)
        console.print()

        all_victims.extend(victims)
        roots.append(root)

    if not all_victims:
        console.print("[yellow]Nothing to delete.[/yellow]")
        raise typer.Exit(code=0)

    summary = Table(title="Summary", header_style="bold magenta")
    summary.add_column("Root", style="dim")
    summary.add_column("Token")
    summary.add_column("Files", justify="right")
    for root, token in pairs:
        summary.add_row(str(root), token, str(len(_find(root, token))))
    summary.add_row("[bold]TOTAL[/bold]", "", f"[bold]{len(all_victims)}[/bold]")
    console.print(summary)

    if not execute:
        console.print(
            "\n[bold yellow]DRY RUN[/bold yellow] — nothing was deleted. "
            "Rerun with --execute to apply."
        )
        console.rule(f"Done ({time.time() - t0:.1f} s)")
        return

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    man_p = Path(manifest) if manifest else Path.cwd() / f"removed_files_{ts}.txt"
    man_p.write_text("".join(f"{p}\n" for p in all_victims), encoding="utf-8")
    console.print(f"\n  [green]saved[/green] manifest → {man_p}")

    n = 0
    for p in all_victims:
        if not any(p.resolve().is_relative_to(r) for r in roots):
            console.print(f"  [red]ERROR[/red] outside every root, refusing: {p}")
            raise typer.Exit(code=1)
        p.unlink()
        n += 1
    console.print(f"  [green]deleted[/green] {n} file(s)")

    console.rule(
        f"Done {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ({time.time() - t0:.1f} s)"
    )


if __name__ == "__main__":
    app()
