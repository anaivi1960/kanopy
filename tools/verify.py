#!/usr/bin/env python3
"""Recompute a baseline from the rasters and compare it with the published fingerprints.

This is the check a third party runs. It hashes the boundary, the input rasters and the code on
disk, runs the analysis and the grid again in memory, and compares all of it with
web/data/<key>/manifest.json. If web/deployment.json exists it then asks the chain the same
question through scripts/check.js.

    python verify.py [reserve ...]        exits 1 on any mismatch
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys

import grid
import manifest
from analyse import analyse
from reserves import DEMO, RESERVES, ROOT, boundary_path

WEB = ROOT / "web"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify(key: str) -> bool:
    published = json.loads((WEB / "data" / key / "manifest.json").read_text())["hashes"]
    recomputed = {
        "boundary": manifest.sha256(boundary_path(key)),
        "inputs": manifest.hash_listing(manifest.inputs(key)),
        "code": manifest.hash_listing(manifest.code()),
        "result": digest(json.dumps(analyse(key), indent=1).encode()),
        "cells_file": digest(json.dumps(grid.build(key), separators=(",", ":")).encode()),
    }
    ok = True
    print(f"{manifest.reserve_id(key)}  recomputed from rasters")
    for name, mine in recomputed.items():
        same = mine == published[name]
        ok &= same
        print(f"  {'match   ' if same else 'MISMATCH'}  {name:<10}  {mine}" + ("" if same else f"  published {published[name]}"))
    return ok


if __name__ == "__main__":
    keys = sys.argv[1:] or [*RESERVES, *DEMO]
    good = all([verify(k) for k in keys])
    print("\nrecomputed files match the published ones" if good else "\nrecomputed files DIFFER from the published ones")
    node = shutil.which("node")
    if node and (WEB / "deployment.json").exists():
        print()
        good &= subprocess.run([node, str(ROOT / "scripts" / "check.js"), *keys], cwd=ROOT).returncode == 0
    else:
        print("\nchain not checked: needs node and web/deployment.json")
    sys.exit(0 if good else 1)
