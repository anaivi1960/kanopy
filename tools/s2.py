#!/usr/bin/env python3
"""Fetch one recent low-cloud Sentinel-2 scene per reserve (red, green, blue, NIR).

Searches the Element 84 Earth Search catalogue (Sentinel-2 L2A on AWS) for the dry season just
gone, picks the least cloudy scene that covers the reserve's bounding box, and
writes a 4-band reflectance GeoTIFF on a 20 m (0.0002 degree) grid.

    python s2.py [reserve ...]
"""
from __future__ import annotations

import json
import os
import socket
import sys
import urllib.request

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import Resampling
from shapely.geometry import box, shape

from reserves import DATA, RESERVES, bbox

# IPv6 is broken on this network; resolve IPv4 only.
_gai = socket.getaddrinfo
socket.getaddrinfo = lambda h, p, f=0, *a, **k: _gai(h, p, socket.AF_INET, *a, **k)

os.environ.update(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="90", GDAL_HTTP_MAX_RETRY="4")

STAC = "https://earth-search.aws.element84.com/v1/search"
WINDOWS = ["2025-11-15T00:00:00Z/2026-03-15T23:59:59Z", "2024-11-15T00:00:00Z/2025-03-15T23:59:59Z"]
BANDS = ["red", "green", "blue", "nir"]
RES = 0.0002


def post(url: str, body: dict) -> dict:
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def pick(b) -> dict | None:
    want = box(*b)
    for window in WINDOWS:
        res = post(STAC, {
            "collections": ["sentinel-2-l2a"], "bbox": list(b), "datetime": window,
            "query": {"eo:cloud_cover": {"lt": 15}}, "limit": 100,
        })
        full = [f for f in res["features"] if shape(f["geometry"]).intersection(want).area / want.area > 0.98]
        cands = full or res["features"]
        if cands:
            cands.sort(key=lambda f: (
                -shape(f["geometry"]).intersection(want).area, f["properties"]["eo:cloud_cover"]))
            if full:
                cands.sort(key=lambda f: f["properties"]["eo:cloud_cover"])
            return cands[0]
    return None


def fetch(key: str) -> None:
    dest = DATA / key / "s2_recent.tif"
    b = bbox(key)
    if dest.exists():
        print(key, "have", dest.name)
        return
    item = pick(b)
    if item is None:
        print(key, "no scene found")
        return
    p = item["properties"]
    cover = shape(item["geometry"]).intersection(box(*b)).area / box(*b).area
    print(key, item["id"], p["datetime"][:10], f"cloud {p['eo:cloud_cover']:.1f}%", f"covers {cover:.0%}")
    w = round((b[2] - b[0]) / RES)
    h = round((b[3] - b[1]) / RES)
    transform = from_bounds(*b, w, h)
    out = np.zeros((len(BANDS), h, w), "uint16")
    for i, band in enumerate(BANDS):
        with rasterio.open("/vsicurl/" + item["assets"][band]["href"]) as src:
            with WarpedVRT(src, crs="EPSG:4326", transform=transform, width=w, height=h,
                           resampling=Resampling.average) as vrt:
                out[i] = vrt.read(1)
        print("  ", band, "ok")
    with rasterio.open(dest, "w", driver="GTiff", height=h, width=w, count=len(BANDS), dtype="uint16",
                       crs="EPSG:4326", transform=transform, compress="deflate", tiled=True) as ds:
        ds.write(out)
        ds.update_tags(scene=item["id"], date=p["datetime"][:10], cloud=str(p["eo:cloud_cover"]),
                       coverage=f"{cover:.3f}", bands=",".join(BANDS),
                       offset=str(0 if p.get("earthsearch:boa_offset_applied") else 1000))
    print("  wrote", dest.name, (h, w))


if __name__ == "__main__":
    for k in sys.argv[1:] or list(RESERVES):
        fetch(k)
