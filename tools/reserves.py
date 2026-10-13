"""Reserve definitions shared by the baseline tools."""
from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "out"

# Context ring drawn around each boundary, in degrees (about 5.5 km).
BUFFER_DEG = 0.05

RESERVES = {
    "omo": {
        "name": "Omo Forest Reserve",
        "state": "Ogun",
        "wdpa_id": 36820,
        "wdpa_desig": "Forest Reserve",
        "reported_ha": 130_600,
        "boundary_note": (
            "World Database on Protected Areas polygon, site 36820, designation "
            "Forest Reserve. No gazette was consulted."
        ),
    },
    "pandam": {
        "name": "Pandam Wildlife Park",
        "state": "Plateau",
        "wdpa_id": 903111,
        "wdpa_desig": "Wetland of International Importance (Ramsar Site)",
        "reported_ha": 22_400,
        "boundary_note": (
            "No polygon for the wildlife park itself exists in the World Database "
            "on Protected Areas or OpenStreetMap. This is the Ramsar site polygon "
            "'Pandam and Wase Lakes' (site 903111), which is smaller than the "
            "22,400 ha reported for the park."
        ),
    },
}


# Synthetic test areas for the on-chain registry. They are measured by the same pipeline from another
# reserve's rasters, but they are not real projects and never appear in the baseline reports.
DEMO = {
    "overlap": {
        "name": "Overlap test area (synthetic)",
        "state": "Ogun",
        "wdpa_id": None,
        "wdpa_desig": "None: synthetic rectangle",
        "reported_ha": None,
        "data": "omo",
        "boundary": "demo_overlap.geojson",
        "boundary_note": (
            "A rectangle drawn by Kam Edge across the north-east edge of Omo Forest Reserve to test "
            "the registry's double-claim check. It is not a real project or a legal boundary."
        ),
    },
}


def config(key: str) -> dict:
    return RESERVES[key] if key in RESERVES else DEMO[key]


def data_dir(key: str) -> Path:
    """Folder holding the clipped rasters for a reserve (a test area borrows a real reserve's)."""
    return DATA / config(key).get("data", key)


def boundary_path(key: str) -> Path:
    cfg = config(key)
    return DATA / "boundaries" / cfg.get("boundary", f"wdpa_{cfg['wdpa_id']}.geojson")


def boundary(key: str):
    """Return the reserve polygon in EPSG:4326."""
    feats = json.loads(boundary_path(key).read_text())["features"]
    return unary_union([shape(f["geometry"]) for f in feats])


def bbox(key: str) -> tuple[float, float, float, float]:
    """Boundary bounds grown by the context ring: (west, south, east, north)."""
    w, s, e, n = boundary(key).bounds
    return (w - BUFFER_DEG, s - BUFFER_DEG, e + BUFFER_DEG, n + BUFFER_DEG)
