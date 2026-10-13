#!/usr/bin/env python3
"""Clip the public rasters a Reserve Baseline needs to each reserve's bounding box.

Reads windows straight from the remote files, so only the reserve's pixels are
transferred. The JRC tropical forest tiles do not support range requests; they
are downloaded whole into data/tmf/ (see the README) and clipped from disk.

    python fetch.py            all reserves
    python fetch.py omo        one reserve
"""
from __future__ import annotations

import math
import os
import sys
import time

import rasterio
from rasterio.merge import merge

from reserves import DATA, RESERVES, bbox

os.environ.update(
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    GDAL_HTTP_TIMEOUT="90",
    GDAL_HTTP_MAX_RETRY="4",
    GDAL_HTTP_RETRY_DELAY="3",
)

GFC = "https://storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13/Hansen_GFC-2025-v1.13_{layer}_{tile}.tif"
WORLDCOVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
CCI = "https://dap.ceda.ac.uk/neodc/esacci/biomass/data/agb/maps/v6.0/geotiff/2022/{tile}_ESACCI-BIOMASS-L4-{var}-MERGED-100m-2022-fv6.0.tif"
ETH = "https://libdrive.ethz.ch/index.php/s/cO8or7iOe5dT2Rt/download?path=%2F3deg_cogs&files=ETH_GlobalCanopyHeight_10m_2020_{tile}_Map.tif"


def tiles_10deg(b) -> list[str]:
    """Hansen / CCI tiles, named by their top-left corner."""
    w, s, e, n = b
    out = []
    for lat in range(math.floor(s / 10) * 10 + 10, math.floor(n / 10) * 10 + 11, 10):
        for lon in range(math.floor(w / 10) * 10, math.floor(e / 10) * 10 + 1, 10):
            out.append((lat, lon))
    return out


def tiles_3deg(b) -> list[str]:
    """WorldCover / ETH tiles, named by their bottom-left corner."""
    w, s, e, n = b
    out = []
    for lat in range(math.floor(s / 3) * 3, math.floor(n / 3) * 3 + 1, 3):
        for lon in range(math.floor(w / 3) * 3, math.floor(e / 3) * 3 + 1, 3):
            out.append(f"N{lat:02d}E{lon:03d}")
    return out


def clip(urls: list[str], b, dest, local: bool = False) -> None:
    if dest.exists():
        print(f"  have {dest.name}")
        return
    t = time.time()
    srcs = [rasterio.open(u if local else "/vsicurl/" + u) for u in urls]
    arr, transform = merge(srcs, bounds=b)
    profile = srcs[0].profile.copy()
    profile.update(
        driver="GTiff", height=arr.shape[1], width=arr.shape[2], transform=transform,
        compress="deflate", tiled=True, blockxsize=256, blockysize=256,
    )
    for s in srcs:
        s.close()
    with rasterio.open(dest, "w", **profile) as out:
        out.write(arr)
    print(f"  wrote {dest.name} {arr.shape[1:]} in {time.time() - t:.0f}s")


def fetch(key: str) -> None:
    b = bbox(key)
    d = DATA / key
    d.mkdir(parents=True, exist_ok=True)
    print(key, [round(v, 3) for v in b])

    t10 = tiles_10deg(b)
    gfc_tiles = [f"{lat:02d}N_{lon:03d}E" for lat, lon in t10]
    for layer in ("lossyear", "treecover2000", "gain"):
        clip([GFC.format(layer=layer, tile=t) for t in gfc_tiles], b, d / f"gfc_{layer}.tif")

    t3 = tiles_3deg(b)
    clip([WORLDCOVER.format(tile=t) for t in t3], b, d / "worldcover2021.tif")
    clip([ETH.format(tile=t) for t in t3], b, d / "eth_canopy_height2020.tif")

    cci_tiles = [f"N{lat:02d}E{lon:03d}" for lat, lon in t10]
    for var, name in (("AGB", "cci_agb2022.tif"), ("AGB_SD", "cci_agb2022_sd.tif")):
        clip([CCI.format(tile=t, var=var) for t in cci_tiles], b, d / name)

    for ds in ("DeforestationYear", "DegradationYear", "TransitionMap_MainClasses"):
        srcs = [DATA / "tmf" / f"{ds}.N{lat}_E{lon}.tif" for lat, lon in t10]
        if all(p.exists() for p in srcs):
            clip([str(p) for p in srcs], b, d / f"tmf_{ds}.tif", local=True)
        else:
            print(f"  skip tmf_{ds}: tile not downloaded yet")


if __name__ == "__main__":
    for k in sys.argv[1:] or list(RESERVES):
        fetch(k)
