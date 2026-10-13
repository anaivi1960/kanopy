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

  // KANOPY_RESUME=<registry address> picks up a run that stopped part way: steps already on the
  // chain are skipped, so a dropped connection never means paying for a second registry.
  let reg, deployed = null;
  if (process.env.KANOPY_RESUME && !local) {
    reg = await ethers.getContractAt("KanopyRegistry", process.env.KANOPY_RESUME, deployer);
    console.log(`resuming KanopyRegistry at ${process.env.KANOPY_RESUME} on ${hre.network.name}`);
  } else {
    reg = await (await ethers.getContractFactory("KanopyRegistry", deployer)).deploy();
    deployed = await reg.deploymentTransaction().wait();
    console.log(`KanopyRegistry at ${await reg.getAddress()} on ${hre.network.name}`);
  }
  const address = await reg.getAddress();
  if (!(await reg.isAttester(deployer.address))) await sent(reg.setAttester(deployer.address, true));

  const txs = { deploy: deployed && deployed.hash, attest: {}, register: {} };
  for (const key of lib.keys()) {
    const m = lib.manifest(key), id = lib.reserveId(m);
    const who = m.synthetic ? TEST_STEWARD : steward.address;
    let onChain = await reg.reserves(id);
    if (onChain.cellCount === 0n) {
      txs.register[key] = (await sent(reg.registerReserve(id, m.name, who, lib.hash(m.hashes.boundary), lib.rows(key)))).hash;
      onChain = await reg.reserves(id);
    }
    if (onChain.baselineCount === 0n) {
      txs.attest[key] = (await sent(reg.attest(...lib.attestArgs(m, `${baseUri}data/${key}/manifest.json`)))).hash;
    }
    console.log(`  ${m.reserve_id}: ${m.cell_count} cells registered, baseline v1 attested`);
  }

  const omo = lib.manifest("omo");
  if ((await reg.claimCount()) === 0n) {
    // On a testnet only the deployer needs funding: it passes the steward enough for its one
    // claim. Wallets reserve gas limit x maximum fee up front, which is far more than is spent.
    const float = ethers.parseEther(process.env.KANOPY_STEWARD_FUND || "0.015");
    if (steward.address !== deployer.address && (await ethers.provider.getBalance(steward.address)) < float) {
      await sent(deployer.sendTransaction({ to: steward.address, value: float }));
    }
    txs.claim = (await sent(reg.connect(steward).claim(lib.reserveId(omo), lib.YEAR, 1, lib.rows("omo")))).hash;
  }
  console.log(`  ${omo.reserve_id}: all cells claimed for ${lib.YEAR}`);

  const artifact = await hre.artifacts.readArtifact("KanopyRegistry");
  const out = {
    network: process.env.KANOPY_NETWORK_NAME || hre.network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    address,
    rpcUrl,
    explorer: local ? null : process.env.KANOPY_EXPLORER_URL || null,
    deployedAtBlock: deployed && deployed.blockNumber,
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
