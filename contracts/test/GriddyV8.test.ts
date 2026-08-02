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
const REFUND_DELAY = 30n * 24n * 3600n;
const VOID_GRACE = 3n * 24n * 3600n;
const REPIN_TIMEOUT = 6n * 3600n;
// The default roundDuration — under V8 this is the length of EVERY round, and
// only the grid step the idle lobby clock ticks on.
const DUR = 30n;
const MIN_BET_WINDOW = 6n;

// ─── beacon schedule replicas (valid for t > genesis) ───
const timeOfRoundTs = (r: bigint) => EVMNET_GENESIS + (r - 1n) * EVMNET_PERIOD;
const roundAtTs = (t: bigint) => (t - EVMNET_GENESIS + EVMNET_PERIOD - 1n) / EVMNET_PERIOD + 1n;

// V8 fixtures: a round opened at A_OPEN runs a FULL 30s to A_END and pins
// exactly drand ROUND_10M (A_END + beaconGap 10 lands on its emit). A stake at
// B_ROLL (round A already closed) opens the next full 30s round, pinned to
// ROUND_B. Both are grid-independent: the window is measured from the stake.
const T10M = timeOfRoundTs(ROUND_10M);
const TB = timeOfRoundTs(ROUND_B);
const A_OPEN = T10M - 40n;
const A_END = A_OPEN + DUR;         // T10M - 10
const B_ROLL = T10M - 2n;
const B_END = B_ROLL + DUR;         // T10M + 28

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

// ─── grid replica (mirrors _windowOf — the idle lobby clock only) ───
const gridStart = (epoch: bigint, t: bigint, d = DUR) =>
  t > epoch ? epoch + ((t - epoch) / d) * d : epoch;

