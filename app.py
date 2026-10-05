#!/usr/bin/env python3
"""Surface viewer for manual ROI delineation: inflated + pial side by side.

A small FastAPI server reads the FreeSurfer surfaces and the four layers, and a
browser page (static/, rendered by the three.js engine in static/engine/) shows
them. Every layer toggle, colour, fill and threshold applies instantly in the
browser; nothing is re-plotted on the server.

Layers (each reads a directory from config.yaml, editable live in the page):
  1 Heatmap overlay   heatmap_dir       *.func.gii
  2 Auto clusters     clusters_dir      *_Cluster_*.label
  3 Atlas labels      atlas_label_dir   <hemi>.*.label and <hemi>.*.annot
  4 Manual labels     manual_label_dir  <hemi>.*.label (e.g. tiger_delineation/)

Labels drawn in the page (Contour / Brush / Erase tabs) are saved to
<fs_dir>/<sub>/label/<folder>/<hemi>.<name>.label, the folder named in the page
(default: draw_label_dir). Deleting removes only such a saved label (and its sidecar). Nothing else is ever written.

Run:  uv run app.py            (then open http://localhost:8501)
"""

from __future__ import annotations

import base64
import re
import threading
import webbrowser
from pathlib import Path

import numpy as np
import typer
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from rich.console import Console

from utils import __version__
from utils.config import (
    fs_dir,
    fs_subject_dir,
    load_config,
    normalize_hemi,
    normalize_sub,
    resolve_dir,
)
from utils.discovery import (
    CLUSTER_COLORS,
    ROI_COLORS,
    WORD_ROIS,
    cluster_labels_in,
    clusters_by_contrast,
    heatmap_overlays_in,
    surface_labels_in,
)
from utils.labels import load_gifti_values, read_label_vertices, write_label
from utils.surface import load_curv, load_geometry, surf_path, tkr_to_scanner, voxel_affines

APP_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = APP_DIR / "config.yaml"
STATIC = APP_DIR / "static"
LAYER_KEYS = {
    "heatmap": "heatmap_dir",
    "clusters": "clusters_dir",
    "atlas": "atlas_label_dir",
    "manual": "manual_label_dir",
}
# Save-folder and label names: one path component, no leading dot, so a name
# can never climb out of the subject's label/ folder.
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")


class DrawnLabel(BaseModel):
    folder: str
    name: str
    vertices: list[int]

console = Console()
cli = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)


def annots_in(dir_path: Path, hemi_fs: str) -> dict[str, str]:
    """`<hemi>.<name>.annot` files in a directory -> ``{name: path}``."""
    if not dir_path.is_dir():
        return {}
    prefix = f"{hemi_fs}."
    return {
        f.name[len(prefix) : -len(".annot")]: str(f)
        for f in sorted(dir_path.glob(f"{hemi_fs}.*.annot"))
        if f.is_file()
    }


def list_subjects(config: dict) -> list[str]:
    """Subjects under fs_dir that have an inflated surface for either hemisphere."""
    root = fs_dir(config)
    if not root.is_dir():
        return []
    return [
        d.name
        for d in sorted(root.glob("sub-*"))
        if any((d / "surf" / f"{h}.inflated").is_file() for h in ("lh", "rh"))
    ]


def _binary(arr: np.ndarray) -> Response:
    data = np.ascontiguousarray(arr).tobytes()
    return Response(content=data, media_type="application/octet-stream")


