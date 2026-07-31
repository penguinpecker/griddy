import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, reset } from "@nomicfoundation/hardhat-network-helpers";

const EVMNET_GENESIS = 1727521075n;
const EVMNET_PERIOD = 3n;
const EVMNET_PUBKEY: [bigint, bigint, bigint, bigint] = [
  0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808fn,
  0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382n,
  0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0bn,
  0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6n,
];
const SIG_ROUND_10M: [bigint, bigint] = [
  0x2c7b65b5acfe55256910ca71cf0a0fa71ac34c2a1167f86a22930a03e70ebec0n,
  0x0f7a530796e7ee38600b06da0390634a9b154e3eebc3b323dde2111e1c8ebdf3n,
];
const ROUND_10M = 10_000_000n;
const BEACON_GAP = 10n;
const MIN_STAKE = 10n ** 14n;
const TIP = 3n * 10n ** 13n;

describe("GriddyV3 — upgrade from V2, no Motherlode, no token", () => {
  // own chain state: earlier suites warp the clock past our beacon fixtures
  beforeEach(async () => {
    await reset();
  });
  async function deployV2ThenState() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
    const TokenF = await ethers.getContractFactory("GriddyTokenV2");
    const token = await upgrades.deployProxy(TokenF, [owner.address], { kind: "uups" });
    const V2 = await ethers.getContractFactory("GriddyV2");
    const griddy = await upgrades.deployProxy(
      V2, [await token.getAddress(), owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    await token.setMinter(await griddy.getAddress(), true);
    // seed a Motherlode reserve that V3 must not strand
    await griddy.depositBonusReserve({ value: 5n * 10n ** 16n });
    return { owner, alice, bob, beacon, token, griddy };
  }

  it("upgrades in place: state survives, stranded reserve becomes withdrawable fees", async () => {
    const { owner, alice, griddy } = await deployV2ThenState();
    const proxy = await griddy.getAddress();

    // live stake mid-flight
    const roundDuration = await griddy.roundDuration();
    const beaconTime = EVMNET_GENESIS + (ROUND_10M - 1n) * EVMNET_PERIOD;
    await time.setNextBlockTimestamp(beaconTime - roundDuration - BEACON_GAP);
    await griddy.skipEmptyRound(await griddy.currentRoundId());
    const id = await griddy.currentRoundId();
    await time.setNextBlockTimestamp(beaconTime - BEACON_GAP - 5n);
    await griddy.connect(alice).stake(id, [4], [7n * 10n ** 16n], { value: 7n * 10n ** 16n });

    const reserveBefore = await griddy.bonusReserve();
    const feesBefore = await griddy.accumulatedFees();
    expect(reserveBefore).to.equal(5n * 10n ** 16n);

    // ── UPGRADE ──
    const V3 = await ethers.getContractFactory("GriddyV3");
    const v3 = await upgrades.upgradeProxy(proxy, V3, { call: { fn: "initializeV3", args: [] } });
    expect(await v3.getAddress()).to.equal(proxy);

    // state preserved
    expect(await v3.currentRoundId()).to.equal(id);
    expect(await v3.stakeOf(id, 4, alice.address)).to.equal(7n * 10n ** 16n);
    expect(await v3.minStakeWei()).to.equal(MIN_STAKE);
    expect(await v3.resolverTipWei()).to.equal(TIP);
    expect(await v3.owner()).to.equal(owner.address);
    // reserve folded into fees — nothing stranded
    expect(await v3.bonusReserve_retired()).to.equal(0n);
    expect(await v3.accumulatedFees()).to.equal(feesBefore + reserveBefore);

    // the in-flight round still resolves, now without bonus/token
    await time.setNextBlockTimestamp(beaconTime + 1n);
    const balBefore = await ethers.provider.getBalance(alice.address);
    await v3.connect(owner).resolveRound(id, SIG_ROUND_10M);
    const r = await v3.rounds(id);
    expect(r.resolved).to.equal(true);
    expect(r.isBonusRound).to.equal(false);          // never set again
    expect(r.griddyBase).to.equal(0n);
    // sole staker on the winning cell takes the whole prize
    expect(await ethers.provider.getBalance(alice.address)).to.equal(balBefore + r.distributable);
  });

  it("V3 has no bonus or token surface at all", async () => {
    const { owner, griddy } = await deployV2ThenState();
    const V3 = await ethers.getContractFactory("GriddyV3");
    const v3 = await upgrades.upgradeProxy(await griddy.getAddress(), V3, { call: { fn: "initializeV3", args: [] } });
    const iface = v3.interface;
    for (const gone of ["depositBonusReserve", "setMotherlodePerRound", "setBonusRoundOdds",
                        "setBonusMultiplier", "setBonusReserveBps", "setGriddyToken", "setGriddyPerRound"]) {
      expect(iface.getFunction(gone as any), `${gone} should not exist`).to.equal(null);
    }
    // fees are fully withdrawable (no reserve bucket holding ETH back)
    const fees = await v3.accumulatedFees();
    expect(fees).to.be.greaterThan(0n);
    const before = await ethers.provider.getBalance(owner.address);
    const tx = await v3.connect(owner).withdrawFees();
    const rc = await tx.wait();
    expect(await ethers.provider.getBalance(owner.address)).to.equal(before + fees - rc!.gasUsed * rc!.gasPrice);
  });
});
