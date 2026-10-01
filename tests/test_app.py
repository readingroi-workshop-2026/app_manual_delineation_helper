"""API tests for the viewer server (app.py) on a tiny synthetic dataset."""

from __future__ import annotations

import base64
import filecmp
import sys
from pathlib import Path

import nibabel as nib
import nibabel.freesurfer as nfs
import numpy as np
import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from app import create_app  # noqa: E402
from utils.config import load_config  # noqa: E402

N = 12  # icosahedron vertices


def icosahedron() -> tuple[np.ndarray, np.ndarray]:
    t = (1 + 5**0.5) / 2
    v = np.array(
        [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
         [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]],
        dtype=float,
    )
    f = np.array(
        [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4],
         [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8],
         [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]],
        dtype=np.int32,
    )
    return v * 30, f


def write_label(path: Path, vertices: list[int]) -> None:
    rows = "".join(f"{v} 0 0 0 0\n" for v in vertices)
    path.write_text(f"#!ascii label\n{len(vertices)}\n{rows}")


@pytest.fixture
def dataset(tmp_path):
    coords, faces = icosahedron()
    fs = tmp_path / "freesurfer-with_t2" / "sub-01"
    (fs / "surf").mkdir(parents=True)
    label = fs / "label"
    (label / "tiger_delineation").mkdir(parents=True)
    for h in ("lh", "rh"):
        nfs.write_geometry(str(fs / "surf" / f"{h}.inflated"), coords * 1.5, faces)
        nfs.write_geometry(str(fs / "surf" / f"{h}.pial"), coords, faces)
        nfs.write_morph_data(str(fs / "surf" / f"{h}.curv"), coords[:, 2] / 30)
    write_label(label / "lh.FG1.mpm.vpnl.label", [0, 1, 5])
    write_label(label / "tiger_delineation" / "lh.mFus-words.label", [2, 3])
    nfs.write_annot(
        str(label / "lh.aparc.annot"), (coords[:, 0] > 0).astype(np.int32),
        np.array([[25, 5, 25, 0, 0], [220, 20, 10, 0, 0]], dtype=np.int32),
        [b"unknown", b"east"], fill_ctab=True,
    )
    # A template subject without the sub- prefix must not be offered.
    (tmp_path / "freesurfer-with_t2" / "fsaverage" / "surf").mkdir(parents=True)

    auto = tmp_path / "autoROI" / "sub-01"
    (auto / "labels").mkdir(parents=True)
    values = np.linspace(0, 2, N).astype(np.float32)
    img = nib.gifti.GiftiImage(darrays=[nib.gifti.GiftiDataArray(values)])
    nib.save(img, str(auto / "sub-01_ses-5sesavg_hemi-L_desc-GDscaled_RWvsSC_score.func.gii"))
    nib.save(img, str(auto / "sub-01_ses-5sesavg_hemi-R_desc-GDscaled_RWvsSC_score.func.gii"))
    for cid, verts in ((0, [0, 1]), (2, [4, 5, 6])):
        write_label(auto / "labels" / f"sub-01_hemi-L_contrast-RWvsSC_scaled_Cluster_{cid}.label", verts)

    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "data_source: repo\n"
        f"repo_data_dir: {tmp_path}\n"
        "fs_dir: freesurfer-with_t2\n"
        'default_subject: "01"\n'
        "default_hemi: lh\n"
        "default_contrast: RWvsSC\n"
        "heatmap_dir: autoROI/{sub}\n"
        "clusters_dir: autoROI/{sub}/labels\n"
        "atlas_label_dir: freesurfer-with_t2/{sub}/label\n"
        "manual_label_dir: freesurfer-with_t2/{sub}/label/tiger_delineation\n"
    )
    return tmp_path, TestClient(create_app(load_config(cfg)))


def test_session(dataset):
    _, c = dataset
    s = c.get("/api/session").json()
    assert s["subjects"] == ["sub-01"]
    assert s["default_subject"] == "sub-01"
    assert s["templates"]["clusters"] == "autoROI/{sub}/labels"
    assert s["roi_colors"]["mfus"].startswith("#")


