#!/usr/bin/env python3
"""Rename contrast tokens throughout this repo — filenames and text references.

Scoped strictly to --repo.  The upstream autoROI data on /bcbl keeps the old
names; nothing outside --repo is read or written.

Two passes:

  1. rename   files (and dirs) whose name contains an old token
  2. rewrite  the token inside text files — .label headers, config.yaml,
              app.py, README.md, docstrings

Scripts listed in EXCLUDE_NAMES are skipped by the rewrite pass because they
reference the *source-side* contrast names, which are deliberately unchanged.

Dry-run is the default.  Pass --execute to actually touch the filesystem.
An undo manifest (old<TAB>new) is written on every --execute run.

Usage
-----
  python rename_contrasts.py                       # dry run, default mapping
  python rename_contrasts.py --execute
  python rename_contrasts.py --map OldName=NewName --execute
  python rename_contrasts.py --no-rewrite --execute   # filenames only
"""

from __future__ import annotations

import datetime
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import typer
from rich.console import Console
from rich.table import Table

console = Console()
app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)

# This file lives in <repo>/scripts/, so the repo root is one level up.
REPO_DEFAULT = str(Path(__file__).resolve().parents[1])

MAPPING_DEFAULT: Dict[str, str] = {
    "CSvsAllnoCSnoWordnoFF": "CSvsAllNotext",
    "RWvsAllnoWordnoLEX": "RWvsAllNotext",
    "RWvsPER": "RWvsSC",
}

# Directories never descended into.
EXCLUDE_DIRS = {".git", "__pycache__", ".venv", ".streamlit"}

# Files never content-rewritten: they name the untouched source-side data.
EXCLUDE_NAMES = {"sync_autoroi_maps.py", "rename_contrasts.py"}

# Extensions treated as text for the rewrite pass.  .func.gii is excluded —
# its payload is base64 and carries no contrast token.
TEXT_EXT = {".label", ".yaml", ".yml", ".py", ".md", ".csv", ".txt", ".json", ".cfg"}


def _apply(name: str, mapping: Dict[str, str]) -> str:
    """Substitute every old token in `name`. Longest tokens first so that a
    token which is a prefix of another can never shadow it."""
    for old in sorted(mapping, key=len, reverse=True):
        name = name.replace(old, mapping[old])
    return name


def _walk(root: Path) -> List[Path]:
    """Every path under root, excluding EXCLUDE_DIRS, deepest first.

    Deepest-first ordering means a directory is renamed only after everything
    inside it, so no path goes stale mid-run.
    """
    out: List[Path] = []

    def _rec(d: Path) -> None:
        for p in sorted(d.iterdir()):
            if p.is_dir():
                if p.name in EXCLUDE_DIRS:
                    continue
                _rec(p)
            out.append(p)

    _rec(root)
    return sorted(out, key=lambda p: len(p.parts), reverse=True)


def _plan_renames(paths: List[Path], mapping: Dict[str, str]) -> List[Tuple[Path, Path]]:
    """(old, new) pairs for every path whose *basename* contains a token."""
    pairs: List[Tuple[Path, Path]] = []
    for p in paths:
        new_name = _apply(p.name, mapping)
        if new_name != p.name:
            pairs.append((p, p.with_name(new_name)))
    return pairs


def _plan_rewrites(paths: List[Path], mapping: Dict[str, str]) -> List[Tuple[Path, int]]:
    """(file, n_occurrences) for text files containing at least one token."""
    hits: List[Tuple[Path, int]] = []
    for p in paths:
        if not p.is_file() or p.name in EXCLUDE_NAMES:
            continue
        if p.suffix not in TEXT_EXT:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        n = sum(text.count(old) for old in mapping)
        if n:
            hits.append((p, n))
    return hits


def _rewrite_one(path: Path, mapping: Dict[str, str]) -> int:
    """Rewrite tokens in one file. Returns the number of substitutions."""
    text = path.read_text(encoding="utf-8")
    n = sum(text.count(old) for old in mapping)
    path.write_text(_apply(text, mapping), encoding="utf-8")
    return n


