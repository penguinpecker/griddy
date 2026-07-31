import { expect } from "chai";
import { ethers } from "hardhat";

// ─── drand evmnet constants (live-verified via https://api.drand.sh) ───
const EVMNET_GENESIS = 1727521075n;
const EVMNET_PERIOD = 3n;
// Group public key, real-parts-first ordering for BLS.verifySingle
const EVMNET_PUBKEY: [bigint, bigint, bigint, bigint] = [
  0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808fn,
  0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382n,
  0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0bn,
  0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6n,
];
// Real beacon signatures fetched from api.drand.sh (evmnet), uncompressed G1 (x, y)
const SIG_ROUND_1: [bigint, bigint] = [
  0x11f812d738a36b2210dc88c2d635ad8039588205f42445d6de09e6530165c346n,
  0x2a23aca348c84badcf8df5321ac24577b7963d5b0d780bc4626baedb45cde373n,
];
const SIG_ROUND_10M: [bigint, bigint] = [
  0x2c7b65b5acfe55256910ca71cf0a0fa71ac34c2a1167f86a22930a03e70ebec0n,
  0x0f7a530796e7ee38600b06da0390634a9b154e3eebc3b323dde2111e1c8ebdf3n,
];
const ROUND_10M = 10_000_000n;

describe("DrandBeacon (drand evmnet)", () => {
  async function deployBeacon() {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    return Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  }

  it("accepts the real evmnet group public key", async () => {
    const beacon = await deployBeacon();
    const pk = await beacon.publicKey();
    expect(pk[0]).to.equal(EVMNET_PUBKEY[0]);
  });

  it("rejects a malformed public key", async () => {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const bad = [...EVMNET_PUBKEY] as [bigint, bigint, bigint, bigint];
    bad[0] = bad[0] + 1n;
    await expect(Beacon.deploy(bad, EVMNET_GENESIS, EVMNET_PERIOD)).to.be.revertedWithCustomError(
      Beacon,
      "InvalidPublicKey"
    );
  });

  it("verifies the REAL beacon signature for round 1", async () => {
    const beacon = await deployBeacon();
    await expect(beacon.verifyBeaconRound(1, SIG_ROUND_1)).to.not.be.reverted;
  });

  it("verifies the REAL beacon signature for round 10,000,000", async () => {
    const beacon = await deployBeacon();
    await expect(beacon.verifyBeaconRound(ROUND_10M, SIG_ROUND_10M)).to.not.be.reverted;
  });

  it("rejects a valid signature presented for the wrong round", async () => {
    const beacon = await deployBeacon();
    await expect(beacon.verifyBeaconRound(2, SIG_ROUND_1)).to.be.revertedWithCustomError(
      beacon,
      "InvalidSignature"
    );
  });

  it("rejects a tampered signature", async () => {
    const beacon = await deployBeacon();
    const tampered: [bigint, bigint] = [SIG_ROUND_1[0] + 1n, SIG_ROUND_1[1]];
    await expect(beacon.verifyBeaconRound(1, tampered)).to.be.revertedWithCustomError(
      beacon,
      "InvalidSignature"
    );
  });

  it("computes round scheduling correctly", async () => {
    const beacon = await deployBeacon();
    expect(await beacon.timeOfRound(1)).to.equal(EVMNET_GENESIS);
    expect(await beacon.timeOfRound(ROUND_10M)).to.equal(
      EVMNET_GENESIS + (ROUND_10M - 1n) * EVMNET_PERIOD
    );
    expect(await beacon.roundAt(EVMNET_GENESIS)).to.equal(1n);
    expect(await beacon.roundAt(EVMNET_GENESIS + 1n)).to.equal(2n);
    expect(await beacon.roundAt(EVMNET_GENESIS + 3n)).to.equal(2n);
    expect(await beacon.roundAt(EVMNET_GENESIS + 4n)).to.equal(3n);
  });
});
