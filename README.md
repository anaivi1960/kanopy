# Kanopy

Kanopy measures how much forest a reserve holds and how fast it is being lost, from open satellite
data, and records a fingerprint of each measurement in a public registry so anyone can recompute
and check it. The same registry lets a project count a piece of ground for a year only once.

Built by Kam Edge for the IEEE ClimateChain Global Hackathon, track **Climate Data &
Environmental Monitoring**.

## Live

- Verifier page: https://kamhq.com/kanopy/verify/
- Registry on Ethereum Sepolia: [`0x21166Dd8970adFF801effE70232c1cB6e8C3Fd17`](https://sepolia.etherscan.io/address/0x21166Dd8970adFF801effE70232c1cB6e8C3Fd17)

`web/deployment.json` names the registry the page reads. `scripts/deploy.js` rewrites it, so
deploying to a local chain as described below points your copy of the page at that chain instead.

## What is here

| Part | Where | What it does |
|---|---|---|
| Measurement | `tools/fetch.py`, `s2.py`, `analyse.py` | Clips public rasters to a boundary and writes `out/<area>/stats.json` |
| Grid | `tools/grid.py` | Turns the boundary into cells of a fixed global 0.01 degree grid |
| Fingerprints | `tools/manifest.py` | SHA-256 of the boundary, the rasters, the scripts and the result |
| Registry | `contracts/KanopyRegistry.sol` | Holds the fingerprints and one claim per cell per year |
| Verifier page | `web/` | Recomputes the fingerprints in the browser and compares them with the registry |
| Full recheck | `tools/verify.py` | Reruns the analysis from the rasters and compares everything |

Three areas are measured: Omo Forest Reserve (Ogun), Pandam Wildlife Park (Plateau), and a
synthetic rectangle across Omo's north-east edge that exists only to test the double-claim check.

## Run it

    npm install
    npx hardhat test                                         # 15 contract tests on the real footprints
    npx hardhat node                                         # a local chain, in its own terminal
    npx hardhat run scripts/deploy.js --network localhost    # deploy, register, attest, claim
    python -m http.server 8000 --directory web               # then open http://localhost:8000

To recheck a baseline from the rasters (Python 3.11 or later with `numpy scipy rasterio shapely`):

    python tools/verify.py omo

It hashes the boundary, the ten input rasters and the three scripts, reruns the analysis and the
grid in memory, compares all five fingerprints with the published ones, and then asks the chain.

To rebuild everything from the public sources, see the header of each script in `tools/`:
`fetch.py`, `s2.py`, `analyse.py`, `grid.py`, `manifest.py`, in that order.

## How the registry works

**Attestation.** For each measurement the contract stores four hashes (boundary, inputs, code,
result), the area, and the carbon stock with its uncertainty. Versions are append-only: a new
measurement becomes the next version and earlier ones stay readable. Only an approved attester
can write one.

**Claims.** The world is cut into 0.01 degree cells anchored at 90 S, 180 W, so every project
lands on the same cells. A cell belongs to an area when its centre is inside the boundary. A claim
names a set of cells, a year, and the baseline version it relies on. The contract refuses a claim
if any cell is outside the area's registered footprint or is already counted for that year. Cells
are packed 256 to a storage word, so the whole of Omo (1,083 cells) is claimed in one transaction.

**What the page checks.** It hashes `stats.json` and the cell rows itself, hashes the published
lists of raster and script fingerprints, and compares each with the registry. "Alter one figure"
changes two numbers in the browser's copy to show the mismatch. "Simulate the claim" makes a
read-only call to the live contract from the steward's address and shows whether it would pass.

## Limits

- This is not a carbon credit and the registry issues nothing. The avoided-deforestation range in
  `stats.json` is indicative and is labelled that way where it is computed.
- The carbon stock is above-ground biomass from a global map. Its uncertainty is the map's own
  and is large: for Omo, 17.7 ± 11.1 Mt CO2e. No field plots have been taken.
- A matching fingerprint proves the record has not changed. It does not prove the satellite
  products are right.
- The models are upstream: tree-cover change, canopy height and biomass are other groups'
  published products. Kanopy adds no model of its own.
- The claims in the demonstration are made with test keys, not by the reserves' authorities.
- A registry owner approves attesters and names stewards. Who should hold that role is a
  governance question this prototype does not answer.

## Data sources

Hansen Global Forest Change 2025 v1.13 · JRC Tropical Moist Forest v1 · ESA WorldCover 2021 v200 ·
ETH Global Canopy Height 2020 · ESA CCI Biomass v6.0 (2022) · Copernicus Sentinel-2 L2A.
Boundaries are from the World Database on Protected Areas (UNEP-WCMC) by site id and are not
redistributed here; the registry holds their hash.

The JRC tiles do not allow range requests. Download each 10-degree tile whole into `data/tmf/`
with `curl -4` from
`https://ies-ows.jrc.ec.europa.eu/iforce/tmf_v1/download.py?type=tile&dataset=<name>&lat=N10&lon=E0`
for `DeforestationYear`, `DegradationYear` and `TransitionMap_MainClasses` before running `fetch.py`.

## Licence

No licence has been chosen yet. Until one is, the code is published for review and all rights are reserved.
