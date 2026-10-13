// Shared by the tests and the deploy and check scripts: read the files tools/manifest.py wrote
// and turn them into the values the contract takes.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "web");
const YEAR = 2025; // the year the demonstration claim is made for

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const keys = () => readJson(path.join(WEB, "data", "index.json")).map((r) => r.key);
const manifest = (key) => readJson(path.join(WEB, "data", key, "manifest.json"));
const cells = (key) => readJson(path.join(WEB, "data", key, "cells.json"));

const reserveId = (m) => ethers.encodeBytes32String(m.reserve_id);
const hash = (hex) => "0x" + hex;
const rows = (key) => cells(key).rows.map(([lat, word, mask]) => ({ lat, word, mask: BigInt(mask) }));

// The same bytes the contract hashes in registerReserve.
const footprintHash = (rs) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["tuple(uint32 lat, uint16 word, uint256 mask)[]"], [rs]),
  );

const popcount = (x) => {
  let n = 0;
  for (; x; x &= x - 1n) n++;
  return n;
};

// Rows naming only the cells that two footprints share, or (keep = false) only those they do not.
function split(a, b, keep) {
  const other = new Map(b.map((r) => [`${r.lat}:${r.word}`, r.mask]));
  return a
    .map((r) => {
      const m = other.get(`${r.lat}:${r.word}`) ?? 0n;
      return { ...r, mask: keep ? r.mask & m : r.mask & ~m };
    })
    .filter((r) => r.mask !== 0n);
}

const attestArgs = (m, uri) => [
  reserveId(m),
  hash(m.hashes.inputs),
  hash(m.hashes.code),
  hash(m.hashes.result),
  m.headline.area_ha,
  m.headline.co2e_kt,
  m.headline.co2e_sd_kt,
  m.data_through_year,
  uri,
];

module.exports = { ROOT, WEB, YEAR, readJson, keys, manifest, cells, reserveId, hash, rows, footprintHash, popcount, split, attestArgs };