def create_app(config: dict) -> FastAPI:
    app = FastAPI(title="delineation-helper", version=__version__)
    surfaces = list(config.get("surfaces") or ["inflated", "pial"])

    def check(sub: str, hemi: str) -> tuple[str, str, str]:
        """Validated (sub, hemi_fs, hemi_bids); only discovered subjects are served."""
        try:
            hemi_fs, hemi_bids = normalize_hemi(hemi)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        sub = normalize_sub(sub)
        if sub not in list_subjects(config):
            raise HTTPException(404, f"unknown subject {sub!r}")
        return sub, hemi_fs, hemi_bids

    def drawn_dir(sub: str, folder: str) -> Path:
        """<fs_dir>/<sub>/label/<folder>, the only place the page can write to."""
        if not NAME_RE.match(folder or ""):
            raise HTTPException(400, f"bad folder name {folder!r}: use letters, digits and . _ + -")
        return fs_subject_dir(config, sub) / "label" / folder

    def label_coords(sub: str, hemi_fs: str) -> tuple[np.ndarray, str]:
        """Label xyz come from white, as in FreeSurfer's own labels; else pial, else any."""
        for name in ["white", "pial", *surfaces]:
            path = surf_path(config, sub, hemi_fs, name)
            if path.is_file():
                return load_geometry(path)[0], name
        raise HTTPException(404, "no surface to take label coordinates from")

    def layer_dir(kind: str, sub: str, template: str | None) -> Path:
        tmpl = template if template else str(config.get(LAYER_KEYS[kind], ""))
        return resolve_dir(config, tmpl, sub)

    def listing(kind: str, sub: str, hemi_fs: str, hemi_bids: str, template: str | None):
        d = layer_dir(kind, sub, template)
        if kind == "heatmap":
            return d, heatmap_overlays_in(str(d), hemi_bids), {}
        if kind == "clusters":
            return d, cluster_labels_in(str(d), hemi_bids), {}
        return d, surface_labels_in(str(d), hemi_fs), annots_in(d, hemi_fs)

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    @app.get("/api/session")
    def session() -> dict:
        subjects = list_subjects(config)
        default = normalize_sub(str(config.get("default_subject", "")))
        return {
            "version": __version__,
            "fs_dir": str(fs_dir(config)),
            "subjects": subjects,
            "default_subject": default if default in subjects else (subjects or [None])[0],
            "default_hemi": str(config.get("default_hemi", "lh")),
            "default_contrast": str(config.get("default_contrast", "")),
            "surfaces": surfaces,
            "templates": {k: str(config.get(v, "")) for k, v in LAYER_KEYS.items()},
            "cluster_colors": CLUSTER_COLORS,
            "roi_colors": ROI_COLORS,
            "roi_names": [name for name, _ in WORD_ROIS],
            "draw_folder": str(config.get("draw_label_dir", "manual_delineation")),
            "draw_folders": [str(f) for f in (config.get("draw_label_folders") or [])],
        }

    @app.get("/api/{sub}/{hemi}/meta")
    def meta(
        sub: str,
        hemi: str,
        heatmap: str | None = None,
        clusters: str | None = None,
        atlas: str | None = None,
        manual: str | None = None,
    ) -> dict:
        sub, hemi_fs, hemi_bids = check(sub, hemi)
        found = [s for s in surfaces if surf_path(config, sub, hemi_fs, s).is_file()]
        if not found:
            raise HTTPException(404, f"none of {surfaces} found for {sub} {hemi_fs}")
        counts = {s: len(load_geometry(surf_path(config, sub, hemi_fs, s))[0]) for s in found}
        if len(set(counts.values())) != 1:
            raise HTTPException(409, f"surfaces disagree on vertex count: {counts}")
        templates = {"heatmap": heatmap, "clusters": clusters, "atlas": atlas, "manual": manual}
        layers = {}
        for kind, tmpl in templates.items():
            d, items, annots = listing(kind, sub, hemi_fs, hemi_bids, tmpl)
            layers[kind] = {"dir": str(d), "exists": d.is_dir(), "items": list(items)}
            if kind == "clusters":
                layers[kind]["by_contrast"] = clusters_by_contrast(items)
            if kind == "atlas":
                layers[kind]["annots"] = list(annots)
        # Rater folders next to the atlas labels, offered as manual-label sources.
        atlas_dir = layer_dir("atlas", sub, atlas)
        folders = sorted(p.name for p in atlas_dir.iterdir() if p.is_dir()) if atlas_dir.is_dir() else []
        return {
            "sub": sub,
            "hemi": hemi_fs,
            "n_vertices": next(iter(counts.values())),
            "surfaces": found,
            "has_curv": surf_path(config, sub, hemi_fs, "curv").is_file(),
            "layers": layers,
            "label_folders": folders,
        }

    @app.get("/api/{sub}/{hemi}/t1w/{vertex}")
    def t1w_coords(sub: str, hemi: str, vertex: int) -> dict:
        """Where vertex `vertex` lies in T1w space, on white and on pial: surface (tkr)
        RAS, scanner RAS, and the voxel of mri/T1.mgz (or orig.mgz) it falls in."""
        sub, hemi_fs, _ = check(sub, hemi)
        sdir = fs_subject_dir(config, sub)
        anat = [n for n in ("white", "pial") if surf_path(config, sub, hemi_fs, n).is_file()]
        if not anat:
            raise HTTPException(404, "no white or pial surface: inflated has no T1w position")
        xform, source = tkr_to_scanner(sdir, surf_path(config, sub, hemi_fs, anat[0]))
        t1 = next((sdir / "mri" / n for n in ("T1.mgz", "orig.mgz") if (sdir / "mri" / n).is_file()), None)
        if t1:
            file_aff, xyz_aff, axes = voxel_affines(t1)
            file_inv, xyz_inv = np.linalg.inv(file_aff), np.linalg.inv(xyz_aff)
        out = {"vertex": vertex, "transform": source, "volume": f"mri/{t1.name}" if t1 else None,
               "file_axes": axes if t1 else None, "surfaces": {}}
        for name in anat:
            coords = load_geometry(surf_path(config, sub, hemi_fs, name))[0]
            if not 0 <= vertex < len(coords):
                raise HTTPException(400, f"vertex {vertex} out of range 0..{len(coords) - 1}")
            tkr = np.append(coords[vertex].astype(float), 1.0)
            ras = xform @ tkr
            entry = {"tkr": tkr[:3].round(2).tolist(), "scanner": ras[:3].round(2).tolist()}
            if t1:
                # x, y, z order (R, A, S) -- what the sampling tool / WM page show --
                # and the raw file index (FreeSurfer LIA, what Freeview shows).
                entry["voxel"] = np.rint(xyz_inv @ ras)[:3].astype(int).tolist()
                entry["voxel_file"] = np.rint(file_inv @ ras)[:3].astype(int).tolist()
            out["surfaces"][name] = entry
        return out

    @app.get("/api/{sub}/{hemi}/surface/{surf}")
    def surface(sub: str, hemi: str, surf: str) -> Response:
        sub, hemi_fs, _ = check(sub, hemi)
        path = surf_path(config, sub, hemi_fs, surf)
        if surf not in surfaces or not path.is_file():
            raise HTTPException(404, f"no surface {surf!r}")
        return _binary(load_geometry(path)[0])

    @app.get("/api/{sub}/{hemi}/faces")
    def faces(sub: str, hemi: str) -> Response:
        sub, hemi_fs, _ = check(sub, hemi)
        for s in surfaces:
            path = surf_path(config, sub, hemi_fs, s)
            if path.is_file():
                return _binary(load_geometry(path)[1])
        raise HTTPException(404, "no surface found")

    @app.get("/api/{sub}/{hemi}/curv")
    def curv(sub: str, hemi: str) -> Response:
        sub, hemi_fs, _ = check(sub, hemi)
        path = surf_path(config, sub, hemi_fs, "curv")
        if not path.is_file():
            raise HTTPException(404, f"missing {path}")
        return _binary(load_curv(path))

    @app.get("/api/{sub}/{hemi}/heatmap")
    def heatmap(sub: str, hemi: str, name: str, dir: str | None = None) -> Response:
        sub, hemi_fs, hemi_bids = check(sub, hemi)
        _, items, _ = listing("heatmap", sub, hemi_fs, hemi_bids, dir)
        if name not in items:
            raise HTTPException(404, f"no heatmap {name!r}")
        return _binary(load_gifti_values(Path(items[name])).astype(np.float32))

    @app.get("/api/{sub}/{hemi}/layer")
    def layer(sub: str, hemi: str, kind: str, name: str, dir: str | None = None) -> dict:
        """One label (vertex list) or annot (regions + colours) of a layer.

        Only files the layer's listing returns are served, so `name` can't be
        used to read anything else.
        """
        sub, hemi_fs, hemi_bids = check(sub, hemi)
        if kind not in ("clusters", "atlas", "manual"):
            raise HTTPException(400, f"bad layer {kind!r}")
        _, labels, annots = listing(kind, sub, hemi_fs, hemi_bids, dir)
        if name in labels:
            vertices = read_label_vertices(Path(labels[name]))
            return {"kind": "label", "name": name, "vertices": vertices}
        if name in annots:
            import nibabel.freesurfer as nfs

            ids, ctab, names = nfs.read_annot(annots[name])
            return {
                "kind": "annot",
                "name": name,
                "names": [n.decode() if isinstance(n, bytes) else str(n) for n in names],
                "colors": ctab[:, :3].astype(int).tolist(),
                "labels": base64.b64encode(ids.astype(np.int32).tobytes()).decode(),
            }
        raise HTTPException(404, f"no {kind} file {name!r}")

    @app.get("/api/{sub}/{hemi}/drawn")
    def drawn(sub: str, hemi: str, folder: str) -> dict:
        """Every <hemi>.*.label in a save folder, to keep editing them."""
        sub, hemi_fs, _ = check(sub, hemi)
        d = drawn_dir(sub, folder)
        labels = {
            name: read_label_vertices(Path(path))
            for name, path in surface_labels_in(str(d), hemi_fs).items()
        }
        return {"dir": str(d), "exists": d.is_dir(), "labels": labels}

    @app.post("/api/{sub}/{hemi}/drawn")
    def save_drawn(sub: str, hemi: str, body: DrawnLabel) -> dict:
        sub, hemi_fs, _ = check(sub, hemi)
        if not NAME_RE.match(body.name):
            raise HTTPException(400, f"bad label name {body.name!r}: use letters, digits and . _ + -")
        path = drawn_dir(sub, body.folder) / f"{hemi_fs}.{body.name}.label"
        coords, coord_surf = label_coords(sub, hemi_fs)
        comment = (f", from subject {sub} vox2ras=TkReg {hemi_fs} ROI={body.name} "
                   f"coords={coord_surf} drawn-with=delineation-helper-{__version__}")
        try:
            n = write_label(path, body.vertices, coords, comment)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return {"path": str(path), "n_vertices": n}

    @app.delete("/api/{sub}/{hemi}/drawn")
    def delete_drawn(sub: str, hemi: str, folder: str, name: str) -> dict:
        """Delete one saved label of a save folder from disk: <hemi>.<name>.label and
        its .contour.json sidecar, if any. Same folder / name rules as saving."""
        sub, hemi_fs, _ = check(sub, hemi)
        if not NAME_RE.match(name):
            raise HTTPException(400, f"bad label name {name!r}: use letters, digits and . _ + -")
        path = drawn_dir(sub, folder) / f"{hemi_fs}.{name}.label"
        if not path.is_file():
            raise HTTPException(404, f"no saved label {path.name} in {path.parent}")
        removed = []
        for p in (path, path.with_name(f"{hemi_fs}.{name}.contour.json")):
            if p.is_file():
                p.unlink()
                removed.append(str(p))
        return {"path": str(path), "removed": removed}

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


