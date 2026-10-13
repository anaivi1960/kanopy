// The tests run on the real footprints and manifests in web/data, so they also check that the
// published files and the contract agree about what a row and a hash are.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const lib = require("../scripts/lib");

describe("KanopyRegistry", function () {
  let reg, owner, attester, omoSteward, otherSteward, stranger;
  const omo = lib.manifest("omo"), overlap = lib.manifest("overlap"), pandam = lib.manifest("pandam");
  const omoRows = lib.rows("omo"), overlapRows = lib.rows("overlap");
  const shared = lib.split(overlapRows, omoRows, true), free = lib.split(overlapRows, omoRows, false);
  const count = (rs) => rs.reduce((n, r) => n + lib.popcount(r.mask), 0);
  const firstCell = (r) => {
    let b = 0;
    while (!((r.mask >> BigInt(b)) & 1n)) b++;
    return [r.lat, r.word * 256 + b];
  };

  beforeEach(async function () {
    [owner, attester, omoSteward, otherSteward, stranger] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("KanopyRegistry")).deploy();
    await reg.setAttester(attester.address, true);
    await reg.registerReserve(lib.reserveId(omo), omo.name, omoSteward.address, lib.hash(omo.hashes.boundary), omoRows);
    await reg.registerReserve(lib.reserveId(overlap), overlap.name, otherSteward.address, lib.hash(overlap.hashes.boundary), overlapRows);
    await reg.connect(attester).attest(...lib.attestArgs(omo, "omo.json"));
    await reg.connect(attester).attest(...lib.attestArgs(overlap, "overlap.json"));
  });

  describe("reserves", function () {
    it("stores the footprint and commits to it with the hash the page recomputes", async function () {
      const r = await reg.reserves(lib.reserveId(omo));
      expect(r.cellCount).to.equal(omo.cell_count).and.to.equal(count(omoRows));
      expect(r.footprintHash).to.equal(lib.footprintHash(omoRows));
      expect(r.boundaryHash).to.equal(lib.hash(omo.hashes.boundary));
      const first = omoRows[0];
      expect(await reg.footprintWord(lib.reserveId(omo), first.lat, first.word)).to.equal(first.mask);
      expect(await reg.reserveCount()).to.equal(2);
    });

    it("lets only the owner register, and only once per id", async function () {
      const args = [lib.reserveId(pandam), pandam.name, stranger.address, lib.hash(pandam.hashes.boundary), lib.rows("pandam")];
      await expect(reg.connect(stranger).registerReserve(...args)).to.be.revertedWithCustomError(reg, "NotOwner");
      await reg.registerReserve(...args);
      await expect(reg.registerReserve(...args)).to.be.revertedWithCustomError(reg, "ReserveExists");
    });

    it("rejects rows that are empty, out of order, repeated or blank", async function () {
      const id = lib.reserveId(pandam), h = lib.hash(pandam.hashes.boundary), [a, b] = lib.rows("pandam");
      for (const bad of [[], [b, a], [a, a], [{ ...a, mask: 0n }]]) {
        await expect(reg.registerReserve(id, "x", stranger.address, h, bad)).to.be.revertedWithCustomError(reg, "BadRows");
      }
    });
  });

  describe("attestations", function () {
    it("records the fingerprints and the headline figures with their uncertainty", async function () {
      const b = await reg.baseline(lib.reserveId(omo), 1);
      expect(b.inputsHash).to.equal(lib.hash(omo.hashes.inputs));
      expect(b.codeHash).to.equal(lib.hash(omo.hashes.code));
      expect(b.resultHash).to.equal(lib.hash(omo.hashes.result));
      expect(b.areaHa).to.equal(omo.headline.area_ha);
      expect(b.co2eKt).to.equal(omo.headline.co2e_kt);
      expect(b.co2eSdKt).to.equal(omo.headline.co2e_sd_kt);
      expect(b.attester).to.equal(attester.address);
    });

    it("is append-only: a second measurement becomes version 2 and version 1 stays", async function () {
      const args = lib.attestArgs(omo, "v2.json");
      args[3] = ethers.id("a different result");
      await expect(reg.connect(attester).attest(...args))
        .to.emit(reg, "BaselineAttested")
        .withArgs(lib.reserveId(omo), 2, args[3], attester.address);
      expect((await reg.baseline(lib.reserveId(omo), 1)).resultHash).to.equal(lib.hash(omo.hashes.result));
      expect((await reg.baseline(lib.reserveId(omo), 2)).resultHash).to.equal(args[3]);
      await expect(reg.baseline(lib.reserveId(omo), 3)).to.be.revertedWithCustomError(reg, "UnknownBaseline");
    });

    it("refuses anyone who is not an approved attester, and unknown reserves", async function () {
      await expect(reg.connect(stranger).attest(...lib.attestArgs(omo, ""))).to.be.revertedWithCustomError(reg, "NotAttester");
      await expect(reg.connect(attester).attest(...lib.attestArgs(pandam, ""))).to.be.revertedWithCustomError(reg, "UnknownReserve");
      await reg.setAttester(attester.address, false);
      await expect(reg.connect(attester).attest(...lib.attestArgs(omo, ""))).to.be.revertedWithCustomError(reg, "NotAttester");
    });
  });

  describe("claims", function () {
    it("lets the steward count the whole reserve for a year", async function () {
      await expect(reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 1, omoRows)).to.emit(reg, "Claimed");
      const c = await reg.getClaim(0);
      expect(c.cellCount).to.equal(omo.cell_count);
      expect(c.claimant).to.equal(omoSteward.address);
      const [lat, lon] = lib.cells("omo").cells[0];
      expect(await reg.isClaimed(lib.YEAR, lat, lon)).to.equal(true);
      expect(await reg.isClaimed(lib.YEAR - 1, lat, lon)).to.equal(false);
    });

    it("refuses the same cells a second time in the same year", async function () {
      await reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 1, omoRows);
      await expect(reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 1, omoRows)).to.be.revertedWithCustomError(reg, "CellsAlreadyClaimed");
    });

    it("refuses an overlapping project, and says which cells are taken", async function () {
      expect(count(shared)).to.be.greaterThan(0);
      expect(await reg.conflicts(lib.YEAR, overlapRows)).to.equal(0);
      await reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 1, omoRows);
      expect(await reg.conflicts(lib.YEAR, overlapRows)).to.equal(count(shared));
      const masks = await reg.claimedMasks(lib.YEAR, overlapRows);
      expect(masks.reduce((n, m) => n + lib.popcount(m), 0)).to.equal(count(shared));
      const first = shared[0];
      await expect(reg.connect(otherSteward).claim(lib.reserveId(overlap), lib.YEAR, 1, overlapRows))
        .to.be.revertedWithCustomError(reg, "CellsAlreadyClaimed")
        .withArgs(lib.YEAR, first.lat, first.word, first.mask);
      expect(await reg.claimCount()).to.equal(1);
    });

    it("still lets the overlapping project count the ground nobody else has, or another year", async function () {
      await reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 1, omoRows);
      await reg.connect(otherSteward).claim(lib.reserveId(overlap), lib.YEAR, 1, free);
      expect((await reg.getClaim(1)).cellCount).to.equal(overlap.cell_count - count(shared));
      await reg.connect(otherSteward).claim(lib.reserveId(overlap), lib.YEAR - 1, 1, overlapRows);
      expect(await reg.claimCount()).to.equal(3);
    });

    it("gives the cells to whoever claims first, whichever project that is", async function () {
      await reg.connect(otherSteward).claim(lib.reserveId(overlap), lib.YEAR, 1, overlapRows);
      await expect(reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 1, omoRows)).to.be.revertedWithCustomError(reg, "CellsAlreadyClaimed");
    });

    it("refuses cells outside the reserve's own footprint", async function () {
      await expect(reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 1, free)).to.be.revertedWithCustomError(reg, "OutsideFootprint");
    });

    it("refuses a claimant who is not the steward, and a baseline that does not exist", async function () {
      await expect(reg.connect(stranger).claim(lib.reserveId(omo), lib.YEAR, 1, omoRows)).to.be.revertedWithCustomError(reg, "NotSteward");
      await expect(reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 2, omoRows)).to.be.revertedWithCustomError(reg, "UnknownBaseline");
      await expect(reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 0, omoRows)).to.be.revertedWithCustomError(reg, "UnknownBaseline");
      await expect(reg.connect(omoSteward).claim(lib.reserveId(pandam), lib.YEAR, 1, omoRows)).to.be.revertedWithCustomError(reg, "UnknownReserve");
    });

    it("leaves nothing behind when a claim fails part way through", async function () {
      // The overlap area's rows run free, free, ..., shared: the loop writes some cells before it
      // meets a taken one, and the revert must undo them.
      await reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 1, omoRows);
      await expect(reg.connect(otherSteward).claim(lib.reserveId(overlap), lib.YEAR, 1, overlapRows)).to.be.reverted;
      for (const r of free) {
        const [lat, lon] = firstCell(r);
        expect(await reg.isClaimed(lib.YEAR, lat, lon)).to.equal(false);
      }
    });

    it("fits the whole reserve in one transaction", async function () {
      const tx = await reg.connect(omoSteward).claim(lib.reserveId(omo), lib.YEAR, 1, omoRows);
      const gas = (await tx.wait()).gasUsed;
      console.log(`        claim of ${omo.cell_count} cells in ${omoRows.length} rows: ${gas} gas`);
      expect(gas).to.be.lessThan(5_000_000n);
    });
  });
});
