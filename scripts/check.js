// Compare the published files in web/data with what the registry holds.
//
//   node scripts/check.js            every area
//   node scripts/check.js omo        one area
//
// Reads the chain through web/deployment.json's rpcUrl, or KANOPY_RPC_URL if set. Exits 1 on
// any mismatch. This checks the published files against the chain; tools/verify.py checks that
// the published files are what the rasters and the code actually produce.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const lib = require("./lib");

const sha256 = (p) => "0x" + crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const listing = (entries) =>
  "0x" +
  crypto
    .createHash("sha256")
    .update([...entries].sort((a, b) => (a.name < b.name ? -1 : 1)).map((e) => `${e.sha256}  ${e.name}\n`).join(""))
    .digest("hex");

async function main() {
  const dep = lib.readJson(path.join(lib.WEB, "deployment.json"));
  const provider = new ethers.JsonRpcProvider(process.env.KANOPY_RPC_URL || dep.rpcUrl);
  const reg = new ethers.Contract(dep.address, dep.abi, provider);
  console.log(`registry ${dep.address} on ${dep.network} (chain ${dep.chainId})`);

  let bad = 0;
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : lib.keys();
  for (const key of keys) {
    const m = lib.manifest(key);
    const id = lib.reserveId(m);
    const r = await reg.reserves(id);
    if (r.cellCount === 0n) {
      console.log(`\n${m.reserve_id}: not registered`);
      bad++;
      continue;
    }
    const b = await reg.baseline(id, r.baselineCount);
    const dir = path.join(lib.WEB, "data", key);
    const rows = [
      ["boundary", lib.hash(m.hashes.boundary), r.boundaryHash],
      ["footprint", lib.footprintHash(lib.rows(key)), r.footprintHash],
      ["inputs", listing(m.inputs), b.inputsHash],
      ["code", listing(m.code), b.codeHash],
      ["result", sha256(path.join(dir, "stats.json")), b.resultHash],
    ];
    console.log(`\n${m.reserve_id}  ${m.name}  (baseline v${r.baselineCount}, ${r.cellCount} cells)`);
    for (const [name, mine, theirs] of rows) {
      const ok = mine === theirs;
      if (!ok) bad++;
      console.log(`  ${ok ? "match   " : "MISMATCH"}  ${name.padEnd(9)}  ${theirs}${ok ? "" : `  published ${mine}`}`);
    }
  }
  if (bad) {
    console.log(`\n${bad} mismatch(es)`);
    process.exitCode = 1;
  } else console.log("\nall published files match the chain");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
