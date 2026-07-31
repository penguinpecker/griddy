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
const SIG_ROUND_1: [bigint, bigint] = [
  0x11f812d738a36b2210dc88c2d635ad8039588205f42445d6de09e6530165c346n,
  0x2a23aca348c84badcf8df5321ac24577b7963d5b0d780bc4626baedb45cde373n,
];
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
const REFUND_DELAY = 30n * 24n * 3600n;
const VOID_GRACE = 3n * 24n * 3600n;
const REPIN_TIMEOUT = 6n * 3600n;

// ─── beacon schedule replicas (valid for t > genesis) ───
const timeOfRoundTs = (r: bigint) => EVMNET_GENESIS + (r - 1n) * EVMNET_PERIOD;
const roundAtTs = (t: bigint) => (t - EVMNET_GENESIS + EVMNET_PERIOD - 1n) / EVMNET_PERIOD + 1n;

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

describe("GriddyV5 — continuous rounds, every property under attack", () => {
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

  async function deployV4Live() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
    const V4 = await ethers.getContractFactory("GriddyV4");
    const griddy = await upgrades.deployProxy(
      V4, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    return { owner, alice, bob, beacon, griddy };
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

  const reservedOf = async (g: any) =>
    (await g.totalUnresolvedStakes()) + (await g.pendingRefunds())
    + (await g.pendingWithdrawals()) + (await g.accumulatedFees());

  // ════════════════════════════════════════════════════════════
  // 1. Upgrade: V4-shaped live state → V5
  // ════════════════════════════════════════════════════════════

  describe("upgrade V4 → V5", () => {
    it("migrates a live staked round in place: accumulator seeded, state/owner preserved, V4 math intact", async () => {
      const { owner, alice, bob, beacon, griddy } = await deployV4Live();
      const proxy = await griddy.getAddress();

      // V4-style open pinned to 10M, with a staked unresolved round in flight
      await time.setNextBlockTimestamp(A_OPEN);
      await griddy.skipEmptyRound(await griddy.currentRoundId());
      const id = await griddy.currentRoundId();
      await time.setNextBlockTimestamp(A_END - 20n);
      await griddy.connect(alice).stake(id, [4], [7n * 10n ** 16n], { value: 7n * 10n ** 16n });
      await time.setNextBlockTimestamp(A_END - 15n);
      await griddy.connect(bob).stake(id, [9], [3n * 10n ** 16n], { value: 3n * 10n ** 16n });

      // ── UPGRADE ──
      const V5 = await ethers.getContractFactory("GriddyV5");
      const v5 = await upgrades.upgradeProxy(proxy, V5, { call: { fn: "initializeV5", args: [] } });
      expect(await v5.getAddress()).to.equal(proxy);

      // accumulator seeded from the single V4 round that can be in flight
      expect(await v5.totalUnresolvedStakes()).to.equal(10n ** 17n);
      // state and owner preserved
      expect(await v5.currentRoundId()).to.equal(id);
      expect(await v5.stakeOf(id, 4, alice.address)).to.equal(7n * 10n ** 16n);
      expect(await v5.stakeOf(id, 9, bob.address)).to.equal(3n * 10n ** 16n);
      expect(await v5.owner()).to.equal(owner.address);
      expect(await v5.beacon()).to.equal(await beacon.getAddress());
      expect(await v5.minStakeWei()).to.equal(MIN_STAKE);
      expect(await v5.resolverTipWei()).to.equal(TIP);

      // the in-flight round resolves under V5 with exactly V4's money math
      const pool = 10n ** 17n;
      const totals = new Map<number, bigint>([[4, 7n * 10n ** 16n], [9, 3n * 10n ** 16n]]);
      const winCell = pickWinner(vrfFromSig(SIG_ROUND_10M), totals, pool);
      const winner = winCell === 4 ? alice : bob;
      const before = await ethers.provider.getBalance(winner.address);

      await time.setNextBlockTimestamp(T10M + 1n);
      await v5.connect(owner).resolveRound(id, SIG_ROUND_10M);

      const dist = pool - feeOf(pool);
      const r = await v5.rounds(id);
      expect(r.winningCell).to.equal(winCell);
      expect(r.distributable).to.equal(dist);
      // sole staker on the winning cell takes the entire 95%
      expect(await ethers.provider.getBalance(winner.address)).to.equal(before + dist);
      expect(await v5.accumulatedFees()).to.equal(feeOf(pool) - TIP);
      expect(await v5.totalUnresolvedStakes()).to.equal(0n);
      // V5 semantics on the migrated proxy: resolution opens NO new round
      expect(await v5.currentRoundId()).to.equal(id);
    });

    it("upgrading with an empty current round seeds a zero accumulator", async () => {
      const { griddy } = await deployV4Live();
      const V5 = await ethers.getContractFactory("GriddyV5");
      const v5 = await upgrades.upgradeProxy(await griddy.getAddress(), V5, {
        call: { fn: "initializeV5", args: [] },
      });
      expect(await v5.totalUnresolvedStakes()).to.equal(0n);
      expect(await v5.currentRoundId()).to.equal(1n);
    });

    it("ATTACK: initializeV5 (and the earlier reinitializers) cannot run again", async () => {
      const { alice, griddy } = await deployV4Live();
      const V5 = await ethers.getContractFactory("GriddyV5");
      const v5 = await upgrades.upgradeProxy(await griddy.getAddress(), V5, {
        call: { fn: "initializeV5", args: [] },
      });
      await expect(v5.initializeV5()).to.be.revertedWithCustomError(v5, "InvalidInitialization");
      await expect(v5.connect(alice).initializeV5()).to.be.revertedWithCustomError(v5, "InvalidInitialization");
      await expect(v5.initializeV3()).to.be.revertedWithCustomError(v5, "InvalidInitialization");
    });

    it("ATTACK: non-owner cannot upgrade the proxy", async () => {
      const { alice, griddy } = await deployV4Live();
      const proxy = await griddy.getAddress();
      const V5 = await ethers.getContractFactory("GriddyV5");
      const v5 = await upgrades.upgradeProxy(proxy, V5, { call: { fn: "initializeV5", args: [] } });
      const impl = await upgrades.erc1967.getImplementationAddress(proxy);
      await expect(
        v5.connect(alice).upgradeToAndCall(impl, "0x")
      ).to.be.revertedWithCustomError(v5, "OwnableUnauthorizedAccount");
    });

    it("ATTACK: a stranger calling initializeV5 on a fresh V5 proxy cannot corrupt the accumulator", async () => {
      // Fresh V5 proxies run initialize (version 1), leaving reinitializer(3)
      // callable by ANYONE. With two staked pending rounds, an overwrite of
      // totalUnresolvedStakes would let the owner sweep player stakes and
      // brick resolution of the older round.
      const { owner, alice, bob, carol, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [3n * 10n ** 17n]);
      await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);
      expect(await griddy.totalUnresolvedStakes()).to.equal(5n * 10n ** 17n);

      await griddy.connect(carol).initializeV5(); // attacker

      // the accumulator must survive intact...
      expect(await griddy.totalUnresolvedStakes()).to.equal(5n * 10n ** 17n);
      // ...the old round must still resolve...
      await time.setNextBlockTimestamp(T10M + 1n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);
      expect(await griddy.totalUnresolvedStakes()).to.equal(2n * 10n ** 17n);
      // ...and the owner still cannot reach the remaining player stakes
      await expect(griddy.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 2. Lazy roll
  // ════════════════════════════════════════════════════════════

  describe("lazy roll", () => {
    it("stake after endTime with id current+1 opens exactly one fresh window from now", async () => {
      const { alice, bob, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      const idB = await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);

      expect(idB).to.equal(idA + 1n);
      expect(await griddy.currentRoundId()).to.equal(idB);
      const b = await griddy.rounds(idB);
      expect(b.startTime).to.equal(B_ROLL);       // window opens at the stake
      expect(b.endTime).to.equal(B_END);
      expect(b.totalStaked).to.equal(2n * 10n ** 17n);
      // the expired round stays behind untouched, awaiting resolution
      const a = await griddy.rounds(idA);
      expect(a.resolved).to.equal(false);
      expect(a.totalStaked).to.equal(10n ** 17n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(3n * 10n ** 17n);
    });

    it("a year-long gap still creates exactly one round, and only id current+1 is accepted", async () => {
      const { alice, bob, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);

      const far = T10M + 365n * 24n * 3600n;
      // id current+2 never exists, however long the gap was
      await time.setNextBlockTimestamp(far);
      await expect(
        griddy.connect(bob).stake(idA + 2n, [0], [MIN_STAKE], { value: MIN_STAKE })
      ).to.be.revertedWith("Wrong round");
      expect(await griddy.currentRoundId()).to.equal(idA); // failed probe rolled nothing

      await time.setNextBlockTimestamp(far + 1n);
      await griddy.connect(bob).stake(idA + 1n, [0], [MIN_STAKE], { value: MIN_STAKE });
      expect(await griddy.currentRoundId()).to.equal(idA + 1n);
      const b = await griddy.rounds(idA + 1n);
      expect(b.startTime).to.equal(far + 1n);
      expect(b.drandRound).to.equal(roundAtTs(far + 1n + 40n));
      // the old stake is still fully accounted
      expect(await griddy.totalUnresolvedStakes()).to.equal(10n ** 17n + MIN_STAKE);
    });

    it("ATTACK: the stale round id cannot capture a stake after expiry", async () => {
      const { alice, bob, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);

      await time.setNextBlockTimestamp(T10M); // past A_END
      await expect(
        griddy.connect(bob).stake(idA, [0], [10n ** 17n], { value: 10n ** 17n })
      ).to.be.revertedWith("Wrong round");
      // nothing landed in the old round, no round was opened
      expect(await griddy.currentRoundId()).to.equal(idA);
      expect((await griddy.rounds(idA)).totalStaked).to.equal(10n ** 17n);
      expect(await griddy.playerTotalStaked(idA, bob.address)).to.equal(0n);

      // the honest client prediction (id+1) works a second later
      await time.setNextBlockTimestamp(T10M + 1n);
      await griddy.connect(bob).stake(idA + 1n, [0], [10n ** 17n], { value: 10n ** 17n });
      expect((await griddy.rounds(idA + 1n)).startTime).to.equal(T10M + 1n);
    });

    it("ATTACK: future ids are rejected while the round is live", async () => {
      const { alice, bob, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      await time.setNextBlockTimestamp(A_END - 20n);
      await expect(
        griddy.connect(bob).stake(idA + 1n, [0], [MIN_STAKE], { value: MIN_STAKE })
      ).to.be.revertedWith("Wrong round");
      await time.setNextBlockTimestamp(A_END - 19n);
      await expect(
        griddy.connect(bob).stake(idA - 1n, [0], [MIN_STAKE], { value: MIN_STAKE })
      ).to.be.revertedWith("Wrong round");
      expect(await griddy.currentRoundId()).to.equal(idA);
    });

    it("boundary: at exactly endTime the expired id refuses the stake (window is [start, end))", async () => {
      const { alice, bob, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      await time.setNextBlockTimestamp(A_END); // block.timestamp == endTime
      await expect(
        griddy.connect(bob).stake(idA, [0], [MIN_STAKE], { value: MIN_STAKE })
      ).to.be.revertedWith("Wrong round");
      expect(await griddy.currentRoundId()).to.equal(idA);
    });

    it("boundary: at exactly endTime the next id opens a window starting right there", async () => {
      const { alice, bob, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      await time.setNextBlockTimestamp(A_END);
      await griddy.connect(bob).stake(idA + 1n, [0], [MIN_STAKE], { value: MIN_STAKE });
      const b = await griddy.rounds(idA + 1n);
      expect(b.startTime).to.equal(A_END);
      expect(b.drandRound).to.equal(roundAtTs(A_END + 40n));
      expect(b.endTime).to.equal(timeOfRoundTs(roundAtTs(A_END + 40n)) - BEACON_GAP);
      expect(b.endTime).to.be.greaterThan(b.startTime);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 3. Decoupled resolution
  // ════════════════════════════════════════════════════════════

  describe("decoupled resolution", () => {
    it("resolves an ended round while the next is live — V4 money math exact, then the newer round resolves too", async () => {
      const { owner, alice, bob, carol, dave, griddy } = await deployV5();
      const potA = 10n ** 17n;
      const idA = await openRoundA(griddy, alice, [3], [potA]);
      const idB = await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);

      // resolve A while B is live for betting
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const resolverBefore = await ethers.provider.getBalance(owner.address);
      await time.setNextBlockTimestamp(T10M + 1n);
      const tx = await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);
      const rc = await tx.wait();

      const feeA = feeOf(potA);
      const distA = potA - feeA;
      const a = await griddy.rounds(idA);
      expect(a.resolved).to.equal(true);
      expect(a.winningCell).to.equal(3);          // sole staked cell
      expect(a.distributable).to.equal(distA);
      // winner receives exactly 95%; the tip comes out of the fee, never the prize
      expect(await ethers.provider.getBalance(alice.address)).to.equal(aliceBefore + distA);
      expect(await ethers.provider.getBalance(owner.address)).to.equal(
        resolverBefore + TIP - rc!.gasUsed * rc!.gasPrice);
      expect(await griddy.accumulatedFees()).to.equal(feeA - TIP);
      expect(await griddy.totalUnresolvedStakes()).to.equal(2n * 10n ** 17n);

      // resolution opened no round and never touched the live one
      expect(await griddy.currentRoundId()).to.equal(idB);
      const bMid = await griddy.rounds(idB);
      expect(bMid.resolved).to.equal(false);
      expect(bMid.endTime).to.equal(B_END);
      expect(bMid.totalStaked).to.equal(2n * 10n ** 17n);

      // betting continues in B after A resolved
      await stakeAt(griddy, carol, T10M + 5n, idB, [7], [4n * 10n ** 16n]);
      expect(await griddy.totalUnresolvedStakes()).to.equal(24n * 10n ** 16n);

      // B cannot be resolved before its window closes
      await time.setNextBlockTimestamp(T10M + 6n);
      await expect(griddy.connect(dave).resolveRound(idB, SIG_ROUND_B))
        .to.be.revertedWith("Round not ended");

      // resolve B (any resolver) — pro-rata split exact to the wei
      const bobBefore = await ethers.provider.getBalance(bob.address);
      const carolBefore = await ethers.provider.getBalance(carol.address);
      await time.setNextBlockTimestamp(B_END + 1n);
      await griddy.connect(dave).resolveRound(idB, SIG_ROUND_B);

      const poolB = 24n * 10n ** 16n;
      const feeB = feeOf(poolB);
      const distB = poolB - feeB;
      const bobOut = (distB * (2n * 10n ** 17n)) / poolB;
      const carolOut = (distB * (4n * 10n ** 16n)) / poolB;
      expect((await griddy.rounds(idB)).winningCell).to.equal(7);
      expect(await ethers.provider.getBalance(bob.address)).to.equal(bobBefore + bobOut);
      expect(await ethers.provider.getBalance(carol.address)).to.equal(carolBefore + carolOut);
      expect(bobOut * 4n).to.equal(carolOut * 20n); // identical per-wei rate
      const dustB = distB - bobOut - carolOut;
      expect(await griddy.accumulatedFees()).to.equal(feeA - TIP + feeB - TIP + dustB);
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
      // resolving the CURRENT round opens no new round either
      expect(await griddy.currentRoundId()).to.equal(idB);

      // ATTACK: double-resolve both rounds
      await time.setNextBlockTimestamp(B_END + 2n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_10M)).to.be.revertedWith("Already resolved");
      await time.setNextBlockTimestamp(B_END + 3n);
      await expect(griddy.resolveRound(idB, SIG_ROUND_B)).to.be.revertedWith("Already resolved");
    });

    it("resolves in the reverse order — newest first, oldest after", async () => {
      const { alice, bob, dave, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      const idB = await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);

      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const bobBefore = await ethers.provider.getBalance(bob.address);

      await time.setNextBlockTimestamp(B_END + 1n);
      await griddy.connect(dave).resolveRound(idB, SIG_ROUND_B);
      const distB = 2n * 10n ** 17n - feeOf(2n * 10n ** 17n);
      expect(await ethers.provider.getBalance(bob.address)).to.equal(bobBefore + distB);
      expect(await griddy.totalUnresolvedStakes()).to.equal(10n ** 17n);

      await time.setNextBlockTimestamp(B_END + 2n);
      await griddy.connect(dave).resolveRound(idA, SIG_ROUND_10M);
      const distA = 10n ** 17n - feeOf(10n ** 17n);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(aliceBefore + distA);
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
      expect((await griddy.rounds(idA)).resolved).to.equal(true);
      expect((await griddy.rounds(idB)).resolved).to.equal(true);
    });

    it("ATTACK: a beacon signature for a different drand round resolves nothing", async () => {
      const { alice, bob, beacon, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      const idB = await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);

      // cross-play the two real signatures
      await time.setNextBlockTimestamp(B_END + 1n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_B))
        .to.be.revertedWithCustomError(beacon, "InvalidSignature");
      await time.setNextBlockTimestamp(B_END + 2n);
      await expect(griddy.resolveRound(idB, SIG_ROUND_10M))
        .to.be.revertedWithCustomError(beacon, "InvalidSignature");

      // the correct signatures still work afterwards
      await time.setNextBlockTimestamp(B_END + 3n);
      await griddy.resolveRound(idA, SIG_ROUND_10M);
      await time.setNextBlockTimestamp(B_END + 4n);
      await griddy.resolveRound(idB, SIG_ROUND_B);
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
    });

    it("ATTACK: no stake can land in an already-resolved round — the next one rolls instead", async () => {
      const { owner, alice, bob, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      await time.setNextBlockTimestamp(T10M + 1n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);
      expect(await griddy.currentRoundId()).to.equal(idA); // still the current id
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);

      // topping up the settled pot would inflate the accumulator with money
      // that can never be resolved out of it
      await time.setNextBlockTimestamp(T10M + 2n);
      await expect(
        griddy.connect(bob).stake(idA, [3], [10n ** 17n], { value: 10n ** 17n })
      ).to.be.revertedWith("Wrong round");
      expect((await griddy.rounds(idA)).totalStaked).to.equal(10n ** 17n);

      // the honest next id opens a fresh window
      await time.setNextBlockTimestamp(T10M + 3n);
      await griddy.connect(bob).stake(idA + 1n, [3], [10n ** 17n], { value: 10n ** 17n });
      expect((await griddy.rounds(idA + 1n)).startTime).to.equal(T10M + 3n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(10n ** 17n);
      // the contract still holds exactly stakes + fees
      expect(await ethers.provider.getBalance(await griddy.getAddress())).to.equal(
        10n ** 17n + (await griddy.accumulatedFees()));
    });

    it("ATTACK: cannot resolve a round id that does not exist yet", async () => {
      const { alice, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      await time.setNextBlockTimestamp(T10M + 1n);
      await expect(griddy.resolveRound(idA + 1n, SIG_ROUND_10M)).to.be.revertedWith("Wrong round");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 4. Solvency — the owner can never touch player money
  // ════════════════════════════════════════════════════════════

  describe("solvency", () => {
    it("ATTACK: with two staked unresolved rounds, sweepSurplus reverts and takes nothing", async () => {
      const { owner, alice, bob, griddy } = await deployV5();
      await openRoundA(griddy, alice, [3], [3n * 10n ** 17n]);
      await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);
      const gAddr = await griddy.getAddress();
      expect(await ethers.provider.getBalance(gAddr)).to.equal(5n * 10n ** 17n);

      // while B is live: the V4 formula would already reserve B, so the real
      // target is A's ended-but-unresolved pot
      await time.setNextBlockTimestamp(T10M + 1n);
      await expect(griddy.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");

      // after BOTH rounds ended, still unresolved: under V4's formula
      // (currentRound.totalStaked only) the owner could have swept A's 0.3
      await time.setNextBlockTimestamp(B_END + 1n);
      await expect(griddy.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");

      expect(await ethers.provider.getBalance(gAddr)).to.equal(5n * 10n ** 17n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(5n * 10n ** 17n);
    });

    it("ATTACK: sweepSurplus after a stray donation takes EXACTLY the stray — both rounds then pay in full", async () => {
      const { owner, alice, bob, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [3], [3n * 10n ** 17n]);
      const idB = await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);
      const gAddr = await griddy.getAddress();

      const stray = 10n ** 16n;
      await time.setNextBlockTimestamp(B_END + 1n);
      await owner.sendTransaction({ to: gAddr, value: stray });

      const before = await ethers.provider.getBalance(owner.address);
      await time.setNextBlockTimestamp(B_END + 2n);
      const tx = await griddy.connect(owner).sweepSurplus();
      const rc = await tx.wait();
      expect(await ethers.provider.getBalance(owner.address)).to.equal(
        before + stray - rc!.gasUsed * rc!.gasPrice);
      expect(await ethers.provider.getBalance(gAddr)).to.equal(5n * 10n ** 17n);

      // every staked wei is still there: both rounds resolve and pay exactly
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const bobBefore = await ethers.provider.getBalance(bob.address);
      await time.setNextBlockTimestamp(B_END + 3n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);
      await time.setNextBlockTimestamp(B_END + 4n);
      await griddy.connect(owner).resolveRound(idB, SIG_ROUND_B);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        aliceBefore + 3n * 10n ** 17n - feeOf(3n * 10n ** 17n));
      expect(await ethers.provider.getBalance(bob.address)).to.equal(
        bobBefore + 2n * 10n ** 17n - feeOf(2n * 10n ** 17n));
      // pot conservation: what remains is exactly the retained fees
      expect(await ethers.provider.getBalance(gAddr)).to.equal(await griddy.accumulatedFees());
    });

    it("full solvency invariant: 2 pending rounds + escrowed winnings + fees + void refunds — every claim unwinds to the exact wei", async () => {
      const { owner, bob, carol, griddy } = await deployV5();
      const gAddr = await griddy.getAddress();
      const RR = await ethers.getContractFactory("RevertingReceiver");
      const rr = await RR.deploy();

      // round A: a winner whose receive() reverts → escrow path
      await time.setNextBlockTimestamp(A_OPEN);
      await rr.stakeVia(gAddr, 2, 0, { value: 10n ** 17n }); // lazily opens round 2
      expect((await griddy.rounds(2n)).drandRound).to.equal(ROUND_10M);
      // round B opens with bob's stake
      await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);

      // resolve A: 95% escrowed to the reverting winner, fee minus tip retained
      await time.setNextBlockTimestamp(T10M + 1n);
      await expect(griddy.connect(owner).resolveRound(2n, SIG_ROUND_10M))
        .to.emit(griddy, "WinningsEscrowed");
      const escrowed = 10n ** 17n - feeOf(10n ** 17n);
      expect(await griddy.unclaimedWinnings(await rr.getAddress())).to.equal(escrowed);
      expect(await griddy.pendingWithdrawals()).to.equal(escrowed);

      // round C opens past B's end — B and C both staked and pending
      await stakeAt(griddy, carol, T10M + 35n, 4n, [11], [15n * 10n ** 16n]);
      expect(await griddy.totalUnresolvedStakes()).to.equal(35n * 10n ** 16n);

      // reserved == balance to the exact wei: nothing is sweepable
      const bal1 = await ethers.provider.getBalance(gAddr);
      expect(bal1).to.equal(await reservedOf(griddy));
      await time.setNextBlockTimestamp(T10M + 36n);
      await expect(griddy.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");

      // void B (drand "outage"): refunds owed, accumulator decremented
      const reqT = B_END + REFUND_DELAY + 1n;
      await time.setNextBlockTimestamp(reqT);
      await griddy.connect(bob).requestVoid(3n);
      const voidT = reqT + VOID_GRACE + 1n;
      await time.setNextBlockTimestamp(voidT);
      await griddy.connect(bob).voidStuckRound(3n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(15n * 10n ** 16n);
      expect(await griddy.pendingRefunds()).to.equal(2n * 10n ** 17n);

      await time.setNextBlockTimestamp(voidT + 1n);
      await expect(griddy.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");

      // unwind every claim: refund, escrow withdrawal, fee withdrawal
      const bobBefore = await ethers.provider.getBalance(bob.address);
      await time.setNextBlockTimestamp(voidT + 2n);
      const tx = await griddy.connect(bob).refund(3n);
      const rc = await tx.wait();
      expect(await ethers.provider.getBalance(bob.address)).to.equal(
        bobBefore + 2n * 10n ** 17n - rc!.gasUsed * rc!.gasPrice);
      await time.setNextBlockTimestamp(voidT + 3n);
      await rr.withdrawVia(gAddr);
      await time.setNextBlockTimestamp(voidT + 4n);
      await griddy.connect(owner).withdrawFees();

      // what remains is round C's stakes — exactly, to the wei
      expect(await griddy.pendingRefunds()).to.equal(0n);
      expect(await griddy.pendingWithdrawals()).to.equal(0n);
      expect(await griddy.accumulatedFees()).to.equal(0n);
      expect(await ethers.provider.getBalance(gAddr)).to.equal(15n * 10n ** 16n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(15n * 10n ** 16n);
      await time.setNextBlockTimestamp(voidT + 5n);
      await expect(griddy.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 5. Empty rounds
  // ════════════════════════════════════════════════════════════

  describe("empty rounds", () => {
    it("an ended empty round needs no tx — the next stake rolls past it; skipEmptyRound stays optional hygiene", async () => {
      const { alice, griddy } = await deployV5();
      // round 1 (deploy-time) expired empty long ago; alice's stake rolls past
      // it with no skip tx and creates exactly one round
      const id = await openRoundA(griddy, alice, [0], [10n ** 17n]);
      expect(id).to.equal(2n);
      expect(await griddy.currentRoundId()).to.equal(2n);
      const empty = await griddy.rounds(1n);
      expect(empty.resolved).to.equal(false);
      expect(empty.totalStakers).to.equal(0n);

      // the empty round can never mimic a payable round
      await time.setNextBlockTimestamp(A_OPEN + 1n);
      await expect(griddy.resolveRound(1n, SIG_ROUND_1)).to.be.revertedWith("Use skipEmptyRound");

      // optional hygiene still works on the old id...
      await time.setNextBlockTimestamp(A_OPEN + 2n);
      await expect(griddy.skipEmptyRound(1n)).to.emit(griddy, "EmptyRoundSkipped").withArgs(1n);
      expect((await griddy.rounds(1n)).resolved).to.equal(true);
      // ...but only once, never on future ids, never on staked rounds
      await time.setNextBlockTimestamp(A_OPEN + 3n);
      await expect(griddy.skipEmptyRound(1n)).to.be.revertedWith("Already resolved");
      await time.setNextBlockTimestamp(A_OPEN + 4n);
      await expect(griddy.skipEmptyRound(3n)).to.be.revertedWith("Wrong round");
      await time.setNextBlockTimestamp(T10M + 1n);
      await expect(griddy.skipEmptyRound(2n)).to.be.revertedWith("Has stakers");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 6. Void / repin on non-current rounds
  // ════════════════════════════════════════════════════════════

  describe("void & repin on old rounds", () => {
    it("voids an old stuck round while betting continues — exact refunds, accumulator decremented, pause per V4", async () => {
      const { owner, alice, bob, carol, dave, griddy } = await deployV5();
      // round A: alice multi-cell + bob
      const idA = await openRoundA(griddy, alice, [1, 2], [10n ** 16n, 4n * 10n ** 16n]);
      await stakeAt(griddy, bob, A_END - 20n, idA, [3], [2n * 10n ** 16n]);
      // round B keeps the game going
      const idB = await rollToRoundB(griddy, carol, [7], [2n * 10n ** 17n]);

      // too early to void
      await time.setNextBlockTimestamp(T10M + 1n);
      await expect(griddy.requestVoid(idA)).to.be.revertedWith("Not stuck");

      const reqT = A_END + REFUND_DELAY + 1n;
      await time.setNextBlockTimestamp(reqT);
      await griddy.connect(alice).requestVoid(idA);
      await time.setNextBlockTimestamp(reqT + 5n);
      await expect(griddy.requestVoid(idA)).to.be.revertedWith("Already requested");

      // betting continues in a fresh round while the void request matures
      await stakeAt(griddy, dave, reqT + 10n, idB + 1n, [5], [10n ** 17n]);
      expect(await griddy.currentRoundId()).to.equal(idB + 1n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(37n * 10n ** 16n);

      // grace not over yet
      await time.setNextBlockTimestamp(reqT + 11n);
      await expect(griddy.voidStuckRound(idA)).to.be.revertedWith("Grace not over");

      const voidT = reqT + VOID_GRACE + 1n;
      await time.setNextBlockTimestamp(voidT);
      await expect(griddy.connect(bob).voidStuckRound(idA))
        .to.emit(griddy, "RoundVoided").withArgs(idA)
        .and.to.emit(griddy, "PausedSet").withArgs(true);

      // A's pot left the accumulator and became refunds; the game paused
      expect(await griddy.totalUnresolvedStakes()).to.equal(3n * 10n ** 17n);
      expect(await griddy.pendingRefunds()).to.equal(7n * 10n ** 16n);
      expect(await griddy.paused()).to.equal(true);
      await time.setNextBlockTimestamp(voidT + 1n);
      await expect(
        griddy.connect(dave).stake(idB + 2n, [0], [MIN_STAKE], { value: MIN_STAKE })
      ).to.be.revertedWith("Paused");

      // ATTACK: the voided round can never be voided or resolved again
      await time.setNextBlockTimestamp(voidT + 2n);
      await expect(griddy.voidStuckRound(idA)).to.be.revertedWith("Already resolved");
      await time.setNextBlockTimestamp(voidT + 3n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_10M)).to.be.revertedWith("Already resolved");

      // refunds are exact per player, once, and only for entrants of the voided round
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      await time.setNextBlockTimestamp(voidT + 4n);
      const tx1 = await griddy.connect(alice).refund(idA);
      const rc1 = await tx1.wait();
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        aliceBefore + 5n * 10n ** 16n - rc1!.gasUsed * rc1!.gasPrice);
      const bobBefore = await ethers.provider.getBalance(bob.address);
      await time.setNextBlockTimestamp(voidT + 5n);
      const tx2 = await griddy.connect(bob).refund(idA);
      const rc2 = await tx2.wait();
      expect(await ethers.provider.getBalance(bob.address)).to.equal(
        bobBefore + 2n * 10n ** 16n - rc2!.gasUsed * rc2!.gasPrice);
      expect(await griddy.pendingRefunds()).to.equal(0n);
      await expect(griddy.connect(alice).refund(idA)).to.be.revertedWith("Already refunded");
      await expect(griddy.connect(carol).refund(idA)).to.be.revertedWith("Not entered");
      await expect(griddy.connect(carol).refund(idB)).to.be.revertedWith("Not voided");

      // owner unpauses; betting rolls on
      await griddy.connect(owner).setPaused(false);
      await stakeAt(griddy, dave, voidT + 10n, idB + 2n, [0], [MIN_STAKE]);
      expect(await griddy.currentRoundId()).to.equal(idB + 2n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(3n * 10n ** 17n + MIN_STAKE);
    });

    it("repinRound moves an old round's pin forward — owner-only, overdue-only", async () => {
      const { owner, alice, bob, beacon, griddy } = await deployV5();
      const idA = await openRoundA(griddy, alice, [0], [10n ** 17n]);
      const idB = await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);

      // not overdue yet (REPIN_TIMEOUT after the pinned beacon's emit time)
      await time.setNextBlockTimestamp(T10M + 100n);
      await expect(griddy.connect(owner).repinRound(idA)).to.be.revertedWith("Beacon not overdue");
      // never permissionless
      await time.setNextBlockTimestamp(T10M + 101n);
      await expect(griddy.connect(alice).repinRound(idA))
        .to.be.revertedWithCustomError(griddy, "OwnableUnauthorizedAccount");

      const late = T10M + REPIN_TIMEOUT + 1n;
      const expected = roundAtTs(late + BEACON_GAP);
      await time.setNextBlockTimestamp(late);
      await expect(griddy.connect(owner).repinRound(idA))
        .to.emit(griddy, "RoundRepinned").withArgs(idA, ROUND_10M, expected);
      expect((await griddy.rounds(idA)).drandRound).to.equal(expected);
      // the newer round's pin is untouched
      expect((await griddy.rounds(idB)).drandRound).to.equal(ROUND_B);

      // ATTACK: the already-published beacon can no longer settle the round
      await time.setNextBlockTimestamp(late + 1n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_10M))
        .to.be.revertedWithCustomError(beacon, "InvalidSignature");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 7. Config bounds
  // ════════════════════════════════════════════════════════════

  describe("config", () => {
    it("beaconGap floor is 3 seconds: 3 ok, 2 rejected, owner-only", async () => {
      const { owner, alice, griddy } = await deployV5();
      await expect(griddy.connect(owner).setBeaconGap(2n)).to.be.revertedWith("3-60s");
      await expect(griddy.connect(owner).setBeaconGap(61n)).to.be.revertedWith("3-60s");
      await expect(griddy.connect(alice).setBeaconGap(3n))
        .to.be.revertedWithCustomError(griddy, "OwnableUnauthorizedAccount");
      await expect(griddy.connect(owner).setBeaconGap(3n))
        .to.emit(griddy, "ConfigUpdated").withArgs("beaconGap", 3n);
      expect(await griddy.beaconGap()).to.equal(3n);
    });

    it("at the 3s floor a lazily rolled round is still stakeable and settles on its pinned beacon", async () => {
      const { owner, alice, griddy } = await deployV5();
      await griddy.connect(owner).setBeaconGap(3n);
      // opening 33s before the emit pins to ROUND_10M with a 3s gap
      const start = T10M - 33n;
      await time.setNextBlockTimestamp(start);
      await griddy.connect(alice).stake(2n, [3], [10n ** 17n], { value: 10n ** 17n });
      const r = await griddy.rounds(2n);
      expect(r.drandRound).to.equal(ROUND_10M);
      expect(r.startTime).to.equal(start);
      expect(r.endTime).to.equal(T10M - 3n);   // betting still closes before the emit
      expect(r.endTime).to.be.greaterThan(r.startTime);

      const before = await ethers.provider.getBalance(alice.address);
      await time.setNextBlockTimestamp(T10M + 1n);
      await griddy.connect(owner).resolveRound(2n, SIG_ROUND_10M);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        before + 10n ** 17n - feeOf(10n ** 17n));
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
    });
  });
});

// ════════════════════════════════════════════════════════════
// 8. DrandBeaconV2 — the UUPS beacon
// ════════════════════════════════════════════════════════════

describe("DrandBeaconV2 — UUPS beacon, real evmnet fixtures", () => {
  beforeEach(async () => { await reset(); });

  async function deployBeaconV2() {
    const [owner, alice] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DrandBeaconV2");
    const beaconV2 = await upgrades.deployProxy(
      F, [owner.address, EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD], { kind: "uups" });
    return { owner, alice, beaconV2 };
  }

  it("deploys behind a UUPS proxy and verifies the real beacon fixtures", async () => {
    const { beaconV2 } = await deployBeaconV2();
    const pk = await beaconV2.publicKey();
    expect(pk[0]).to.equal(EVMNET_PUBKEY[0]);
    await expect(beaconV2.verifyBeaconRound(1, SIG_ROUND_1)).to.not.be.reverted;
    await expect(beaconV2.verifyBeaconRound(ROUND_10M, SIG_ROUND_10M)).to.not.be.reverted;
    // schedule matches the immutable V1 beacon's
    expect(await beaconV2.timeOfRound(ROUND_10M)).to.equal(T10M);
    expect(await beaconV2.roundAt(EVMNET_GENESIS + 4n)).to.equal(3n);
  });

  it("ATTACK: rejects wrong-round and tampered signatures", async () => {
    const { beaconV2 } = await deployBeaconV2();
    await expect(beaconV2.verifyBeaconRound(2, SIG_ROUND_1))
      .to.be.revertedWithCustomError(beaconV2, "InvalidSignature");
    await expect(beaconV2.verifyBeaconRound(ROUND_B, SIG_ROUND_10M))
      .to.be.revertedWithCustomError(beaconV2, "InvalidSignature");
    const tampered: [bigint, bigint] = [SIG_ROUND_1[0] + 1n, SIG_ROUND_1[1]];
    await expect(beaconV2.verifyBeaconRound(1, tampered))
      .to.be.revertedWithCustomError(beaconV2, "InvalidSignature");
  });

  it("ATTACK: the initializer cannot rerun, on the proxy or the implementation", async () => {
    const { owner, alice, beaconV2 } = await deployBeaconV2();
    await expect(
      beaconV2.connect(alice).initialize(alice.address, EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD)
    ).to.be.revertedWithCustomError(beaconV2, "InvalidInitialization");
    const implAddr = await upgrades.erc1967.getImplementationAddress(await beaconV2.getAddress());
    const impl = await ethers.getContractAt("DrandBeaconV2", implAddr);
    await expect(
      impl.initialize(owner.address, EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD)
    ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
  });

  it("ATTACK: non-owner cannot upgrade; the owner can", async () => {
    const { owner, alice, beaconV2 } = await deployBeaconV2();
    const implAddr = await upgrades.erc1967.getImplementationAddress(await beaconV2.getAddress());
    await expect(beaconV2.connect(alice).upgradeToAndCall(implAddr, "0x"))
      .to.be.revertedWithCustomError(beaconV2, "OwnableUnauthorizedAccount");
    await beaconV2.connect(owner).upgradeToAndCall(implAddr, "0x");
    await expect(beaconV2.verifyBeaconRound(1, SIG_ROUND_1)).to.not.be.reverted;
  });

  it("ATTACK: rejects an invalid public key at initialize", async () => {
    const [owner] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DrandBeaconV2");
    const bad = [...EVMNET_PUBKEY] as [bigint, bigint, bigint, bigint];
    bad[0] = bad[0] + 1n;
    let failed = false;
    try {
      await upgrades.deployProxy(F, [owner.address, bad, EVMNET_GENESIS, EVMNET_PERIOD], { kind: "uups" });
    } catch {
      failed = true;
    }
    expect(failed, "deploy with an invalid pubkey must revert").to.equal(true);
  });

  it("plugs into GriddyV5 via setBeacon and settles a live round", async () => {
    const [owner, alice] = await ethers.getSigners();
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beaconV1 = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
    const V5 = await ethers.getContractFactory("GriddyV5");
    const griddy = await upgrades.deployProxy(
      V5, [owner.address, await beaconV1.getAddress(), owner.address], { kind: "uups" });
    const F = await ethers.getContractFactory("DrandBeaconV2");
    const beaconV2 = await upgrades.deployProxy(
      F, [owner.address, EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD], { kind: "uups" });
    const b2 = await beaconV2.getAddress();

    await expect(griddy.connect(alice).setBeacon(b2))
      .to.be.revertedWithCustomError(griddy, "OwnableUnauthorizedAccount");
    await expect(griddy.connect(owner).setBeacon(b2))
      .to.emit(griddy, "BeaconUpdated").withArgs(await beaconV1.getAddress(), b2);
    expect(await griddy.beacon()).to.equal(b2);

    // lazy roll pins through the V2 beacon's schedule, then resolves against it
    await time.setNextBlockTimestamp(A_OPEN);
    await griddy.connect(alice).stake(2n, [3], [10n ** 17n], { value: 10n ** 17n });
    expect((await griddy.rounds(2n)).drandRound).to.equal(ROUND_10M);

    const before = await ethers.provider.getBalance(alice.address);
    await time.setNextBlockTimestamp(T10M + 1n);
    await griddy.connect(owner).resolveRound(2n, SIG_ROUND_10M);
    const dist = 10n ** 17n - feeOf(10n ** 17n);
    expect((await griddy.rounds(2n)).resolved).to.equal(true);
    expect(await ethers.provider.getBalance(alice.address)).to.equal(before + dist);
  });
});
