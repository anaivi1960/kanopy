#!/usr/bin/env python3
"""Compute the Reserve Baseline numbers for each reserve and write out/<key>/stats.json.

Every figure in the baseline document comes from this file. Areas are computed
per pixel row from latitude, so nothing depends on an equal-area reprojection.

    python analyse.py [reserve ...]
"""
from __future__ import annotations

import json
import math
import sys

import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.warp import Resampling, reproject
from scipy.ndimage import distance_transform_edt

from reserves import BUFFER_DEG, OUT, RESERVES, boundary, config, data_dir

CANOPY_THRESHOLD = 30          # % tree cover in 2000 counted as "tree cover" (Hansen convention)
CARBON_FRACTION = 0.47         # IPCC default, tonnes carbon per tonne dry biomass
CO2_PER_C = 44 / 12
GFC_LAST = 2025
RECENT = range(2021, 2026)     # the "recent" window used for rates and the pressure map

TMF_CLASSES = {
    10: "Undisturbed moist forest", 20: "Degraded moist forest", 30: "Forest regrowth",
    41: "Deforested, now plantation", 42: "Deforested, now water", 43: "Deforested, other land",
    50: "Disturbance under way (2023-2025)", 60: "Water", 70: "Other land cover",
}
WC_CLASSES = {
    10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up",
    60: "Bare or sparse", 80: "Water", 90: "Herbaceous wetland", 95: "Mangrove",
}


def row_area_ha(ds) -> np.ndarray:
    """Hectares per pixel for each row of a lat/lon raster (column vector)."""
    rx, ry = abs(ds.transform.a), abs(ds.transform.e)
    lat = ds.transform.f - (np.arange(ds.height) + 0.5) * ry
    phi = np.radians(lat)
    m_lat = 111132.92 - 559.82 * np.cos(2 * phi) + 1.175 * np.cos(4 * phi)
    m_lon = 111412.84 * np.cos(phi) - 93.5 * np.cos(3 * phi)
    return (rx * m_lon * ry * m_lat / 10_000)[:, None]


def load(key: str, name: str, band: int = 1):
    ds = rasterio.open(data_dir(key) / f"{name}.tif")
    return ds, ds.read(band)


def masks(ds, geom):
    inside = geometry_mask([geom], (ds.height, ds.width), ds.transform, invert=True)
    ring = geometry_mask([geom.buffer(BUFFER_DEG)], (ds.height, ds.width), ds.transform, invert=True) & ~inside
    return inside, ring


def to_grid(src_arr, src_ds, dst_ds, resampling):
    out = np.zeros((dst_ds.height, dst_ds.width), "float32")
    reproject(src_arr.astype("float32"), out, src_transform=src_ds.transform, src_crs=src_ds.crs,
              dst_transform=dst_ds.transform, dst_crs=dst_ds.crs, resampling=resampling)
    return out


def r(x, n=0):
    return round(float(x), n) if n else int(round(float(x)))


