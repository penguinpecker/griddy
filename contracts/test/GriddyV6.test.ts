import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, reset } from "@nomicfoundation/hardhat-network-helpers";

// ─── drand evmnet constants (live-verified via https://api.drand.sh) ───
const EVMNET_GENESIS = 1727521075n;
const EVMNET_PERIOD = 3n;
const EVMNET_PUBKEY: [bigint, bigint, bigint, bigint] = [
  0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808fn,
  0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382n,
  0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0bn,
  0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6n,
];
// Real evmnet beacon signatures (uncompressed G1), re-verified against
// https://api.drand.sh/v2/beacons/evmnet/rounds/<n>
const SIG_ROUND_10M: [bigint, bigint] = [
  0x2c7b65b5acfe55256910ca71cf0a0fa71ac34c2a1167f86a22930a03e70ebec0n,
  0x0f7a530796e7ee38600b06da0390634a9b154e3eebc3b323dde2111e1c8ebdf3n,
];
const ROUND_10M = 10_000_000n;
const SIG_ROUND_B: [bigint, bigint] = [
  0x13d1b70855d04ea9af3efc4a03378f655459da97819ca4c63427104cf20bd724n,
  0x2c4116eba1899aefcc969a160faa09d164ef5c2dbcef91ad7455ad7c0457d37cn,
];
const ROUND_B = 10_000_013n;

const BEACON_GAP = 10n;
const MIN_STAKE = 10n ** 14n;
const TIP = 3n * 10n ** 13n;
const FEE_BPS = 500n;
// V5 ceiling ($0.01) vs the V6 ceiling ($1) this upgrade exists to raise
const HI_V5 = 10n ** 16n;
const HI_V6 = 10n ** 18n;
const LO = 10n ** 13n;
// the minimum the owner actually wants live: 0.1 USDC, unreachable under V5
const TARGET_MIN = 10n ** 17n;

// ─── beacon schedule replicas (valid for t > genesis) ───
const timeOfRoundTs = (r: bigint) => EVMNET_GENESIS + (r - 1n) * EVMNET_PERIOD;

// Round A: opened at A_OPEN (roundDuration 30 + beaconGap 10 before the emit)
// pins exactly to drand ROUND_10M; betting closes at A_END.
const T10M = timeOfRoundTs(ROUND_10M);
const A_OPEN = T10M - 40n;
const A_END = T10M - 10n;
// A lazy roll at B_ROLL (round A already ended) pins the fresh round to
// drand ROUND_B; its betting closes at B_END = T10M + 29.
const B_ROLL = T10M - 2n;
const B_END = timeOfRoundTs(ROUND_B) - BEACON_GAP;

const feeOf = (pool: bigint) => (pool * FEE_BPS) / 10_000n;

const vrfFromSig = (sig: [bigint, bigint]) =>
  BigInt(ethers.solidityPackedKeccak256(["uint256", "uint256"], [sig[0], sig[1]]));

/** Replicates the contract's stake-weighted winner draw */
function pickWinner(vrf: bigint, cellTotals: Map<number, bigint>, pool: bigint) {
  const target = vrf % pool;
  let acc = 0n;
  for (let i = 0; i < 25; i++) {
    acc += cellTotals.get(i) ?? 0n;
    if (target < acc) return i;
  }
  throw new Error("no winner drawn");
}