def test_meta_lists_every_layer(dataset):
    _, c = dataset
    m = c.get("/api/sub-01/lh/meta").json()
    assert m["n_vertices"] == N
    assert m["surfaces"] == ["inflated", "pial"]
    L = m["layers"]
    assert L["heatmap"]["items"] == ["RWvsSC_score"]
    assert L["clusters"]["by_contrast"] == {"RWvsSC": ["RWvsSC #0", "RWvsSC #2"]}
    assert L["atlas"]["items"] == ["FG1.mpm.vpnl"]
    assert L["atlas"]["annots"] == ["aparc"]
    assert L["manual"]["items"] == ["mFus-words"]
    assert m["label_folders"] == ["tiger_delineation"]


def test_meta_folder_override(dataset):
    _, c = dataset
    m = c.get("/api/sub-01/lh/meta", params={"manual": "nowhere/{sub}"}).json()
    assert m["layers"]["manual"] == {"dir": m["layers"]["manual"]["dir"], "exists": False, "items": []}


def test_geometry_is_shared(dataset):
    _, c = dataset
    infl = np.frombuffer(c.get("/api/sub-01/lh/surface/inflated").content, np.float32)
    pial = np.frombuffer(c.get("/api/sub-01/lh/surface/pial").content, np.float32)
    faces = np.frombuffer(c.get("/api/sub-01/lh/faces").content, np.int32)
    assert infl.size == pial.size == N * 3 and np.allclose(infl, pial * 1.5, atol=1e-4)
    assert faces.max() == N - 1
    assert np.frombuffer(c.get("/api/sub-01/lh/curv").content, np.float32).size == N


def test_heatmap_values(dataset):
    _, c = dataset
    r = c.get("/api/sub-01/lh/heatmap", params={"name": "RWvsSC_score"})
    vals = np.frombuffer(r.content, np.float32)
    assert vals.size == N and np.isclose(vals.max(), 2)
    assert c.get("/api/sub-01/lh/heatmap", params={"name": "nope"}).status_code == 404


def test_layers_label_and_annot(dataset):
    _, c = dataset
    get = lambda kind, name: c.get("/api/sub-01/lh/layer", params={"kind": kind, "name": name})  # noqa: E731
    assert get("clusters", "RWvsSC #2").json()["vertices"] == [4, 5, 6]
    assert get("atlas", "FG1.mpm.vpnl").json()["vertices"] == [0, 1, 5]
    assert get("manual", "mFus-words").json()["vertices"] == [2, 3]
    a = get("atlas", "aparc").json()
    assert a["kind"] == "annot" and a["names"] == ["unknown", "east"]
    assert set(np.frombuffer(base64.b64decode(a["labels"]), np.int32)) == {0, 1}


def test_only_listed_files_are_served(dataset):
    _, c = dataset
    for kind, name in (("atlas", "../../etc/passwd"), ("manual", "FG1.mpm.vpnl"),
                       ("heatmap", "x"), ("clusters", "RWvsSC #9")):
        assert c.get("/api/sub-01/lh/layer", params={"kind": kind, "name": name}).status_code in (400, 404)
    assert c.get("/api/fsaverage/lh/meta").status_code == 404
    assert c.get("/api/sub-01/xh/meta").status_code == 400


def test_page_and_engine_served(dataset):
    _, c = dataset
    assert "Delineation Helper" in c.get("/").text
    assert c.get("/static/vendor/surface_annotate/viewer.js").status_code == 200


def test_vendored_engine_matches_surface_annotate():
    upstream = REPO.parent / "app_surface_annotate" / "src" / "surface_annotate" / "static"
    if not upstream.is_dir():
        pytest.skip("app_surface_annotate is not checked out next to this repo")
    for name in ("viewer.js", "mesh.js"):
        assert filecmp.cmp(upstream / name, REPO / "static" / "vendor" / "surface_annotate" / name,
                           shallow=False), f"{name} differs from surface-annotate; re-copy it"