describe("GriddyV8 — every round runs the FULL roundDuration", () => {
  // own chain state: fixtures pin real historical beacon rounds
  beforeEach(async () => { await reset(); });

  async function deployBeacon() {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    return Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  }

  /** The live proxy's current shape: V7 behind UUPS, grid-aligned windows. */
  async function deployV7() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const beacon = await deployBeacon();
    const V7 = await ethers.getContractFactory("GriddyV7");
    const griddy: any = await upgrades.deployProxy(
      V7, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    return { owner, alice, bob, carol, dave, beacon, griddy, epoch: await griddy.roundEpoch() };
  }

  /** The upgrade under test: V7 proxy → V8. Pure logic change, NO initializer. */
  async function upgradeToV8(griddy: any): Promise<any> {
    const V8 = await ethers.getContractFactory("GriddyV8");
    return upgrades.upgradeProxy(await griddy.getAddress(), V8);
  }

  /** A fresh V8 deployment: initialize() anchors the lobby grid and opens a
   *  first round that is itself a full roundDuration long. */
  async function deployV8() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const beacon = await deployBeacon();
    const V8 = await ethers.getContractFactory("GriddyV8");
    const griddy: any = await upgrades.deployProxy(
      V8, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    const epoch = await griddy.roundEpoch();
    expect(epoch).to.equal(BigInt(await time.latest()));
    const first = await griddy.rounds(1n);
    // even the deploy-time round is full length
    expect(first.endTime - first.startTime).to.equal(DUR);
    return { owner, alice, bob, carol, dave, beacon, griddy, epoch };
  }

  async function stakeAt(griddy: any, signer: any, ts: bigint, id: bigint, cells: number[], amounts: bigint[]) {
    await time.setNextBlockTimestamp(ts);
    const value = amounts.reduce((a, b) => a + b, 0n);
    return griddy.connect(signer).stake(id, cells, amounts, { value });
  }

  /** Opens a fresh round at `ts` and returns its id (previous round must have
   *  closed). Asserts the V8 invariant on the way out: FULL length, always. */
  async function openRoundAt(griddy: any, signer: any, ts: bigint, cells: number[], amounts: bigint[]) {
    const id = (await griddy.currentRoundId()) + 1n;
    await stakeAt(griddy, signer, ts, id, cells, amounts);
    const r = await griddy.rounds(id);
    expect(r.startTime).to.equal(ts);
    expect(r.endTime - r.startTime).to.equal(await griddy.roundDuration());
    return id;
  }

  const reservedOf = async (g: any) =>
    (await g.totalUnresolvedStakes()) + (await g.pendingRefunds())
    + (await g.pendingWithdrawals()) + (await g.accumulatedFees());

  // ════════════════════════════════════════════════════════════
  // 1. Upgrade: live V7 money in flight → V8
  // ════════════════════════════════════════════════════════════

  describe("upgrade V7 → V8", () => {
    /** V7's grid sits wherever the proxy was deployed, so the two real drand
     *  fixtures are aimed at with beaconGap instead of by moving the grid.
     *  endA is the last grid boundary before ROUND_10M is emitted; endB is the
     *  one boundary inside [T10M+7, T10M+36] — late enough that round B is
     *  still live while A is resolved and the upgrade lands. */
    function v7GridOntoBeacons(epoch: bigint) {
      const endA = gridStart(epoch, T10M - 3n);
      const gapA = T10M - endA;
      const endB = gridStart(epoch, T10M + 36n);
      const gapB = TB - endB;
      expect(gapA).to.be.greaterThanOrEqual(3n);
      expect(gapA).to.be.lessThanOrEqual(60n);
      expect(endB).to.be.greaterThanOrEqual(T10M + 7n);
      expect(gapB).to.be.greaterThanOrEqual(3n);
      expect(gapB).to.be.lessThanOrEqual(60n);
      expect(endB - endA).to.be.greaterThanOrEqual(DUR);
      return { endA, gapA, endB, gapB };
    }

    it("preserves every slot across a live staked round, the in-flight (truncated) V7 round still resolves with exact math, and every round after is full length", async () => {
      const { owner, alice, bob, carol, beacon, griddy, epoch } = await deployV7();
      const proxy = await griddy.getAddress();
      const { endA, gapA, endB, gapB } = v7GridOntoBeacons(epoch);

      // ── round A under V7 rules: grid-aligned, pinned to drand ROUND_10M ──
      await time.setNextBlockTimestamp(endA - 40n);
      await griddy.connect(owner).setBeaconGap(gapA);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, endA - 20n, idA, [3], [3n * 10n ** 17n]);
      expect((await griddy.rounds(idA)).endTime).to.equal(endA);
      expect((await griddy.rounds(idA)).drandRound).to.equal(ROUND_10M);

      // ── round B: staked, still open for betting when the upgrade lands ──
      await time.setNextBlockTimestamp(endA - 10n);
      await griddy.connect(owner).setBeaconGap(gapB);
      const idB = idA + 1n;
      await stakeAt(griddy, bob, endB - 20n, idB, [7], [2n * 10n ** 17n]);
      await stakeAt(griddy, carol, endB - 18n, idB, [11], [3n * 10n ** 17n]);
      expect((await griddy.rounds(idB)).drandRound).to.equal(ROUND_B);
      // THE SYMPTOM being fixed: bob opened B 20 seconds before a boundary and
      // V7 handed him a 20-second round instead of a 30-second one.
      expect((await griddy.rounds(idB)).endTime).to.equal(endB);
      expect((await griddy.rounds(idB)).endTime - (await griddy.rounds(idB)).startTime).to.equal(20n);

      // ── A resolves under V7 (real beacon already emitted), leaving fees ──
      const tResolveA = T10M + 1n > endB - 16n ? T10M + 1n : endB - 16n;
      await time.setNextBlockTimestamp(tResolveA);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);

      const potB = 5n * 10n ** 17n;
      const before = {
        roundId: await griddy.currentRoundId(),
        pot: (await griddy.rounds(idB)).totalStaked,
        stakers: (await griddy.rounds(idB)).totalStakers,
        startTime: (await griddy.rounds(idB)).startTime,
        endTime: (await griddy.rounds(idB)).endTime,
        drandRound: (await griddy.rounds(idB)).drandRound,
        fees: await griddy.accumulatedFees(),
        unresolved: await griddy.totalUnresolvedStakes(),
        owner: await griddy.owner(),
        beacon: await griddy.beacon(),
        minStake: await griddy.minStakeWei(),
        tip: await griddy.resolverTipWei(),
        feeBps: await griddy.protocolFeeBps(),
        duration: await griddy.roundDuration(),
        gap: await griddy.beaconGap(),
        epoch: await griddy.roundEpoch(),
        balance: await ethers.provider.getBalance(proxy),
      };
      expect(before.fees).to.equal(feeOf(3n * 10n ** 17n) - TIP);
      expect(before.unresolved).to.equal(potB);
      const implBefore = await upgrades.erc1967.getImplementationAddress(proxy);

      // ── UPGRADE (no initializer: V8 appends no storage) ──
      const v8 = await upgradeToV8(griddy);
      expect(await v8.getAddress()).to.equal(proxy);
      expect(await upgrades.erc1967.getImplementationAddress(proxy)).to.not.equal(implBefore);

      // every value the proxy held is untouched — roundEpoch included
      expect(await v8.roundEpoch()).to.equal(before.epoch);
      expect(await v8.currentRoundId()).to.equal(before.roundId);
      expect((await v8.rounds(idB)).totalStaked).to.equal(before.pot);
      expect((await v8.rounds(idB)).totalStakers).to.equal(before.stakers);
      expect((await v8.rounds(idB)).startTime).to.equal(before.startTime);
      expect((await v8.rounds(idB)).endTime).to.equal(before.endTime);
      expect((await v8.rounds(idB)).drandRound).to.equal(before.drandRound);
      expect(await v8.accumulatedFees()).to.equal(before.fees);
      expect(await v8.totalUnresolvedStakes()).to.equal(before.unresolved);
      expect(await v8.owner()).to.equal(before.owner);
      expect(await v8.beacon()).to.equal(before.beacon);
      expect(await v8.beacon()).to.equal(await beacon.getAddress());
      expect(await v8.minStakeWei()).to.equal(before.minStake);
      expect(await v8.minStakeWei()).to.equal(MIN_STAKE);
      expect(await v8.resolverTipWei()).to.equal(before.tip);
      expect(await v8.protocolFeeBps()).to.equal(before.feeBps);
      expect(await v8.roundDuration()).to.equal(before.duration);
      expect(await v8.beaconGap()).to.equal(before.gap);
      expect(await v8.MIN_BET_WINDOW()).to.equal(MIN_BET_WINDOW);
      expect(await v8.MIN_STAKE_HI()).to.equal(10n ** 18n);
      expect(await ethers.provider.getBalance(proxy)).to.equal(before.balance);
      // per-player positions and the settled round survive intact
      expect(await v8.stakeOf(idB, 7, bob.address)).to.equal(2n * 10n ** 17n);
      expect(await v8.stakeOf(idB, 11, carol.address)).to.equal(3n * 10n ** 17n);
      expect(await v8.playerTotalStaked(idB, carol.address)).to.equal(3n * 10n ** 17n);
      expect((await v8.rounds(idA)).resolved).to.equal(true);
      expect((await v8.rounds(idA)).distributable).to.equal(
        3n * 10n ** 17n - feeOf(3n * 10n ** 17n));

      // the in-flight V7 round keeps the (short) window it opened with: a stake
      // before its endTime still joins it, no roll, no re-pin
      await stakeAt(v8, alice, endB - 3n, idB, [7], [10n ** 16n]);
      expect(await v8.currentRoundId()).to.equal(before.roundId);
      expect((await v8.rounds(idB)).endTime).to.equal(before.endTime);
      expect((await v8.rounds(idB)).drandRound).to.equal(ROUND_B);

      // ...and it resolves under V8 with exactly V7's money math
      const potB2 = potB + 10n ** 16n;
      const totals = new Map<number, bigint>([
        [7, 2n * 10n ** 17n + 10n ** 16n], [11, 3n * 10n ** 17n],
      ]);
      const winCell = pickWinner(vrfFromSig(SIG_ROUND_B), totals, potB2);
      const dist = potB2 - feeOf(potB2);
      const bobBefore = await ethers.provider.getBalance(bob.address);
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const carolBefore = await ethers.provider.getBalance(carol.address);

      await time.setNextBlockTimestamp(TB + 1n);
      await v8.connect(owner).resolveRound(idB, SIG_ROUND_B);

      const r = await v8.rounds(idB);
      expect(r.winningCell).to.equal(winCell);
      expect(r.distributable).to.equal(dist);
      expect(r.winnerTotal).to.equal(totals.get(winCell));
      if (winCell === 7) {
        const bobOut = (dist * (2n * 10n ** 17n)) / totals.get(7)!;
        const aliceOut = (dist * (10n ** 16n)) / totals.get(7)!;
        expect(await ethers.provider.getBalance(bob.address)).to.equal(bobBefore + bobOut);
        expect(await ethers.provider.getBalance(alice.address)).to.equal(aliceBefore + aliceOut);
      } else {
        expect(await ethers.provider.getBalance(carol.address)).to.equal(carolBefore + dist);
      }
      expect(await v8.totalUnresolvedStakes()).to.equal(0n);
      // V5 semantics kept: resolution opens NO new round
      expect(await v8.currentRoundId()).to.equal(before.roundId);
      // pot conservation: what remains is exactly the retained fees plus dust
      expect(await ethers.provider.getBalance(proxy)).to.equal(await v8.accumulatedFees());

      // ── and from here on, EVERY round is full length wherever it opens ──
      const t = TB + 100n;
      const idNew = await openRoundAt(v8, alice, t, [0], [MIN_STAKE]);
      const fresh = await v8.rounds(idNew);
      expect(fresh.startTime).to.equal(t);
      expect(fresh.endTime).to.equal(t + DUR);
      expect(fresh.endTime - fresh.startTime).to.equal(DUR);
      // the lobby grid is still anchored where it always was — it just no
      // longer clips the round
      expect(await v8.roundEpoch()).to.equal(before.epoch);
    });

    it("storage-layout safety: the OZ validator accepts V7 → V8 as a no-append logic change", async () => {
      const { griddy } = await deployV7();
      const V6 = await ethers.getContractFactory("GriddyV6");
      const V7 = await ethers.getContractFactory("GriddyV7");
      const V8 = await ethers.getContractFactory("GriddyV8");
      // throws on any layout incompatibility — a silent pass is the assertion
      await upgrades.validateUpgrade(V7, V8, { kind: "uups" });
      await upgrades.validateUpgrade(V6, V8, { kind: "uups" });
      await upgrades.validateUpgrade(await griddy.getAddress(), V8, { kind: "uups" });
    });

    it("ATTACK: a non-owner cannot swing the proxy onto the V8 implementation", async () => {
      const { alice, griddy } = await deployV7();
      const V8 = await ethers.getContractFactory("GriddyV8");
      const rogueImpl = await V8.deploy();
      await rogueImpl.waitForDeployment();
      await expect(
        griddy.connect(alice).upgradeToAndCall(await rogueImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(griddy, "OwnableUnauthorizedAccount");
    });

    it("ATTACK: V8 adds no reinitializer, and the V7 anchor guard still refuses to re-phase the lobby grid", async () => {
      const { alice, carol, griddy, epoch } = await deployV7();
      const v8 = await upgradeToV8(griddy);
      expect(await v8.roundEpoch()).to.equal(epoch);

      // a live staked round, so a re-anchor would have something to disturb
      const t = epoch + 90n * DUR + 11n;
      const id = await openRoundAt(v8, alice, t, [3], [MIN_STAKE]);
      const live = await v8.rounds(id);

      // reinitializer(4) is unclaimed on a proxy first initialized by
      // initialize() — anyone may call it, and the roundEpoch != 0 guard is
      // the only thing standing between them and a shifted lobby clock
      await time.setNextBlockTimestamp(t + 5n);
      await v8.connect(carol).initializeV7();
      expect(await v8.roundEpoch()).to.equal(epoch);
      expect((await v8.rounds(id)).endTime).to.equal(live.endTime);
      expect((await v8.rounds(id)).endTime - (await v8.rounds(id)).startTime).to.equal(DUR);

      // never twice, and the older reinitializers stay spent
      await expect(v8.connect(carol).initializeV7())
        .to.be.revertedWithCustomError(v8, "InvalidInitialization");
      await expect(v8.initializeV5()).to.be.revertedWithCustomError(v8, "InvalidInitialization");
      await expect(v8.initializeV3()).to.be.revertedWithCustomError(v8, "InvalidInitialization");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 2. THE POINT: full-length rounds, wherever they open
  // ════════════════════════════════════════════════════════════

  describe("full-length rounds", () => {
    it("a round opened at ANY offset inside a grid window runs exactly roundDuration", async () => {
      const { alice, bob, griddy, epoch } = await deployV8();

      // every offset that mattered under V7: mid-window (truncated), the
      // MIN_BET_WINDOW edge (6s left → a 6-second round), just inside it
      // (5s left → rolled to a 35-second round) and 1s before the boundary
      const offsets = [0n, 1n, 3n, 7n, 15n, 20n, 24n, 25n, 28n, 29n];
      let k = 10n;
      for (const off of offsets) {
        const B = epoch + k * DUR;              // a grid boundary
        const t = B + off;
        const id = await openRoundAt(griddy, alice, t, [3], [MIN_STAKE]);
        const r = await griddy.rounds(id);

        // THE INVARIANT
        expect(r.endTime - r.startTime).to.equal(DUR);
        expect(r.startTime).to.equal(t);
        expect(r.endTime).to.equal(t + DUR);
        // the player who paid gets the whole clock, not a remainder
        expect((await griddy.getCurrentRound()).timeRemaining).to.equal(DUR);
        // the round now floats off the grid by exactly the offset it opened on
        expect((BigInt(r.endTime) - BigInt(epoch)) % DUR).to.equal(off);
        // and it stays usable to its last second: a joiner right before the
        // deadline lands in the SAME round
        await stakeAt(griddy, bob, t + DUR - 1n, id, [7], [MIN_STAKE]);
        expect(await griddy.currentRoundId()).to.equal(id);
        expect((await griddy.rounds(id)).totalStakers).to.equal(2n);
        k += 10n;
      }
    });

    it("a round opened 1 second before a grid boundary is NOT truncated", async () => {
      const { alice, griddy, epoch } = await deployV8();
      const B = epoch + 400n * DUR;
      const t = B - 1n;                       // one tick short of the boundary

      const id = await openRoundAt(griddy, alice, t, [3], [MIN_STAKE]);
      const r = await griddy.rounds(id);
      expect(r.endTime - r.startTime).to.equal(DUR);
      expect(r.endTime).to.equal(t + DUR);
      // it runs straight through the boundary V7 would have closed it on...
      expect(r.endTime).to.be.greaterThan(B);
      expect(r.endTime - B).to.equal(DUR - 1n);
      // ...and it is emphatically not the 1-second round the grid implied
      expect(r.endTime - r.startTime).to.be.greaterThan(MIN_BET_WINDOW);
      expect((await griddy.getCurrentRound()).timeRemaining).to.equal(DUR);
    });

    it("the V7 regression, side by side: the same 20s-into-the-window stake bought a 10s round on V7 and buys a full 30s round on V8", async () => {
      const [owner, alice] = await ethers.getSigners();
      const beacon = await deployBeacon();
      const bAddr = await beacon.getAddress();
      const V7 = await ethers.getContractFactory("GriddyV7");
      const V8 = await ethers.getContractFactory("GriddyV8");
      const v7: any = await upgrades.deployProxy(V7, [owner.address, bAddr, owner.address], { kind: "uups" });
      const v8: any = await upgrades.deployProxy(V8, [owner.address, bAddr, owner.address], { kind: "uups" });
      const e7 = await v7.roundEpoch();
      const e8 = await v8.roundEpoch();

      // V7: 20 seconds into a grid window → the round inherits the remainder
      const t7 = e7 + 200n * DUR + 20n;
      const id7 = (await v7.currentRoundId()) + 1n;
      await stakeAt(v7, alice, t7, id7, [3], [MIN_STAKE]);
      const r7 = await v7.rounds(id7);
      expect(r7.endTime - r7.startTime).to.equal(10n);      // the bug

      // V8: same offset into ITS grid → the full window
      const k = (t7 + 1n - BigInt(e8) - 20n + DUR - 1n) / DUR;   // first slot after t7
      const t8 = BigInt(e8) + k * DUR + 20n;
      expect(t8).to.be.greaterThan(t7);
      const id8 = (await v8.currentRoundId()) + 1n;
      await stakeAt(v8, alice, t8, id8, [3], [MIN_STAKE]);
      const r8 = await v8.rounds(id8);
      expect(r8.endTime - r8.startTime).to.equal(DUR);      // the fix
      expect(r8.endTime - r8.startTime).to.equal(
        (BigInt(r7.endTime) - BigInt(r7.startTime)) + 20n);
    });

    it("full length holds for every roundDuration the owner may set, and a live round keeps the length it opened with", async () => {
      const { owner, alice, griddy, epoch } = await deployV8();

      for (const [i, d] of [45n, 10n, 3600n, 60n].entries()) {
        const at = epoch + (600n + BigInt(i) * 200n) * DUR;
        await time.setNextBlockTimestamp(at);
        await expect(griddy.connect(owner).setRoundDuration(d))
          .to.emit(griddy, "ConfigUpdated").withArgs("roundDuration", d);
        const id = await openRoundAt(griddy, alice, at + 7n, [3], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect(r.endTime - r.startTime).to.equal(d);
        expect(r.endTime).to.equal(at + 7n + d);
      }

      // a duration change mid-round never re-cuts the live round
      const live = await griddy.rounds(await griddy.currentRoundId());
      await time.setNextBlockTimestamp(BigInt(live.startTime) + 10n);
      await griddy.connect(owner).setRoundDuration(10n);
      const same = await griddy.rounds(await griddy.currentRoundId());
      expect(same.endTime).to.equal(live.endTime);
      expect(same.endTime - same.startTime).to.equal(60n);

      // bounds still enforced, still owner-only
      await expect(griddy.connect(owner).setRoundDuration(9n)).to.be.revertedWith("10s-1h");
      await expect(griddy.connect(owner).setRoundDuration(3601n)).to.be.revertedWith("10s-1h");
      await expect(griddy.connect(alice).setRoundDuration(60n))
        .to.be.revertedWithCustomError(griddy, "OwnableUnauthorizedAccount");
    });

    it("back-to-back rounds each restart the whole clock — no drift, no inherited remainder", async () => {
      const { alice, griddy, epoch } = await deployV8();
      let t = epoch + 50n * DUR + 13n;
      let prevEnd = 0n;
      for (let i = 0; i < 5; i++) {
        const id = await openRoundAt(griddy, alice, t, [i], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect(r.endTime - r.startTime).to.equal(DUR);
        if (prevEnd !== 0n) expect(r.startTime).to.be.greaterThanOrEqual(prevEnd);
        prevEnd = r.endTime;
        // the very next second after the deadline opens a fresh FULL round
        t = r.endTime;
      }
      expect(await griddy.totalUnresolvedStakes()).to.equal(5n * MIN_STAKE);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 3. Fairness: the pin never exists while betting is open
  // ════════════════════════════════════════════════════════════

  describe("beacon fairness", () => {
    it("every full-length round pins a beacon emitted strictly AFTER its endTime, at every offset", async () => {
      const { alice, beacon, griddy, epoch } = await deployV8();
      const offsets = [0n, 1n, 11n, 24n, 25n, 29n];
      let k = 10n;
      let lastPin = 0n;
      for (const off of offsets) {
        const t = epoch + k * DUR + off;
        const id = await openRoundAt(griddy, alice, t, [3], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        const emit = await beacon.timeOfRound(r.drandRound);
        // betting must close before the randomness exists
        expect(emit).to.be.greaterThan(r.endTime);
        expect(emit).to.be.greaterThanOrEqual(BigInt(r.endTime) + BEACON_GAP);
        expect(r.drandRound).to.equal(roundAtTs(BigInt(r.endTime) + BEACON_GAP));
        // the pin only ever moves forward as rounds open
        expect(BigInt(r.drandRound)).to.be.greaterThan(lastPin);
        lastPin = BigInt(r.drandRound);
        k += 10n;
      }
    });

    it("the fairness invariant survives both beaconGap extremes and a long roundDuration", async () => {
      const { owner, alice, beacon, griddy, epoch } = await deployV8();
      let k = 10n;
      for (const [gap, dur] of [[3n, 10n], [60n, 30n], [3n, 3600n], [60n, 3600n]] as [bigint, bigint][]) {
        const at = epoch + k * 3600n;
        await time.setNextBlockTimestamp(at);
        await griddy.connect(owner).setBeaconGap(gap);
        await time.setNextBlockTimestamp(at + 1n);
        await griddy.connect(owner).setRoundDuration(dur);

        const id = await openRoundAt(griddy, alice, at + 2n, [3], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect(r.endTime - r.startTime).to.equal(dur);
        const emit = await beacon.timeOfRound(r.drandRound);
        expect(emit).to.be.greaterThan(r.endTime);
        expect(emit).to.be.greaterThanOrEqual(BigInt(r.endTime) + gap);
        k += 1n;
      }
      // the bounds themselves are unchanged
      await expect(griddy.connect(owner).setBeaconGap(2n)).to.be.revertedWith("3-60s");
      await expect(griddy.connect(owner).setBeaconGap(61n)).to.be.revertedWith("3-60s");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 4. The lobby clock (currentWindow) is still honest
  // ════════════════════════════════════════════════════════════

  describe("lobby clock", () => {
    it("keeps ticking on the grid with zero players and zero materialised rounds", async () => {
      const { griddy, epoch } = await deployV8();
      const gAddr = await griddy.getAddress();

      const B = epoch + 500n * DUR;
      await time.increaseTo(B + 1n);
      expect((await griddy.getCurrentRound()).timeRemaining).to.equal(0n);

      const w1 = await griddy.currentWindow();
      expect(w1.windowStart).to.equal(B);
      expect(w1.windowEnd).to.equal(B + DUR);
      expect(w1.secondsLeft).to.equal(DUR - 1n);
      expect(w1.drandRound).to.equal(roundAtTs(B + DUR + BEACON_GAP));

      await time.increaseTo(B + 1n + DUR);
      const w2 = await griddy.currentWindow();
      expect(w2.windowStart - w1.windowStart).to.equal(DUR);
      expect(w2.windowEnd - w1.windowEnd).to.equal(DUR);
      expect(w2.secondsLeft).to.equal(w1.secondsLeft);
      expect(w2.drandRound).to.be.greaterThan(w1.drandRound);

      await time.increaseTo(B + 1n + 100n * DUR);
      const w3 = await griddy.currentWindow();
      expect(w3.windowStart).to.equal(B + 100n * DUR);
      expect(w3.secondsLeft).to.equal(DUR - 1n);

      // none of that wrote a thing
      expect(await griddy.currentRoundId()).to.equal(1n);
      expect((await griddy.rounds(2n)).startTime).to.equal(0n);
      expect(await ethers.provider.getBalance(gAddr)).to.equal(0n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
    });

    it("the idle reading is a NEXT-TICK indicator, and the stake that follows always beats it", async () => {
      const { alice, griddy, epoch } = await deployV8();

      // stand mid-window: the lobby shows the tick, the stake buys a full round
      const B = epoch + 77n * DUR;
      await time.increaseTo(B + 4n);
      const w = await griddy.currentWindow();
      expect(w.windowEnd).to.equal(B + DUR);
      expect(w.secondsLeft).to.equal(DUR - 4n);

      const t = B + 5n;
      const id = await openRoundAt(griddy, alice, t, [3], [MIN_STAKE]);
      const r = await griddy.rounds(id);
      expect(r.endTime).to.equal(t + DUR);
      // the round the player actually got outlives the advertised tick
      expect(r.endTime).to.be.greaterThan(w.windowEnd);
      expect(BigInt(r.endTime) - BigInt(w.windowEnd)).to.equal(5n);

      // ...and while it is live, currentWindow reports the round's OWN
      // deadline and pin — the honest one a joiner would get
      const shown = await griddy.currentWindow();
      expect(shown.windowEnd).to.equal(r.endTime);
      expect(shown.drandRound).to.equal(r.drandRound);
      expect(shown.secondsLeft).to.equal(DUR);
      // the reported start is the grid slot the deadline falls in
      expect(shown.windowStart).to.equal(gridStart(epoch, BigInt(r.endTime) - 1n));
      expect(shown.windowEnd).to.be.greaterThan(shown.windowStart);

      // a later joiner reads the same live round, not a fresh tick
      await time.increaseTo(t + 20n);
      const shown2 = await griddy.currentWindow();
      expect(shown2.windowEnd).to.equal(r.endTime);
      expect(shown2.secondsLeft).to.equal(DUR - 20n);
      expect(await griddy.currentRoundId()).to.equal(id);
    });

    it("MIN_BET_WINDOW now only keeps the idle tick off a sliver — it can no longer shorten or delay a round", async () => {
      const { alice, griddy, epoch } = await deployV8();

      // 5 seconds before a boundary: the lobby rolls its tick forward...
      const B = epoch + 33n * DUR;
      await time.increaseTo(B - 5n);
      const w = await griddy.currentWindow();
      expect(w.windowStart).to.equal(B);
      expect(w.windowEnd).to.equal(B + DUR);
      expect(w.secondsLeft).to.equal(DUR + 5n);

      // ...but the stake does NOT wait for that boundary: it opens right now
      // and runs a full roundDuration from here
      const t = B - 4n;
      const id = await openRoundAt(griddy, alice, t, [3], [MIN_STAKE]);
      const r = await griddy.rounds(id);
      expect(r.startTime).to.equal(t);
      expect(r.endTime).to.equal(t + DUR);
      expect(r.endTime).to.be.lessThan(w.windowEnd);      // earlier than the tick
      expect((await griddy.getCurrentRound()).timeRemaining).to.equal(DUR);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 5. Resolution, accounting and solvency on full-length rounds
  // ════════════════════════════════════════════════════════════

  describe("resolution across several pending rounds", () => {
    it("resolves full-length rounds out of order while a third stays pending — exact money math", async () => {
      const { owner, alice, bob, carol, dave, griddy } = await deployV8();
      const gAddr = await griddy.getAddress();

      // round A: [T10M-40, T10M-10) — a full 30s, pinned to drand ROUND_10M
      const idA = await openRoundAt(griddy, alice, A_OPEN, [3], [3n * 10n ** 17n]);
      let r = await griddy.rounds(idA);
      expect(r.endTime).to.equal(A_END);
      expect(r.drandRound).to.equal(ROUND_10M);

      // round B: opened 2s before drand ROUND_10M is emitted, and STILL a full
      // 30s — under V7 this stake would have inherited a sliver
      const idB = await openRoundAt(griddy, bob, B_ROLL, [7], [2n * 10n ** 17n]);
      r = await griddy.rounds(idB);
      expect(r.endTime).to.equal(B_END);
      expect(r.endTime - r.startTime).to.equal(DUR);
      expect(r.drandRound).to.equal(ROUND_B);
      expect(await griddy.totalUnresolvedStakes()).to.equal(5n * 10n ** 17n);

      // round C: staked and deliberately left pending
      const idC = await openRoundAt(griddy, carol, B_END + 5n, [11], [15n * 10n ** 16n]);
      expect((await griddy.rounds(idC)).endTime).to.equal(B_END + 5n + DUR);
      expect(await griddy.totalUnresolvedStakes()).to.equal(65n * 10n ** 16n);

      // ── resolve NEWEST first, then the older one ──
      const bobBefore = await ethers.provider.getBalance(bob.address);
      await time.setNextBlockTimestamp(TB + 1n);
      await griddy.connect(dave).resolveRound(idB, SIG_ROUND_B);
      const distB = 2n * 10n ** 17n - feeOf(2n * 10n ** 17n);
      expect((await griddy.rounds(idB)).winningCell).to.equal(7);
      expect(await ethers.provider.getBalance(bob.address)).to.equal(bobBefore + distB);
      expect(await griddy.totalUnresolvedStakes()).to.equal(45n * 10n ** 16n);

      const aliceBefore = await ethers.provider.getBalance(alice.address);
      await time.setNextBlockTimestamp(TB + 2n);
      await griddy.connect(dave).resolveRound(idA, SIG_ROUND_10M);
      const distA = 3n * 10n ** 17n - feeOf(3n * 10n ** 17n);
      expect((await griddy.rounds(idA)).winningCell).to.equal(3);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(aliceBefore + distA);

      // C's stake is untouched, and resolution opened no new round
      expect(await griddy.totalUnresolvedStakes()).to.equal(15n * 10n ** 16n);
      expect(await griddy.currentRoundId()).to.equal(idC);
      expect((await griddy.rounds(idC)).resolved).to.equal(false);
      expect(await griddy.accumulatedFees()).to.equal(
        feeOf(2n * 10n ** 17n) - TIP + feeOf(3n * 10n ** 17n) - TIP);
      // solvency: the balance is exactly C's stake plus retained fees
      expect(await ethers.provider.getBalance(gAddr)).to.equal(
        15n * 10n ** 16n + (await griddy.accumulatedFees()));
      expect(await ethers.provider.getBalance(gAddr)).to.equal(await reservedOf(griddy));
      await time.setNextBlockTimestamp(TB + 3n);
      await expect(griddy.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");

      // ATTACK: neither settled round can be resolved twice
      await time.setNextBlockTimestamp(TB + 4n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_10M)).to.be.revertedWith("Already resolved");
      await time.setNextBlockTimestamp(TB + 5n);
      await expect(griddy.resolveRound(idB, SIG_ROUND_B)).to.be.revertedWith("Already resolved");
    });

    it("a round cannot be resolved until its FULL window closes, and empty rounds never masquerade as payable ones", async () => {
      const { owner, alice, griddy } = await deployV8();
      const idA = await openRoundAt(griddy, alice, A_OPEN, [3], [10n ** 17n]);

      // the grid boundary inside the round is meaningless now: betting is open
      // right up to the round's own deadline
      await time.setNextBlockTimestamp(A_END - 1n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_10M)).to.be.revertedWith("Round not ended");

      // the deploy-time round expired empty and can never be resolved for money
      await time.setNextBlockTimestamp(A_END + 1n);
      await expect(griddy.resolveRound(1n, SIG_ROUND_10M)).to.be.revertedWith("Use skipEmptyRound");
      await time.setNextBlockTimestamp(A_END + 2n);
      await expect(griddy.skipEmptyRound(1n)).to.emit(griddy, "EmptyRoundSkipped").withArgs(1n);
      // ...and no future id can be conjured either
      await expect(griddy.skipEmptyRound(idA + 5n)).to.be.revertedWith("Wrong round");

      const before = await ethers.provider.getBalance(alice.address);
      await time.setNextBlockTimestamp(T10M + 1n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        before + 10n ** 17n - feeOf(10n ** 17n));
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
    });

    it("ATTACK: sweepSurplus takes exactly a stray donation and never a wei of staked money", async () => {
      const { owner, alice, bob, griddy } = await deployV8();
      const gAddr = await griddy.getAddress();
      const idA = await openRoundAt(griddy, alice, A_OPEN, [3], [3n * 10n ** 17n]);
      const idB = await openRoundAt(griddy, bob, B_ROLL, [7], [2n * 10n ** 17n]);
      expect(await ethers.provider.getBalance(gAddr)).to.equal(5n * 10n ** 17n);

      // both rounds ended, both unresolved: nothing is sweepable
      await time.setNextBlockTimestamp(B_END + 1n);
      await expect(griddy.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");

      const stray = 10n ** 16n;
      await time.setNextBlockTimestamp(B_END + 2n);
      await owner.sendTransaction({ to: gAddr, value: stray });

      const ownerBefore = await ethers.provider.getBalance(owner.address);
      await time.setNextBlockTimestamp(B_END + 3n);
      const tx = await griddy.connect(owner).sweepSurplus();
      const rc = await tx.wait();
      expect(await ethers.provider.getBalance(owner.address)).to.equal(
        ownerBefore + stray - BigInt(rc!.gasUsed) * BigInt(rc!.gasPrice));
      expect(await ethers.provider.getBalance(gAddr)).to.equal(5n * 10n ** 17n);

      // every staked wei is still there: both rounds pay in full
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const bobBefore = await ethers.provider.getBalance(bob.address);
      await time.setNextBlockTimestamp(TB + 1n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);
      await time.setNextBlockTimestamp(TB + 2n);
      await griddy.connect(owner).resolveRound(idB, SIG_ROUND_B);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        aliceBefore + 3n * 10n ** 17n - feeOf(3n * 10n ** 17n));
      expect(await ethers.provider.getBalance(bob.address)).to.equal(
        bobBefore + 2n * 10n ** 17n - feeOf(2n * 10n ** 17n));
      expect(await ethers.provider.getBalance(gAddr)).to.equal(await griddy.accumulatedFees());
    });

    it("escrows a winner whose receive() reverts, and the pull path still unwinds to the exact wei", async () => {
      const { owner, griddy } = await deployV8();
      const gAddr = await griddy.getAddress();
      const RR = await ethers.getContractFactory("RevertingReceiver");
      const rr = await RR.deploy();

      await time.setNextBlockTimestamp(A_OPEN);
      await rr.stakeVia(gAddr, 2, 3, { value: 10n ** 17n });
      const r = await griddy.rounds(2n);
      expect(r.drandRound).to.equal(ROUND_10M);
      expect(r.endTime - r.startTime).to.equal(DUR);

      await time.setNextBlockTimestamp(T10M + 1n);
      await expect(griddy.connect(owner).resolveRound(2n, SIG_ROUND_10M))
        .to.emit(griddy, "WinningsEscrowed");
      const escrowed = 10n ** 17n - feeOf(10n ** 17n);
      expect(await griddy.unclaimedWinnings(await rr.getAddress())).to.equal(escrowed);
      expect(await griddy.pendingWithdrawals()).to.equal(escrowed);
      expect(await ethers.provider.getBalance(gAddr)).to.equal(await reservedOf(griddy));

      await time.setNextBlockTimestamp(T10M + 2n);
      await rr.withdrawVia(gAddr);
      expect(await griddy.pendingWithdrawals()).to.equal(0n);
      expect(await ethers.provider.getBalance(await rr.getAddress())).to.equal(escrowed);
      expect(await ethers.provider.getBalance(gAddr)).to.equal(await griddy.accumulatedFees());
    });
  });

  // ════════════════════════════════════════════════════════════
  // 6. Void / repin still behave as in V7
  // ════════════════════════════════════════════════════════════

  describe("void & repin", () => {
    it("voids a stuck full-length round: exact refunds, accumulator decremented, game paused", async () => {
      const { owner, alice, bob, carol, dave, griddy } = await deployV8();
      const idA = await openRoundAt(griddy, alice, A_OPEN, [1, 2], [10n ** 16n, 4n * 10n ** 16n]);
      await stakeAt(griddy, bob, A_END - 1n, idA, [3], [2n * 10n ** 16n]);
      const idB = await openRoundAt(griddy, carol, B_ROLL, [7], [2n * 10n ** 17n]);

      // too early to void
      await time.setNextBlockTimestamp(T10M + 1n);
      await expect(griddy.requestVoid(idA)).to.be.revertedWith("Not stuck");

      const reqT = A_END + REFUND_DELAY + 1n;
      await time.setNextBlockTimestamp(reqT);
      await griddy.connect(alice).requestVoid(idA);
      await time.setNextBlockTimestamp(reqT + 5n);
      await expect(griddy.requestVoid(idA)).to.be.revertedWith("Already requested");

      // betting continues in a fresh FULL round while the request matures
      const idC = await openRoundAt(griddy, dave, reqT + 10n, [5], [10n ** 17n]);
      expect(idC).to.equal(idB + 1n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(37n * 10n ** 16n);

      await time.setNextBlockTimestamp(reqT + 11n);
      await expect(griddy.voidStuckRound(idA)).to.be.revertedWith("Grace not over");

      const voidT = reqT + VOID_GRACE + 1n;
      await time.setNextBlockTimestamp(voidT);
      await expect(griddy.connect(bob).voidStuckRound(idA))
        .to.emit(griddy, "RoundVoided").withArgs(idA)
        .and.to.emit(griddy, "PausedSet").withArgs(true);

      expect(await griddy.totalUnresolvedStakes()).to.equal(3n * 10n ** 17n);
      expect(await griddy.pendingRefunds()).to.equal(7n * 10n ** 16n);
      expect(await griddy.paused()).to.equal(true);
      await time.setNextBlockTimestamp(voidT + 1n);
      await expect(
        griddy.connect(dave).stake(idC + 1n, [0], [MIN_STAKE], { value: MIN_STAKE })
      ).to.be.revertedWith("Paused");

      // ATTACK: the voided round can never be voided or resolved again
      await time.setNextBlockTimestamp(voidT + 2n);
      await expect(griddy.voidStuckRound(idA)).to.be.revertedWith("Already resolved");
      await time.setNextBlockTimestamp(voidT + 3n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_10M)).to.be.revertedWith("Already resolved");

      // refunds are exact, once per player, entrants only
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      await time.setNextBlockTimestamp(voidT + 4n);
      const tx1 = await griddy.connect(alice).refund(idA);
      const rc1 = await tx1.wait();
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        aliceBefore + 5n * 10n ** 16n - BigInt(rc1!.gasUsed) * BigInt(rc1!.gasPrice));
      const bobBefore = await ethers.provider.getBalance(bob.address);
      await time.setNextBlockTimestamp(voidT + 5n);
      const tx2 = await griddy.connect(bob).refund(idA);
      const rc2 = await tx2.wait();
      expect(await ethers.provider.getBalance(bob.address)).to.equal(
        bobBefore + 2n * 10n ** 16n - BigInt(rc2!.gasUsed) * BigInt(rc2!.gasPrice));
      expect(await griddy.pendingRefunds()).to.equal(0n);
      await expect(griddy.connect(alice).refund(idA)).to.be.revertedWith("Already refunded");
      await expect(griddy.connect(carol).refund(idA)).to.be.revertedWith("Not entered");
      await expect(griddy.connect(carol).refund(idB)).to.be.revertedWith("Not voided");

      // owner unpauses; betting rolls on with full-length rounds
      await griddy.connect(owner).setPaused(false);
      const idD = await openRoundAt(griddy, dave, voidT + 10n, [0], [MIN_STAKE]);
      expect((await griddy.rounds(idD)).endTime - (await griddy.rounds(idD)).startTime).to.equal(DUR);
      expect(await griddy.totalUnresolvedStakes()).to.equal(3n * 10n ** 17n + MIN_STAKE);
    });

    it("repinRound moves an old round's pin forward — owner-only, overdue-only", async () => {
      const { owner, alice, bob, beacon, griddy } = await deployV8();
      const idA = await openRoundAt(griddy, alice, A_OPEN, [0], [10n ** 17n]);
      const idB = await openRoundAt(griddy, bob, B_ROLL, [7], [2n * 10n ** 17n]);

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
      // the re-pin never moves the window it was drawn for
      expect((await griddy.rounds(idA)).endTime).to.equal(A_END);
      expect((await griddy.rounds(idB)).drandRound).to.equal(ROUND_B);

      // ATTACK: the already-published beacon can no longer settle the round
      await time.setNextBlockTimestamp(late + 1n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_10M))
        .to.be.revertedWithCustomError(beacon, "InvalidSignature");
    });
  });
});
