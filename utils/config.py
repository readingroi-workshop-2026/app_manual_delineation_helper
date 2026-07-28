"""Config loading, subject/hemisphere naming, and path resolution.

This is the single place that knows how to turn the YAML config into concrete
locations on the derivatives tree. Nothing here does heavy IO or scanning
(see utils.discovery for that) — these are pure/near-pure path helpers plus a
small YAML loader.
"""

from __future__ import annotations

import os
from pathlib import Path


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

def load_config(path: Path) -> dict:
    """Load the YAML config, falling back to a tiny parser if PyYAML is absent.

    Records the config file's own directory under `_config_dir` so that a
    RELATIVE `data_dir` resolves relative to the config file (i.e. the repo),
    not the current working directory — this lets data shipped inside the repo
    be found no matter where the repo is cloned or where the app is launched.
    """
    path = Path(path)
    try:
        import yaml  # type: ignore

        with path.open("r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
    except ModuleNotFoundError:
        cfg = _load_simple_yaml(path)
    if isinstance(cfg, dict):
        cfg.setdefault("_config_dir", str(path.resolve().parent))
    return cfg


def _parse_scalar(value: str):
    if value in {"true", "false"}:
        return value == "true"
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def _load_simple_yaml(path: Path) -> dict:
    """Minimal reader for this config's top-level scalars/lists/dicts."""
    root: dict = {}
    current_key: str | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line:
            continue
        indent = len(line) - len(line.lstrip(" "))
        text = line.strip()
        if indent == 0:
            key, sep, value = text.partition(":")
            if not sep:
                raise ValueError(f"Invalid config line in {path}: {raw}")
            current_key = key.strip()
            value = value.strip()
            root[current_key] = _parse_scalar(value) if value else None
            continue
        if current_key is None:
            raise ValueError(f"Indented config line without section in {path}: {raw}")
        if text.startswith("- "):
            if root[current_key] is None:
                root[current_key] = []
            root[current_key].append(_parse_scalar(text[2:]))
            continue
        key, sep, value = text.partition(":")
        if not sep:
            raise ValueError(f"Invalid config line in {path}: {raw}")
        if root[current_key] is None:
            root[current_key] = {}
        root[current_key][key.strip()] = _parse_scalar(value.strip())
    return root


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------

def normalize_sub(value: str) -> str:
    value = value.strip()
    return value if value.startswith("sub-") else f"sub-{value}"


def normalize_hemi(value: str) -> tuple[str, str]:
    """Return (freesurfer_hemi, bids_hemi), e.g. 'lh' -> ('lh', 'L')."""
    value = value.lower()
    if value in {"lh", "l"}:
        return "lh", "L"
    if value in {"rh", "r"}:
        return "rh", "R"
    raise ValueError("hemi must be lh, rh, L, or R")


# ---------------------------------------------------------------------------
# Base directories (surface geometry lives under fs_dir)
# ---------------------------------------------------------------------------

def data_dir(config: dict) -> Path:
    """Resolve the data root, chosen by the `data_source` field:

      data_source: repo  -> use `repo_data_dir` (bundled data in this repo)
      data_source: disk  -> use `disk_data_dir` (a full tree elsewhere)

    Whichever path is chosen: an absolute path is used as-is; a relative path
    is resolved against the config file's directory (`_config_dir`), so in-repo
    data is found regardless of the launch cwd. Falls back to a legacy
    `data_dir` field if the source-specific one is absent.
    """
    source = str(config.get("data_source", "repo")).strip().lower()
    key = "disk_data_dir" if source == "disk" else "repo_data_dir"
    raw = config.get(key, config.get("data_dir"))
    if raw is None:
        raise KeyError(
            f"config needs '{key}' (for data_source: {source}) or a legacy 'data_dir'"
        )
    p = Path(os.path.expanduser(str(raw)))
    if p.is_absolute():
        return p
    base = Path(str(config.get("_config_dir", ".")))
    return (base / p).resolve()


def fs_dir(config: dict) -> Path:
    return data_dir(config) / str(config.get("fs_dir", "freesurfer-with_t2"))


def fs_subject_dir(config: dict, sub: str) -> Path:
    return fs_dir(config) / sub


# ---------------------------------------------------------------------------
# Generic layer-path resolution
# ---------------------------------------------------------------------------

def resolve_dir(config: dict, template: str, sub: str) -> Path:
    """Resolve a layer-path template to a concrete directory.

    `template` comes either from a config field (heatmap_dir, clusters_dir,
    atlas_label_dir, manual_label_dir) or from the live text box in the app.
    `{sub}` is substituted with the normalized subject; a relative result is
    resolved under data_dir, an absolute one is used as-is.
    """
    sub = normalize_sub(sub)
    raw = str(template or "").replace("{sub}", sub)
    p = Path(os.path.expanduser(raw))
    return p if p.is_absolute() else data_dir(config) / p