def analyse(key: str) -> dict:
    cfg = config(key)
    geom = boundary(key)
    s: dict = {"key": key, "name": cfg["name"], "state": cfg["state"], "boundary_note": cfg["boundary_note"],
               "reported_ha": cfg["reported_ha"], "wdpa_id": cfg["wdpa_id"], "wdpa_desig": cfg["wdpa_desig"]}
    w, so, e, n = geom.bounds
    s["bounds"] = [round(v, 4) for v in (w, so, e, n)]
    s["centroid"] = [round(geom.centroid.y, 4), round(geom.centroid.x, 4)]

    # ── Hansen global forest change ────────────────────────────────────────
    ds, ly = load(key, "gfc_lossyear")
    _, tc = load(key, "gfc_treecover2000")
    area = row_area_ha(ds) * np.ones(ly.shape)
    inside, ring = masks(ds, geom)
    s["area_ha"] = r(area[inside].sum())
    s["ring_ha"] = r(area[ring].sum())
    cover = tc >= CANOPY_THRESHOLD

    def gfc(zone, sel, base):
        yearly = [float(area[zone & sel & (ly == y - 2000)].sum()) for y in range(2001, GFC_LAST + 1)]
        recent = sum(yearly[y - 2001] for y in RECENT)
        return {
            "base_ha": r(base), "base_pct_of_zone": r(100 * base / area[zone].sum(), 1),
            "loss_by_year_ha": [r(v) for v in yearly], "loss_total_ha": r(sum(yearly)),
            "loss_total_pct": r(100 * sum(yearly) / base, 1),
            "loss_recent_ha_per_yr": r(recent / len(RECENT)),
            "loss_recent_pct_per_yr": r(100 * recent / len(RECENT) / base, 2),
            "loss_mean_pct_per_yr": r(100 * sum(yearly) / (GFC_LAST - 2000) / base, 2),
        }

    # "canopy30" follows the usual convention: loss on pixels with at least 30% canopy in 2000,
    # as a share of that tree cover. "any" counts every loss pixel, as a share of the whole zone,
    # which is the only reading that works in open savanna woodland.
    everything = np.ones(ly.shape, bool)
    s["gfc"] = {"threshold_pct": CANOPY_THRESHOLD, "years": list(range(2001, GFC_LAST + 1))}
    for zone, name in ((inside, "inside"), (ring, "ring")):
        s["gfc"][name] = {
            "canopy30": gfc(zone, cover, max(area[zone & cover].sum(), 1e-9)),
            "any": gfc(zone, everything, area[zone].sum()),
            "mean_canopy2000_pct": r(tc[zone].mean(), 1),
            "canopy10_ha": r(area[zone & (tc >= 10)].sum()),
        }

    # Where recent loss sits relative to the boundary.
    recent_loss = inside & (ly >= RECENT[0] - 2000)
    px_m = math.sqrt(float(area[inside].mean()) * 10_000)
    dist_m = distance_transform_edt(inside) * px_m
    edge = {}
    for km in (1, 2, 5):
        band = inside & (dist_m <= km * 1000)
        edge[f"within_{km}km"] = {
            "area_pct": r(100 * area[band].sum() / area[inside].sum(), 1),
            "recent_loss_pct": r(100 * area[band & recent_loss].sum() / max(area[recent_loss].sum(), 1e-9), 1),
        }
    s["edge"] = edge
    gfc_ds, standing = ds, (cover & (ly == 0))

    # ── JRC tropical moist forest ──────────────────────────────────────────
    ds, tm = load(key, "tmf_TransitionMap_MainClasses")
    _, defy = load(key, "tmf_DeforestationYear")
    _, degy = load(key, "tmf_DegradationYear")
    area_t = row_area_ha(ds) * np.ones(tm.shape)
    in_t, ring_t = masks(ds, geom)
    tot = area_t[in_t].sum()
    classes = {str(c): {"label": lab, "ha": r(area_t[in_t & (tm == c)].sum()),
                        "pct": r(100 * area_t[in_t & (tm == c)].sum() / tot, 1)} for c, lab in TMF_CLASSES.items()}
    domain = sum(classes[str(c)]["ha"] for c in (10, 20, 30, 41, 42, 43, 50))
    years = list(range(1990, 2026))
    s["tmf"] = {
        "classes": classes, "moist_forest_domain_ha": r(domain), "moist_forest_domain_pct": r(100 * domain / tot, 1),
        "years": years,
        "deforestation_by_year_ha": [r(area_t[in_t & (defy == y)].sum()) for y in years],
        "degradation_by_year_ha": [r(area_t[in_t & (degy == y)].sum()) for y in years],
        "last_year": int(max(defy[in_t].max(), degy[in_t].max())),
    }
    for zone, name in ((in_t, "inside"), (ring_t, "ring")):
        zt = area_t[zone].sum()
        s["tmf"][f"undisturbed_pct_{name}"] = r(100 * area_t[zone & (tm == 10)].sum() / zt, 1)
        s["tmf"][f"standing_forest_pct_{name}"] = r(100 * area_t[zone & np.isin(tm, (10, 20, 30))].sum() / zt, 1)
    d = s["tmf"]["deforestation_by_year_ha"]
    s["tmf"]["deforestation_recent_ha_per_yr"] = r(sum(d[years.index(y)] for y in RECENT) / len(RECENT))
    s["tmf"]["deforestation_10yr_ha_per_yr"] = r(sum(d[years.index(y)] for y in range(2016, 2026)) / 10)
    tmf_ds = ds

    # ── ESA WorldCover 2021 ────────────────────────────────────────────────
    ds, wc = load(key, "worldcover2021")
    area_w = row_area_ha(ds)
    in_w, _ = masks(ds, geom)
    tot = float((area_w * in_w).sum())
    s["worldcover"] = {str(c): {"label": lab, "ha": r(float((area_w * (in_w & (wc == c))).sum())),
                                "pct": r(100 * float((area_w * (in_w & (wc == c))).sum()) / tot, 1)}
                       for c, lab in WC_CLASSES.items()}
    wc_ds = ds

    # ── ETH canopy height 2020 ─────────────────────────────────────────────
    ds, ch = load(key, "eth_canopy_height2020")
    in_h, _ = masks(ds, geom)
    v = ch[in_h & (ch != 255)].astype("float32")
    s["canopy_height"] = {
        "mean_m": r(v.mean(), 1), "median_m": r(np.median(v), 1), "p90_m": r(np.percentile(v, 90), 1),
        "pct_ge_5m": r(100 * (v >= 5).mean(), 1), "pct_ge_15m": r(100 * (v >= 15).mean(), 1),
        "pct_ge_25m": r(100 * (v >= 25).mean(), 1),
    }

    # ── ESA CCI biomass 2022 ───────────────────────────────────────────────
    ds, agb = load(key, "cci_agb2022")
    _, sd = load(key, "cci_agb2022_sd")
    agb, sd = agb.astype("float32"), sd.astype("float32")
    area_b = row_area_ha(ds) * np.ones(agb.shape)
    in_b, ring_b = masks(ds, geom)
    total = float((agb * area_b)[in_b].sum())
    total_sd = float((sd * area_b)[in_b].sum())   # treats pixel errors as fully correlated: an upper bound
    s["biomass"] = {
        "mean_t_per_ha": r(agb[in_b].mean(), 1), "ring_mean_t_per_ha": r(agb[ring_b].mean(), 1),
        "mean_sd_t_per_ha": r(sd[in_b].mean(), 1), "p90_t_per_ha": r(np.percentile(agb[in_b], 90), 1),
        "total_agb_mt": r(total / 1e6, 2), "total_agb_sd_mt": r(total_sd / 1e6, 2),
        "carbon_mtc": r(total * CARBON_FRACTION / 1e6, 2), "carbon_sd_mtc": r(total_sd * CARBON_FRACTION / 1e6, 2),
        "co2e_mt": r(total * CARBON_FRACTION * CO2_PER_C / 1e6, 1),
        "co2e_sd_mt": r(total_sd * CARBON_FRACTION * CO2_PER_C / 1e6, 1),
        "relative_sd_pct": r(100 * total_sd / total, 0),
    }

    # Biomass by land class: a 100 m biomass pixel counts when 80% of it is one class.
    strata = {}
    moist = s["tmf"]["moist_forest_domain_pct"] >= 20
    if moist:
        groups = {"Undisturbed moist forest": (tmf_ds, tm == 10), "Degraded moist forest": (tmf_ds, tm == 20),
                  "Forest regrowth": (tmf_ds, tm == 30), "Deforested": (tmf_ds, np.isin(tm, (41, 42, 43))),
                  "Other land cover": (tmf_ds, tm == 70)}
    else:
        groups = {WC_CLASSES[c]: (wc_ds, wc == c) for c in (10, 20, 30, 40, 90)}
    for label, (src, m) in groups.items():
        frac = to_grid(m, src, ds, Resampling.average)
        sel = in_b & (frac >= 0.8)
        if sel.sum() >= 30:
            strata[label] = {"pixels": int(sel.sum()), "mean_t_per_ha": r(agb[sel].mean(), 1),
                             "sd_between_pixels": r(agb[sel].std(), 1), "mean_map_sd": r(sd[sel].mean(), 1),
                             "co2e_t_per_ha": r(agb[sel].mean() * CARBON_FRACTION * CO2_PER_C, 0)}
    s["biomass"]["by_class"] = strata
    s["biomass"]["class_source"] = "JRC tropical moist forest classes" if moist else "ESA WorldCover 2021 classes"

    # ── Sentinel-2: NDVI by class ──────────────────────────────────────────
    ds = rasterio.open(data_dir(key) / "s2_recent.tif")
    tags = ds.tags()
    off = float(tags.get("offset", 0))
    red = (ds.read(1).astype("float32") - off) / 10000
    nir = (ds.read(4).astype("float32") - off) / 10000
    ndvi = np.where((nir + red) > 0, (nir - red) / (nir + red), np.nan)
    in_s, _ = masks(ds, geom)
    s["sentinel2"] = {"scene": tags.get("scene"), "date": tags.get("date"), "cloud_pct": float(tags.get("cloud", 0)),
                      "ndvi_mean": r(np.nanmean(ndvi[in_s]), 3)}
    by = {}
    for label, (src, m) in groups.items():
        frac = to_grid(m, src, ds, Resampling.average)
        sel = in_s & (frac >= 0.95) & np.isfinite(ndvi)
        if sel.sum() >= 200:
            q = np.percentile(ndvi[sel], [10, 50, 90])
            by[label] = {"pixels": int(sel.sum()), "p10": r(q[0], 3), "median": r(q[1], 3), "p90": r(q[2], 3)}
    s["sentinel2"]["ndvi_by_class"] = by

    # ── Indicative avoided-deforestation volume (not credit-grade) ─────────
    bc = s["biomass"]["by_class"]
    if moist and "Deforested" in bc and ("Degraded moist forest" in bc or "Undisturbed moist forest" in bc):
        forest = [bc[k]["mean_t_per_ha"] for k in ("Undisturbed moist forest", "Degraded moist forest") if k in bc]
        ef_lo = (min(forest) - bc["Deforested"]["mean_t_per_ha"]) * CARBON_FRACTION * CO2_PER_C
        ef_hi = (max(forest) - bc["Deforested"]["mean_t_per_ha"]) * CARBON_FRACTION * CO2_PER_C
        rate = sorted([s["tmf"]["deforestation_recent_ha_per_yr"], s["tmf"]["deforestation_10yr_ha_per_yr"]])
        gross = [rate[0] * ef_lo, rate[1] * ef_hi]
        credits = [gross[0] * (1 - 0.40) * 0.5, gross[1] * (1 - 0.30) * 0.7]
        s["indicative"] = {
            "baseline_ha_per_yr": rate, "emission_factor_tco2_per_ha": [r(ef_lo), r(ef_hi)],
            "gross_tco2_per_yr": [r(g) for g in gross], "credits_per_yr": [r(c) for c in credits],
            "revenue_usd_per_yr": [r(credits[0] * 5), r(credits[1] * 10)],
            "assumptions": "Above-ground biomass only. Deductions of 30-40% for buffer, leakage and uncertainty; "
                           "50-70% effectiveness; $5-10 per credit. Baseline taken from the reserve's own history, "
                           "which a carbon standard would not accept as is.",
        }
    return s


if __name__ == "__main__":
    for k in sys.argv[1:] or list(RESERVES):
        st = analyse(k)
        (OUT / k).mkdir(parents=True, exist_ok=True)
        # Bytes, not text: the file is hashed, and text mode would write CRLF on Windows only.
        (OUT / k / "stats.json").write_bytes(json.dumps(st, indent=1).encode())
        print(json.dumps({a: st[a] for a in st if a not in ("boundary_note",)}, indent=None)[:6000])
        print()