@app.command()
def main(
    repo: str = typer.Option(REPO_DEFAULT, "--repo", help="Repository root to rename within."),
    map_: Optional[List[str]] = typer.Option(
        None, "--map", help="Override mapping as OLD=NEW. Repeat for multiple."
    ),
    rename: bool = typer.Option(True, "--rename/--no-rename", help="Rename matching paths."),
    rewrite: bool = typer.Option(
        True, "--rewrite/--no-rewrite", help="Rewrite tokens inside text files."
    ),
    execute: bool = typer.Option(
        False, "--execute", help="Actually modify the filesystem (default: dry run)."
    ),
    manifest: Optional[str] = typer.Option(
        None, "--manifest", help="Undo manifest path (default: <repo>/../rename_manifest_<ts>.tsv)."
    ),
    n_workers: int = typer.Option(1, "--n-workers", help="Parallel workers for the rewrite pass."),
) -> None:
    console.rule("[bold]rename_contrasts[/bold]")
    t0 = time.time()

    repo_p = Path(repo).resolve()
    if not repo_p.is_dir():
        console.print(f"[red]ERROR[/red] --repo is not a directory: {repo_p}")
        raise typer.Exit(code=1)

    mapping = dict(MAPPING_DEFAULT)
    if map_:
        mapping = {}
        for spec in map_:
            if "=" not in spec:
                console.print(f"[red]ERROR[/red] --map needs OLD=NEW, got: {spec}")
                raise typer.Exit(code=1)
            old, new = spec.split("=", 1)
            mapping[old.strip()] = new.strip()

    mode = "[bold red]EXECUTE[/bold red]" if execute else "[bold yellow]DRY RUN[/bold yellow]"
    info = Table.grid(padding=(0, 2))
    info.add_column(style="dim", no_wrap=True)
    info.add_column()
    info.add_row("Mode", mode)
    info.add_row("Repo", str(repo_p))
    for old, new in mapping.items():
        info.add_row("Rename", f"[cyan]{old}[/cyan] → [bold]{new}[/bold]")
    info.add_row("Passes", " + ".join(
        p for p, on in (("rename", rename), ("rewrite", rewrite)) if on
    ) or "[dim]none[/dim]")
    info.add_row("Rewrite skips", ", ".join(sorted(EXCLUDE_NAMES)))
    info.add_row("Workers", str(n_workers))
    console.print(info)
    console.print()

    paths = _walk(repo_p)

    # --- pass 1: rename paths ----------------------------------------------
    n_renamed = 0
    pairs: List[Tuple[Path, Path]] = []
    if rename:
        pairs = _plan_renames(paths, mapping)
        console.print(f"[bold]1. rename[/bold]  {len(pairs)} path(s)")

        # A pre-existing destination would mean silent data loss — refuse.
        for old_p, new_p in pairs:
            if new_p.exists():
                console.print(f"  [red]ERROR[/red] target already exists: {new_p}")
                raise typer.Exit(code=1)

        by_dir: Dict[Path, int] = {}
        for old_p, _ in pairs:
            by_dir[old_p.parent] = by_dir.get(old_p.parent, 0) + 1

        if execute:
            for old_p, new_p in pairs:
                old_p.rename(new_p)
                n_renamed += 1
            console.print(f"  [green]renamed[/green] {n_renamed} path(s)")
        else:
            for d, n in sorted(by_dir.items()):
                console.print(f"  [dim]would rename[/dim] {n:>3}  in  {d.relative_to(repo_p)}/")
            for old_p, new_p in pairs[:5]:
                console.print(f"  [dim]e.g.[/dim] {old_p.name}  →  {new_p.name}")
            if len(pairs) > 5:
                console.print(f"  [dim]… and {len(pairs) - 5} more[/dim]")
        console.print()

    # --- pass 2: rewrite text contents --------------------------------------
    # Re-walk: pass 1 may have changed the paths on disk.
    n_files_rewritten = n_subs = 0
    if rewrite:
        paths = _walk(repo_p)
        hits = _plan_rewrites(paths, mapping)
        console.print(f"[bold]2. rewrite[/bold]  {len(hits)} file(s)")

        if not execute:
            for p, n in hits[:20]:
                console.print(f"  [dim]would rewrite[/dim] {n:>3}×  {p.relative_to(repo_p)}")
            if len(hits) > 20:
                console.print(f"  [dim]… and {len(hits) - 20} more files[/dim]")
        else:
            def _run(item: Tuple[Path, int]) -> int:
                return _rewrite_one(item[0], mapping)

            if n_workers > 1:
                with ThreadPoolExecutor(max_workers=n_workers) as pool:
                    futures = {pool.submit(_run, h): h for h in hits}
                    for fut in as_completed(futures):
                        n_subs += fut.result()
                        n_files_rewritten += 1
            else:
                for h in hits:
                    n_subs += _run(h)
                    n_files_rewritten += 1
            console.print(
                f"  [green]rewrote[/green] {n_subs} occurrence(s) in {n_files_rewritten} file(s)"
            )
        console.print()

    # --- undo manifest -------------------------------------------------------
    if execute and pairs:
        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        man_p = Path(manifest) if manifest else repo_p.parent / f"rename_manifest_{ts}.tsv"
        man_p.write_text(
            "".join(f"{o}\t{n}\n" for o, n in pairs), encoding="utf-8"
        )
        console.print(f"  [green]saved[/green] undo manifest → {man_p}")
        console.print()

    summary = Table(title="Summary", header_style="bold magenta")
    summary.add_column("Pass", style="dim")
    summary.add_column("Planned", justify="right")
    summary.add_column("Done", justify="right")
    if rename:
        summary.add_row("rename paths", str(len(pairs)), str(n_renamed) if execute else "—")
    if rewrite:
        summary.add_row(
            "rewrite contents",
            "see above",
            f"{n_subs} in {n_files_rewritten}" if execute else "—",
        )
    console.print(summary)

    if not execute:
        console.print("\n[bold yellow]DRY RUN[/bold yellow] — rerun with --execute to apply.")

    console.rule(
        f"Done {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ({time.time() - t0:.1f} s)"
    )


if __name__ == "__main__":
    app()