describe("GriddyV6 — min-stake ceiling raised, everything else frozen", () => {
  // own chain state: fixtures pin real historical beacon rounds
  beforeEach(async () => { await reset(); });

  async function deployV5() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
    const V5 = await ethers.getContractFactory("GriddyV5");
    const griddy = await upgrades.deployProxy(
      V5, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    return { owner, alice, bob, carol, dave, beacon, griddy };
  }

  /** The live path: a V5 proxy upgraded in place, no initializer call. */
  async function upgradeToV6(griddy: any) {
    const V6 = await ethers.getContractFactory("GriddyV6");
    return upgrades.upgradeProxy(await griddy.getAddress(), V6);
  }

  /** First stake after the deploy-time round expires lazily opens a round
   *  pinned exactly to drand ROUND_10M (betting window [A_OPEN, A_END)). */
  async function openRoundA(griddy: any, signer: any, cells: number[], amounts: bigint[]) {
    await time.setNextBlockTimestamp(A_OPEN);
    const id = (await griddy.currentRoundId()) + 1n;
    const value = amounts.reduce((a, b) => a + b, 0n);
    await griddy.connect(signer).stake(id, cells, amounts, { value });
    expect((await griddy.rounds(id)).drandRound).to.equal(ROUND_10M);
    return id;
  }

  /** First stake at B_ROLL lazily opens the next round pinned to ROUND_B —
   *  round A stays behind, staked and unresolved. */
  async function rollToRoundB(griddy: any, signer: any, cells: number[], amounts: bigint[]) {
    await time.setNextBlockTimestamp(B_ROLL);
    const id = (await griddy.currentRoundId()) + 1n;
    const value = amounts.reduce((a, b) => a + b, 0n);
    await griddy.connect(signer).stake(id, cells, amounts, { value });
    expect((await griddy.rounds(id)).drandRound).to.equal(ROUND_B);
    return id;
  }

  async function stakeAt(griddy: any, signer: any, ts: bigint, id: bigint, cells: number[], amounts: bigint[]) {
    await time.setNextBlockTimestamp(ts);
    const value = amounts.reduce((a, b) => a + b, 0n);
    await griddy.connect(signer).stake(id, cells, amounts, { value });
  }

  // ════════════════════════════════════════════════════════════
  // 1. Upgrade: live V5 money in flight → V6
  // ════════════════════════════════════════════════════════════

  describe("upgrade V5 → V6", () => {
    it("preserves every slot across a live staked round, and the in-flight round still pays V5 math", async () => {
      const { owner, alice, bob, carol, beacon, griddy } = await deployV5();
      const proxy = await griddy.getAddress();

      // round A: staked, left behind by the lazy roll, then resolved — so the
      // proxy carries real accumulated fees into the upgrade
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      const idB = await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);
      await stakeAt(griddy, carol, T10M - 1n, idB, [11], [3n * 10n ** 17n]);
      await time.setNextBlockTimestamp(T10M + 1n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);

      // round B is live money: staked, ended-or-open, unresolved
      const potB = 5n * 10n ** 17n;
      const feesBefore = feeOf(10n ** 17n) - TIP;
      const before = {
        roundId: await griddy.currentRoundId(),
        pot: (await griddy.rounds(idB)).totalStaked,
        stakers: (await griddy.rounds(idB)).totalStakers,
        fees: await griddy.accumulatedFees(),
        unresolved: await griddy.totalUnresolvedStakes(),
        owner: await griddy.owner(),
        beacon: await griddy.beacon(),
        minStake: await griddy.minStakeWei(),
        tip: await griddy.resolverTipWei(),
        feeBps: await griddy.protocolFeeBps(),
        duration: await griddy.roundDuration(),
        gap: await griddy.beaconGap(),
        balance: await ethers.provider.getBalance(proxy),
      };
      expect(before.fees).to.equal(feesBefore);
      expect(before.unresolved).to.equal(potB);
      expect(await griddy.MIN_STAKE_HI()).to.equal(HI_V5);
      const implBefore = await upgrades.erc1967.getImplementationAddress(proxy);

      // ── UPGRADE (no initializer: V6 adds no state) ──
      const v6 = await upgradeToV6(griddy);
      expect(await v6.getAddress()).to.equal(proxy);
      expect(await upgrades.erc1967.getImplementationAddress(proxy)).to.not.equal(implBefore);

      // every value the proxy held is untouched
      expect(await v6.currentRoundId()).to.equal(before.roundId);
      expect((await v6.rounds(idB)).totalStaked).to.equal(before.pot);
      expect((await v6.rounds(idB)).totalStakers).to.equal(before.stakers);
      expect(await v6.accumulatedFees()).to.equal(before.fees);
      expect(await v6.totalUnresolvedStakes()).to.equal(before.unresolved);
      expect(await v6.owner()).to.equal(before.owner);
      expect(await v6.beacon()).to.equal(before.beacon);
      expect(await v6.beacon()).to.equal(await beacon.getAddress());
      expect(await v6.minStakeWei()).to.equal(before.minStake);
      expect(await v6.minStakeWei()).to.equal(MIN_STAKE);
      expect(await v6.resolverTipWei()).to.equal(before.tip);
      expect(await v6.protocolFeeBps()).to.equal(before.feeBps);
      expect(await v6.roundDuration()).to.equal(before.duration);
      expect(await v6.beaconGap()).to.equal(before.gap);
      expect(await ethers.provider.getBalance(proxy)).to.equal(before.balance);
      // per-player positions and the settled round survive intact
      expect(await v6.stakeOf(idB, 7, bob.address)).to.equal(2n * 10n ** 17n);
      expect(await v6.stakeOf(idB, 11, carol.address)).to.equal(3n * 10n ** 17n);
      expect(await v6.playerTotalStaked(idB, carol.address)).to.equal(3n * 10n ** 17n);
      expect((await v6.rounds(idA)).resolved).to.equal(true);
      expect((await v6.rounds(idA)).distributable).to.equal(10n ** 17n - feeOf(10n ** 17n));
      // ...and the ONE thing that changed
      expect(await v6.MIN_STAKE_HI()).to.equal(HI_V6);
      expect(await v6.MIN_STAKE_LO()).to.equal(LO);

      // the in-flight round resolves under V6 with exactly V5's money math
      const totals = new Map<number, bigint>([[7, 2n * 10n ** 17n], [11, 3n * 10n ** 17n]]);
      const winCell = pickWinner(vrfFromSig(SIG_ROUND_B), totals, potB);
      const winner = winCell === 7 ? bob : carol;
      const winnerBefore = await ethers.provider.getBalance(winner.address);

      await time.setNextBlockTimestamp(B_END + 11n);
      await v6.connect(owner).resolveRound(idB, SIG_ROUND_B);

      const dist = potB - feeOf(potB);
      const r = await v6.rounds(idB);
      expect(r.winningCell).to.equal(winCell);
      expect(r.distributable).to.equal(dist);
      expect(r.winnerTotal).to.equal(totals.get(winCell));
      // sole staker on the winning cell takes the entire 95%
      expect(await ethers.provider.getBalance(winner.address)).to.equal(winnerBefore + dist);
      expect(await v6.accumulatedFees()).to.equal(feesBefore + feeOf(potB) - TIP);
      expect(await v6.totalUnresolvedStakes()).to.equal(0n);
      // V5 semantics kept: resolution opens NO new round
      expect(await v6.currentRoundId()).to.equal(before.roundId);
      // pot conservation: what remains is exactly the retained fees
      expect(await ethers.provider.getBalance(proxy)).to.equal(await v6.accumulatedFees());
    });

    it("storage-layout safety: the OZ validator accepts V5 → V6 as a pure logic upgrade", async () => {
      const { griddy } = await deployV5();
      const V5 = await ethers.getContractFactory("GriddyV5");
      const V6 = await ethers.getContractFactory("GriddyV6");
      // throws on any layout incompatibility — a silent pass is the assertion
      await upgrades.validateUpgrade(V5, V6, { kind: "uups" });
      await upgrades.validateUpgrade(await griddy.getAddress(), V6, { kind: "uups" });
    });

    it("ATTACK: a non-owner cannot swing the proxy onto the V6 implementation", async () => {
      const { alice, griddy } = await deployV5();
      const proxy = await griddy.getAddress();
      const V6 = await ethers.getContractFactory("GriddyV6");
      const rogueImpl = await V6.deploy();
      await rogueImpl.waitForDeployment();
      await expect(
        griddy.connect(alice).upgradeToAndCall(await rogueImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(griddy, "OwnableUnauthorizedAccount");
      expect(await griddy.MIN_STAKE_HI()).to.equal(HI_V5);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 2. The ceiling actually moved
  // ════════════════════════════════════════════════════════════

  describe("min-stake ceiling", () => {
    it("setMinStake(0.1) is out of bounds on V5 and succeeds on V6 — same proxy, same owner", async () => {
      const { owner, griddy } = await deployV5();

      // the live blocker: V5's ceiling is 0.01
      await expect(griddy.connect(owner).setMinStake(TARGET_MIN)).to.be.revertedWith("Out of bounds");
      expect(await griddy.minStakeWei()).to.equal(MIN_STAKE);

      const v6 = await upgradeToV6(griddy);
      await expect(v6.connect(owner).setMinStake(TARGET_MIN))
        .to.emit(v6, "ConfigUpdated").withArgs("minStakeWei", TARGET_MIN);
      expect(await v6.minStakeWei()).to.equal(TARGET_MIN);
      // and V5's old ceiling is still a legal setting
      await v6.connect(owner).setMinStake(HI_V5);
      expect(await v6.minStakeWei()).to.equal(HI_V5);
    });

    it("bounds are still enforced on V6: 1e18 ok, 1e18+1 rejected, 1e13-1 rejected, owner-only", async () => {
      const { owner, alice, griddy } = await deployV5();
      const v6 = await upgradeToV6(griddy);

      await expect(v6.connect(owner).setMinStake(HI_V6 + 1n)).to.be.revertedWith("Out of bounds");
      await expect(v6.connect(owner).setMinStake(LO - 1n)).to.be.revertedWith("Out of bounds");
      await expect(v6.connect(owner).setMinStake(0n)).to.be.revertedWith("Out of bounds");
      await expect(v6.connect(alice).setMinStake(TARGET_MIN))
        .to.be.revertedWithCustomError(v6, "OwnableUnauthorizedAccount");
      expect(await v6.minStakeWei()).to.equal(MIN_STAKE);

      // both ends of the widened window are settable
      await v6.connect(owner).setMinStake(LO);
      expect(await v6.minStakeWei()).to.equal(LO);
      await expect(v6.connect(owner).setMinStake(HI_V6))
        .to.emit(v6, "ConfigUpdated").withArgs("minStakeWei", HI_V6);
      expect(await v6.minStakeWei()).to.equal(HI_V6);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 3. Staking under the 0.1 minimum the owner wants live
  // ════════════════════════════════════════════════════════════

  describe("minStakeWei = 0.1 in practice", () => {
    async function v6AtTargetMin() {
      const ctx = await deployV5();
      const v6 = await upgradeToV6(ctx.griddy);
      await v6.connect(ctx.owner).setMinStake(TARGET_MIN);
      expect(await v6.minStakeWei()).to.equal(TARGET_MIN);
      return { ...ctx, griddy: v6 };
    }

    it("a new position below 0.1 reverts; exactly 0.1 is accepted", async () => {
      const { alice, bob, griddy } = await v6AtTargetMin();
      const id = await openRoundA(griddy, alice, [3], [TARGET_MIN]);

      // one wei short of the minimum, on a fresh cell — rejected
      await time.setNextBlockTimestamp(A_OPEN + 1n);
      await expect(
        griddy.connect(bob).stake(id, [9], [TARGET_MIN - 1n], { value: TARGET_MIN - 1n })
      ).to.be.revertedWith("Below min stake");
      // the old V5-era minimum no longer buys a position
      await time.setNextBlockTimestamp(A_OPEN + 2n);
      await expect(
        griddy.connect(bob).stake(id, [9], [MIN_STAKE], { value: MIN_STAKE })
      ).to.be.revertedWith("Below min stake");

      // exactly the minimum is accepted
      await stakeAt(griddy, bob, A_OPEN + 3n, id, [9], [TARGET_MIN]);
      expect(await griddy.stakeOf(id, 9, bob.address)).to.equal(TARGET_MIN);
      expect((await griddy.rounds(id)).totalStaked).to.equal(2n * TARGET_MIN);
      expect(await griddy.totalUnresolvedStakes()).to.equal(2n * TARGET_MIN);

      // a multi-cell stake is checked per cell: one short leg reverts the lot
      await time.setNextBlockTimestamp(A_OPEN + 4n);
      await expect(
        griddy.connect(bob).stake(id, [12, 13], [TARGET_MIN, TARGET_MIN - 1n], { value: 2n * TARGET_MIN - 1n })
      ).to.be.revertedWith("Below min stake");
      expect((await griddy.rounds(id)).totalStaked).to.equal(2n * TARGET_MIN);
    });

    it("a 1-wei top-up on an existing position still succeeds — the asymmetry is per cell, not per player", async () => {
      const { alice, griddy } = await v6AtTargetMin();
      const id = await openRoundA(griddy, alice, [3], [TARGET_MIN]);

      // top-up of any size on a cell alice already holds
      await stakeAt(griddy, alice, A_OPEN + 1n, id, [3], [1n]);
      expect(await griddy.stakeOf(id, 3, alice.address)).to.equal(TARGET_MIN + 1n);
      expect(await griddy.cellTotal(id, 3)).to.equal(TARGET_MIN + 1n);
      // no double-count of the staker, and the accumulator tracks the wei
      expect((await griddy.rounds(id)).totalStakers).to.equal(1n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(TARGET_MIN + 1n);
      // one staker slot per cell, not one per top-up
      expect((await griddy.getCellStakers(id, 3)).length).to.equal(1);

      // ...but a NEW cell for the same player is a new position: min applies
      await time.setNextBlockTimestamp(A_OPEN + 2n);
      await expect(
        griddy.connect(alice).stake(id, [4], [1n], { value: 1n })
      ).to.be.revertedWith("Below min stake");

      // the round still resolves cleanly with the topped-up position
      const pool = TARGET_MIN + 1n;
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      await time.setNextBlockTimestamp(T10M + 1n);
      const tx = await griddy.connect(alice).resolveRound(id, SIG_ROUND_10M);
      const rc = await tx.wait();
      const dist = pool - feeOf(pool);
      expect((await griddy.rounds(id)).winningCell).to.equal(3);
      expect((await griddy.rounds(id)).distributable).to.equal(dist);
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
      // alice is both sole winner and resolver: she nets dist + tip, minus gas
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        aliceBefore + dist + TIP - rc!.gasUsed * rc!.gasPrice);
      expect(await griddy.accumulatedFees()).to.equal(feeOf(pool) - TIP);
    });
  });
});
