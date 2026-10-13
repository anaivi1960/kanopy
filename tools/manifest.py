#!/usr/bin/env python3
"""Fingerprint one baseline and write out/<key>/manifest.json, then copy what the verifier page
needs into web/data/<key>/.

Four SHA-256 hashes go on-chain. Each is over bytes anyone can reproduce:

    boundary   the boundary file as stored
    inputs     a listing "sha256  name" of every clipped raster the analysis reads
    code       the same listing for the scripts that turn rasters into numbers
    result     out/<key>/stats.json as written by analyse.py

    python manifest.py [reserve ...]
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys

import rasterio

from analyse import GFC_LAST
from reserves import DEMO, OUT, RESERVES, ROOT, boundary_path, config, data_dir

WEB = ROOT / "web" / "data"
CODE = ["analyse.py", "reserves.py", "grid.py"]

# name -> (what it is, where it came from). See fetch.py and s2.py for the exact URLs.
INPUTS = {
    "gfc_lossyear.tif": ("Tree cover loss year", "Hansen Global Forest Change 2025 v1.13"),
    "gfc_treecover2000.tif": ("Tree canopy cover in 2000", "Hansen Global Forest Change 2025 v1.13"),
    "tmf_TransitionMap_MainClasses.tif": ("Moist forest condition classes", "JRC Tropical Moist Forest v1, through 2025"),
    "tmf_DeforestationYear.tif": ("Moist forest deforestation year", "JRC Tropical Moist Forest v1, through 2025"),
    "tmf_DegradationYear.tif": ("Moist forest degradation year", "JRC Tropical Moist Forest v1, through 2025"),
    "worldcover2021.tif": ("Land cover", "ESA WorldCover 10 m 2021 v200"),
    "eth_canopy_height2020.tif": ("Canopy height", "ETH Global Canopy Height 10 m 2020"),
    "cci_agb2022.tif": ("Above-ground biomass", "ESA CCI Biomass v6.0, 2022"),
    "cci_agb2022_sd.tif": ("Above-ground biomass standard deviation", "ESA CCI Biomass v6.0, 2022"),
    "s2_recent.tif": ("Recent optical scene", "Copernicus Sentinel-2 L2A"),
}


def sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def listing(entries: list[dict]) -> str:
    """The text whose hash goes on-chain: one "sha256  name" line per file, sorted by name."""
    return "".join(f"{e['sha256']}  {e['name']}\n" for e in sorted(entries, key=lambda e: e["name"]))


def hash_listing(entries: list[dict]) -> str:
    return hashlib.sha256(listing(entries).encode()).hexdigest()


def reserve_id(key: str) -> str:
    cfg = config(key)
    return f"wdpa-{cfg['wdpa_id']}" if cfg["wdpa_id"] else f"kanopy-test-{key}"


def inputs(key: str) -> list[dict]:
    out = []
    for name, (what, source) in INPUTS.items():
        p = data_dir(key) / name
        e = {"name": name, "what": what, "source": source, "bytes": p.stat().st_size, "sha256": sha256(p)}
        if name == "s2_recent.tif":
            with rasterio.open(p) as ds:
                e["source"] += f", scene {ds.tags().get('scene')}"
        out.append(e)
    return out


def code() -> list[dict]:
    here = ROOT / "tools"
    return [{"name": f"tools/{n}", "bytes": (here / n).stat().st_size, "sha256": sha256(here / n)} for n in CODE]


def build(key: str) -> dict:
    cfg = config(key)
    stats = json.loads((OUT / key / "stats.json").read_text())
    cells = json.loads((OUT / key / "cells.json").read_text())
    ins, src = inputs(key), code()
    return {
        "key": key,
        "reserve_id": reserve_id(key),
        "name": cfg["name"],
        "state": cfg["state"],
        "synthetic": key in DEMO,
        "boundary_note": cfg["boundary_note"],
        "data_through_year": GFC_LAST,
        "headline": {
            "area_ha": stats["area_ha"],
            "co2e_kt": round(stats["biomass"]["co2e_mt"] * 1000),
            "co2e_sd_kt": round(stats["biomass"]["co2e_sd_mt"] * 1000),
        },
        "cell_count": cells["cell_count"],
        "hashes": {
            "boundary": sha256(boundary_path(key)),
            "inputs": hash_listing(ins),
            "code": hash_listing(src),
            "result": sha256(OUT / key / "stats.json"),
            "cells_file": sha256(OUT / key / "cells.json"),
        },
        "boundary_file": boundary_path(key).name,
        "inputs": ins,
        "code": src,
    }


if __name__ == "__main__":
    keys = sys.argv[1:] or [*RESERVES, *DEMO]
    for k in keys:
        m = build(k)
        (OUT / k / "manifest.json").write_bytes(json.dumps(m, indent=1).encode())
        (WEB / k).mkdir(parents=True, exist_ok=True)
        for name in ("stats.json", "cells.json", "manifest.json"):
            shutil.copyfile(OUT / k / name, WEB / k / name)
        print(k, m["reserve_id"], "result", m["hashes"]["result"][:16], "inputs", m["hashes"]["inputs"][:16])
    index = [{"key": k, "name": config(k)["name"], "synthetic": k in DEMO} for k in [*RESERVES, *DEMO]]
    (WEB / "index.json").write_bytes(json.dumps(index, indent=1).encode())
