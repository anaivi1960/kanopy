// Deploy the registry, register every area in web/data, attest its baseline, make the
// demonstration claim for Omo, and write web/deployment.json for the verifier page.
//
//   npx hardhat node                                   (in another terminal)
//   npx hardhat run scripts/deploy.js --network localhost
//
// For a public testnet set KANOPY_RPC_URL and KANOPY_DEPLOYER_KEY (see hardhat.config.js), plus:
//   KANOPY_PUBLIC_RPC_URL  a keyless endpoint the page can read from (never one with an API key)
//   KANOPY_EXPLORER_URL    the block explorer's base address, for links
//   KANOPY_BASE_URI        where the web folder will be served, so on-chain records point at it
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const lib = require("./lib");

const { ethers } = hre;

// Steward of the synthetic overlap area. It is derived from a sentence, so nobody holds its key:
// its claim can be simulated against the chain but can never be sent.
const TEST_STEWARD = ethers.getAddress(ethers.dataSlice(ethers.id("Kanopy overlap test steward: no key exists"), 12));

async function main() {
  const local = hre.network.name === "localhost" || hre.network.name === "hardhat";
  const rpcUrl = local ? "http://127.0.0.1:8545" : process.env.KANOPY_PUBLIC_RPC_URL;
  if (!rpcUrl) throw new Error("Set KANOPY_PUBLIC_RPC_URL to a keyless endpoint the page can read from.");
  const baseUri = local ? "" : process.env.KANOPY_BASE_URI || "";

  const [deployer, second] = await ethers.getSigners();
  const steward = second ?? deployer;
  const sent = async (tx) => (await tx).wait();

  // On a testnet only the deployer needs funding: it passes the steward enough for its one claim.
  const float = ethers.parseEther(process.env.KANOPY_STEWARD_FUND || "0.0005");
  if (steward.address !== deployer.address && (await ethers.provider.getBalance(steward.address)) < float) {
    await sent(deployer.sendTransaction({ to: steward.address, value: float }));
  }

  const reg = await (await ethers.getContractFactory("KanopyRegistry", deployer)).deploy();
  const deployed = await reg.deploymentTransaction().wait();
  const address = await reg.getAddress();
  console.log(`KanopyRegistry at ${address} on ${hre.network.name}`);
  await sent(reg.setAttester(deployer.address, true));

  const txs = { deploy: deployed.hash, attest: {}, register: {} };
  let gas = deployed.gasUsed;
  for (const key of lib.keys()) {
    const m = lib.manifest(key);
    const who = m.synthetic ? TEST_STEWARD : steward.address;
    const r = await sent(reg.registerReserve(lib.reserveId(m), m.name, who, lib.hash(m.hashes.boundary), lib.rows(key)));
    const a = await sent(reg.attest(...lib.attestArgs(m, `${baseUri}data/${key}/manifest.json`)));
    txs.register[key] = r.hash;
    txs.attest[key] = a.hash;
    gas += r.gasUsed + a.gasUsed;
    console.log(`  ${m.reserve_id}: ${m.cell_count} cells registered, baseline v1 attested`);
  }

  const omo = lib.manifest("omo");
  const c = await sent(reg.connect(steward).claim(lib.reserveId(omo), lib.YEAR, 1, lib.rows("omo")));
  txs.claim = c.hash;
  gas += c.gasUsed;
  console.log(`  ${omo.reserve_id}: all cells claimed for ${lib.YEAR}`);
  console.log(`  total gas ${gas}`);

  const artifact = await hre.artifacts.readArtifact("KanopyRegistry");
  const out = {
    network: hre.network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    address,
    rpcUrl,
    explorer: local ? null : process.env.KANOPY_EXPLORER_URL || null,
    deployedAtBlock: deployed.blockNumber,
    attester: deployer.address,
    steward: steward.address,
    testSteward: TEST_STEWARD,
    year: lib.YEAR,
    txs,
    abi: artifact.abi,
  };
  fs.writeFileSync(path.join(lib.WEB, "deployment.json"), JSON.stringify(out, null, 1) + "\n");
  console.log("wrote web/deployment.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
