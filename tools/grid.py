#!/usr/bin/env python3
"""Turn a reserve boundary into cells of a fixed global grid and write out/<key>/cells.json.

The registry contract records claims per cell and per year, so two projects whose boundaries
overlap cannot both count the same ground. The grid is 0.01 degrees (about 1.1 km at this
latitude) and is anchored at 90 S, 180 W, so every project anywhere lands on the same cells:

    lat index  i = floor((lat + 90) / 0.01)        lon index  j = floor((lon + 180) / 0.01)

A cell belongs to a reserve when its centre is inside the boundary, so cells are never split.
On-chain the cells are packed 256 to a word: a row is (i, j >> 8, mask) with bit j & 255 set.

    python grid.py [reserve ...]
"""
from __future__ import annotations

import json
import sys

import numpy as np
import rasterio
import shapely

from analyse import GFC_LAST, RECENT, row_area_ha
from reserves import DEMO, OUT, RESERVES, boundary, data_dir

CELL_PER_DEG = 100             # 0.01 degree cells
RULE = "A cell belongs to the reserve when its centre lies inside the boundary polygon."


def cell_of(lat, lon):
    """Grid indices for points in degrees (arrays or scalars)."""
    i = np.floor(np.round((np.asarray(lat) + 90) * CELL_PER_DEG, 7)).astype("int64")
    j = np.floor(np.round((np.asarray(lon) + 180) * CELL_PER_DEG, 7)).astype("int64")
    return i, j


def centre(i, j):
    return (i + 0.5) / CELL_PER_DEG - 90, (j + 0.5) / CELL_PER_DEG - 180


def cells_of(geom) -> list[tuple[int, int]]:
    """Every (i, j) whose centre is inside the polygon, sorted."""
    w, s, e, n = geom.bounds
    (i0, i1), (j0, j1) = cell_of([s, n], [w, e])
    ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1), indexing="ij")
    lat, lon = centre(ii, jj)
    keep = shapely.contains_xy(geom, lon, lat)
    return sorted(zip(ii[keep].tolist(), jj[keep].tolist()))


def rows_of(cells) -> list[tuple[int, int, int]]:
    """Pack cells into (lat index, word, mask) rows, sorted the way the contract requires."""
    rows: dict[tuple[int, int], int] = {}
    for i, j in cells:
        rows[(i, j >> 8)] = rows.get((i, j >> 8), 0) | (1 << (j & 255))
    return [(i, w, m) for (i, w), m in sorted(rows.items())]


def loss_by_cell(key: str) -> dict[tuple[int, int], tuple[float, float, float]]:
    """Hectares, total loss and recent loss per cell from the Hansen loss-year raster."""
    d = data_dir(key)
    with rasterio.open(d / "gfc_lossyear.tif") as ds:
        ly = ds.read(1)
        area = row_area_ha(ds) * np.ones(ly.shape)
        lon = ds.transform.c + (np.arange(ds.width) + 0.5) * ds.transform.a
        lat = ds.transform.f + (np.arange(ds.height) + 0.5) * ds.transform.e
    i, _ = cell_of(lat, 0.0)
    _, j = cell_of(0.0, lon)
    code = (i[:, None] * 100_000 + j[None, :]).ravel()
    uniq, inv = np.unique(code, return_inverse=True)
    total = np.bincount(inv, area.ravel())
    loss = np.bincount(inv, (area * (ly > 0)).ravel())
    recent = np.bincount(inv, (area * (ly >= RECENT[0] - 2000)).ravel())
    return {(int(c // 100_000), int(c % 100_000)): (t, l, r) for c, t, l, r in zip(uniq, total, loss, recent)}


def build(key: str) -> dict:
    cells = cells_of(boundary(key))
    per = loss_by_cell(key)
    out_cells, ha = [], []
    for i, j in cells:
        t, l, r = per[(i, j)]
        ha.append(t)
        out_cells.append([i, j, round(100 * l / t, 1), round(100 * r / t, 1)])
    return {
        "key": key,
        "grid": {"cell_deg": 1 / CELL_PER_DEG, "origin_lat": -90, "origin_lon": -180, "rule": RULE},
        "cell_count": len(cells),
        "cell_ha_mean": round(float(np.mean(ha)), 1),
        "loss_years": [2001, GFC_LAST],
        "recent_years": [RECENT[0], RECENT[-1]],
        "rows": [[i, w, hex(m)] for i, w, m in rows_of(cells)],
        "cells_columns": ["lat_index", "lon_index", "loss_pct_of_cell", "recent_loss_pct_of_cell"],
        "cells": out_cells,
    }


if __name__ == "__main__":
    for k in sys.argv[1:] or [*RESERVES, *DEMO]:
        c = build(k)
        (OUT / k).mkdir(parents=True, exist_ok=True)
        (OUT / k / "cells.json").write_bytes(json.dumps(c, separators=(",", ":")).encode())
        print(k, c["cell_count"], "cells in", len(c["rows"]), "rows; mean cell", c["cell_ha_mean"], "ha")