@cli.command()
def main(
    config: Path = typer.Option(DEFAULT_CONFIG, "--config", "-c", help="config.yaml"),
    host: str = typer.Option("127.0.0.1", "--host", help="Bind address (0.0.0.0 to expose)"),
    port: int = typer.Option(8501, "--port", "-p"),
    open_browser: bool = typer.Option(True, "--open/--no-open", help="Open a browser tab"),
) -> None:
    """Start the viewer and print the URL to open."""
    import uvicorn

    try:
        cfg = load_config(config.expanduser())
    except Exception as e:
        console.print(f"[red]ERROR[/red] could not load {config}: {e}")
        raise typer.Exit(1) from e
    subjects = list_subjects(cfg)
    console.rule(f"[bold]delineation helper {__version__}[/bold]")
    console.print(f"  config     : {config}")
    console.print(f"  freesurfer : {fs_dir(cfg)}")
    shown = ", ".join(subjects[:6]) + (" ..." if len(subjects) > 6 else "")
    console.print(f"  subjects   : {len(subjects)} ({shown})")
    if not subjects:
        console.print(f"[yellow]SKIP[/yellow] no sub-*/surf/<hemi>.inflated under {fs_dir(cfg)}")
    url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}"
    console.print(f"\n  open [bold cyan]{url}[/bold cyan]   (Ctrl+C to stop)\n")
    if open_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    uvicorn.run(create_app(cfg), host=host, port=port, log_level="warning")


if __name__ == "__main__":
    cli()
