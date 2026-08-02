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
// V7's grid step (the default roundDuration) and its shortest usable window
const DUR = 30n;
const MIN_BET_WINDOW = 6n;

// ─── beacon schedule replicas (valid for t > genesis) ───
const timeOfRoundTs = (r: bigint) => EVMNET_GENESIS + (r - 1n) * EVMNET_PERIOD;
const roundAtTs = (t: bigint) => (t - EVMNET_GENESIS + EVMNET_PERIOD - 1n) / EVMNET_PERIOD + 1n;

// V6-shaped fixtures, used only for the round that is already in flight when
// the proxy is upgraded. Round A opened at A_OPEN (roundDuration 30 +
// beaconGap 10 before the emit) pins to drand ROUND_10M; a lazy roll at
// B_ROLL pins the next round to ROUND_B.
const T10M = timeOfRoundTs(ROUND_10M);
const A_OPEN = T10M - 40n;
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

// ─── grid replicas (mirror _windowOf / _bettableWindow) ───
/** The grid boundary at or before t */
const gridStart = (epoch: bigint, t: bigint, d = DUR) =>
  t > epoch ? epoch + ((t - epoch) / d) * d : epoch;
/** The window a stake at t lands in: [start, end) */
function bettable(epoch: bigint, t: bigint, d = DUR): [bigint, bigint] {
  const s = gridStart(epoch, t, d);
  const e = s + d;
  return e - t < MIN_BET_WINDOW ? [e, e + d] : [s, e];
}

describe("GriddyV7 — grid-aligned windows: the clock runs with zero players", () => {
  // own chain state: fixtures pin real historical beacon rounds
  beforeEach(async () => { await reset(); });

  async function deployBeacon() {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    return Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  }

  /** The live proxy's current shape: V6 behind UUPS. */
  async function deployV6() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const beacon = await deployBeacon();
    const V6 = await ethers.getContractFactory("GriddyV6");
    const griddy = await upgrades.deployProxy(
      V6, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    return { owner, alice, bob, carol, dave, beacon, griddy };
  }

  /** The upgrade under test: V6 proxy → V7, anchoring the grid. */
  async function upgradeToV7(griddy: any) {
    const V7 = await ethers.getContractFactory("GriddyV7");
    return upgrades.upgradeProxy(await griddy.getAddress(), V7, {
      call: { fn: "initializeV7", args: [] },
    });
  }

  /** A fresh V7 deployment: initialize() anchors the grid at the deploy block. */
  async function deployV7() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const beacon = await deployBeacon();
    const V7 = await ethers.getContractFactory("GriddyV7");
    const griddy = await upgrades.deployProxy(
      V7, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    const epoch = await griddy.roundEpoch();
    // the anchor is exactly the block that initialized the proxy
    expect(epoch).to.equal(BigInt(await time.latest()));
    return { owner, alice, bob, carol, dave, beacon, griddy, epoch };
  }

  /** First stake after the deploy-time round expires lazily opens a round
   *  pinned exactly to drand ROUND_10M under V6 rules. */
  async function openRoundA(griddy: any, signer: any, cells: number[], amounts: bigint[]) {
    await time.setNextBlockTimestamp(A_OPEN);
    const id = (await griddy.currentRoundId()) + 1n;
    const value = amounts.reduce((a, b) => a + b, 0n);
    await griddy.connect(signer).stake(id, cells, amounts, { value });
    expect((await griddy.rounds(id)).drandRound).to.equal(ROUND_10M);
    return id;
  }

  /** First stake at B_ROLL lazily opens the next round pinned to ROUND_B. */
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
    return griddy.connect(signer).stake(id, cells, amounts, { value });
  }

  // ════════════════════════════════════════════════════════════
  // 1. Upgrade: live V6 money in flight → V7
  // ════════════════════════════════════════════════════════════

  describe("upgrade V6 → V7", () => {
    it("preserves every slot across a live staked round, anchors the grid, and the in-flight round still pays V6 math", async () => {
      const { owner, alice, bob, carol, beacon, griddy } = await deployV6();
      const proxy = await griddy.getAddress();

      // round A: staked, left behind by the lazy roll, then resolved — so the
      // proxy carries real accumulated fees into the upgrade
      const idA = await openRoundA(griddy, alice, [3], [10n ** 17n]);
      const idB = await rollToRoundB(griddy, bob, [7], [2n * 10n ** 17n]);
      await stakeAt(griddy, carol, T10M - 1n, idB, [11], [3n * 10n ** 17n]);
      await time.setNextBlockTimestamp(T10M + 1n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);

      // round B is live money: staked, still open for betting, unresolved
      const potB = 5n * 10n ** 17n;
      const feesBefore = feeOf(10n ** 17n) - TIP;
      const before = {
        roundId: await griddy.currentRoundId(),
        pot: (await griddy.rounds(idB)).totalStaked,
        stakers: (await griddy.rounds(idB)).totalStakers,
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
        balance: await ethers.provider.getBalance(proxy),
      };
      expect(before.fees).to.equal(feesBefore);
      expect(before.unresolved).to.equal(potB);
      const implBefore = await upgrades.erc1967.getImplementationAddress(proxy);

      // ── UPGRADE ──
      const v7 = await upgradeToV7(griddy);
      expect(await v7.getAddress()).to.equal(proxy);
      expect(await upgrades.erc1967.getImplementationAddress(proxy)).to.not.equal(implBefore);

      // the ONE new slot: the grid anchor, seeded at the upgrade block
      const epoch = await v7.roundEpoch();
      expect(epoch).to.not.equal(0n);
      expect(epoch).to.equal(BigInt(await time.latest()));
      expect(await v7.MIN_BET_WINDOW()).to.equal(MIN_BET_WINDOW);

      // every value the proxy held is untouched
      expect(await v7.currentRoundId()).to.equal(before.roundId);
      expect((await v7.rounds(idB)).totalStaked).to.equal(before.pot);
      expect((await v7.rounds(idB)).totalStakers).to.equal(before.stakers);
      expect((await v7.rounds(idB)).endTime).to.equal(before.endTime);
      expect((await v7.rounds(idB)).drandRound).to.equal(before.drandRound);
      expect(await v7.accumulatedFees()).to.equal(before.fees);
      expect(await v7.totalUnresolvedStakes()).to.equal(before.unresolved);
      expect(await v7.owner()).to.equal(before.owner);
      expect(await v7.beacon()).to.equal(before.beacon);
      expect(await v7.beacon()).to.equal(await beacon.getAddress());
      expect(await v7.minStakeWei()).to.equal(before.minStake);
      expect(await v7.minStakeWei()).to.equal(MIN_STAKE);
      expect(await v7.resolverTipWei()).to.equal(before.tip);
      expect(await v7.protocolFeeBps()).to.equal(before.feeBps);
      expect(await v7.roundDuration()).to.equal(before.duration);
      expect(await v7.beaconGap()).to.equal(before.gap);
      expect(await v7.MIN_STAKE_HI()).to.equal(10n ** 18n);
      expect(await ethers.provider.getBalance(proxy)).to.equal(before.balance);
      // per-player positions and the settled round survive intact
      expect(await v7.stakeOf(idB, 7, bob.address)).to.equal(2n * 10n ** 17n);
      expect(await v7.stakeOf(idB, 11, carol.address)).to.equal(3n * 10n ** 17n);
      expect(await v7.playerTotalStaked(idB, carol.address)).to.equal(3n * 10n ** 17n);
      expect((await v7.rounds(idA)).resolved).to.equal(true);
      expect((await v7.rounds(idA)).distributable).to.equal(10n ** 17n - feeOf(10n ** 17n));

      // the in-flight V6 round keeps the window it opened with: a stake before
      // its endTime still lands in it, no grid roll
      await stakeAt(v7, alice, B_END - 5n, idB, [7], [10n ** 16n]);
      expect(await v7.currentRoundId()).to.equal(before.roundId);
      expect((await v7.rounds(idB)).endTime).to.equal(B_END);

      // ...and it resolves under V7 with exactly V6's money math
      const potB2 = potB + 10n ** 16n;
      const totals = new Map<number, bigint>([
        [7, 2n * 10n ** 17n + 10n ** 16n], [11, 3n * 10n ** 17n],
      ]);
      const winCell = pickWinner(vrfFromSig(SIG_ROUND_B), totals, potB2);
      const dist = potB2 - feeOf(potB2);
      const bobBefore = await ethers.provider.getBalance(bob.address);
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const carolBefore = await ethers.provider.getBalance(carol.address);

      await time.setNextBlockTimestamp(B_END + 11n);
      await v7.connect(owner).resolveRound(idB, SIG_ROUND_B);

      const r = await v7.rounds(idB);
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
      expect(await v7.totalUnresolvedStakes()).to.equal(0n);
      // V5 semantics kept: resolution opens NO new round
      expect(await v7.currentRoundId()).to.equal(before.roundId);
      // pot conservation: what remains is exactly the retained fees plus dust
      expect(await ethers.provider.getBalance(proxy)).to.equal(await v7.accumulatedFees());

      // and from here on, windows sit on the grid anchored at the upgrade
      const t = B_END + 100n;
      await stakeAt(v7, alice, t, before.roundId + 1n, [0], [MIN_STAKE]);
      const fresh = await v7.rounds(before.roundId + 1n);
      expect(fresh.endTime).to.equal(bettable(epoch, t)[1]);
      expect((BigInt(fresh.endTime) - epoch) % DUR).to.equal(0n);
    });

    it("storage-layout safety: the OZ validator accepts V6 → V7 as an append-only upgrade", async () => {
      const { griddy } = await deployV6();
      const V6 = await ethers.getContractFactory("GriddyV6");
      const V7 = await ethers.getContractFactory("GriddyV7");
      // throws on any layout incompatibility — a silent pass is the assertion
      await upgrades.validateUpgrade(V6, V7, { kind: "uups" });
      await upgrades.validateUpgrade(await griddy.getAddress(), V7, { kind: "uups" });
    });

    it("ATTACK: a non-owner cannot swing the proxy onto the V7 implementation", async () => {
      const { alice, griddy } = await deployV6();
      const V7 = await ethers.getContractFactory("GriddyV7");
      const rogueImpl = await V7.deploy();
      await rogueImpl.waitForDeployment();
      await expect(
        griddy.connect(alice).upgradeToAndCall(await rogueImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(griddy, "OwnableUnauthorizedAccount");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 2. The reinitializer guard
  // ════════════════════════════════════════════════════════════

  describe("initializeV7", () => {
    it("ATTACK: initializeV7 (and the earlier reinitializers) cannot run again on the upgraded proxy", async () => {
      const { alice, griddy } = await deployV6();
      const v7 = await upgradeToV7(griddy);
      const epoch = await v7.roundEpoch();

      await expect(v7.initializeV7()).to.be.revertedWithCustomError(v7, "InvalidInitialization");
      await expect(v7.connect(alice).initializeV7()).to.be.revertedWithCustomError(v7, "InvalidInitialization");
      await expect(v7.initializeV5()).to.be.revertedWithCustomError(v7, "InvalidInitialization");
      await expect(v7.initializeV3()).to.be.revertedWithCustomError(v7, "InvalidInitialization");
      expect(await v7.roundEpoch()).to.equal(epoch);
    });

    it("ATTACK: a stranger calling initializeV7 on a FRESH V7 deploy cannot re-anchor the grid", async () => {
      // A fresh deploy runs initialize (version 1) and anchors the grid there,
      // leaving reinitializer(4) unclaimed and callable by ANYONE. An
      // unconditional write would shift every window mid-countdown.
      const { alice, carol, griddy, epoch } = await deployV7();

      // stand 4 seconds into a window, far from the anchor
      const B = epoch + 300n * DUR;
      await time.increaseTo(B + 2n);
      const wBefore = await griddy.currentWindow();
      expect(wBefore.windowStart).to.equal(B);

      await time.setNextBlockTimestamp(B + 4n);
      await griddy.connect(carol).initializeV7();   // attacker, at a later block

      // the anchor — and therefore the live window — is untouched
      expect(await griddy.roundEpoch()).to.equal(epoch);
      const wAfter = await griddy.currentWindow();
      expect(wAfter.windowStart).to.equal(wBefore.windowStart);
      expect(wAfter.windowEnd).to.equal(wBefore.windowEnd);
      expect(wAfter.drandRound).to.equal(wBefore.drandRound);
      expect(wAfter.secondsLeft).to.equal(wBefore.secondsLeft - 2n);   // clock moved, grid did not

      // ...and the stake that follows lands in exactly that unshifted window
      const id = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, B + 6n, id, [3], [MIN_STAKE]);
      expect((await griddy.rounds(id)).endTime).to.equal(wBefore.windowEnd);
      // never twice
      await expect(griddy.connect(carol).initializeV7())
        .to.be.revertedWithCustomError(griddy, "InvalidInitialization");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 3. THE POINT: the clock ticks with nobody playing
  // ════════════════════════════════════════════════════════════

  describe("empty-lobby countdown", () => {
    it("currentWindow() keeps advancing with zero players and zero materialised rounds", async () => {
      const { griddy, epoch } = await deployV7();
      const gAddr = await griddy.getAddress();
      expect(await griddy.currentRoundId()).to.equal(1n);

      const B = epoch + 500n * DUR;       // a grid boundary, ~4 hours out
      await time.increaseTo(B + 1n);

      // the V6 symptom: the only materialised round died long ago, so a client
      // reading getCurrentRound sees a dead clock and renders "READY" forever
      expect((await griddy.getCurrentRound()).timeRemaining).to.equal(0n);

      const w1 = await griddy.currentWindow();
      expect(w1.windowStart).to.equal(B);
      expect(w1.windowEnd).to.equal(B + DUR);
      expect(w1.secondsLeft).to.equal(DUR - 1n);
      expect(w1.drandRound).to.equal(roundAtTs(B + DUR + BEACON_GAP));

      // mid-window: same boundaries, countdown ticking down
      await time.increaseTo(B + 8n);
      const wMid = await griddy.currentWindow();
      expect(wMid.windowStart).to.equal(w1.windowStart);
      expect(wMid.windowEnd).to.equal(w1.windowEnd);
      expect(wMid.secondsLeft).to.equal(DUR - 8n);

      // exactly one roundDuration later: the whole window has stepped forward
      await time.increaseTo(B + 1n + DUR);
      const w2 = await griddy.currentWindow();
      expect(w2.windowStart - w1.windowStart).to.equal(DUR);
      expect(w2.windowEnd - w1.windowEnd).to.equal(DUR);
      expect(w2.secondsLeft).to.equal(w1.secondsLeft);
      expect(w2.drandRound).to.be.greaterThan(w1.drandRound);
      expect(w2.drandRound).to.equal(roundAtTs(w2.windowEnd + BEACON_GAP));

      // ...and a hundred windows later it is still exactly on the grid
      await time.increaseTo(B + 1n + 100n * DUR);
      const w3 = await griddy.currentWindow();
      expect(w3.windowStart).to.equal(B + 100n * DUR);
      expect(w3.secondsLeft).to.equal(DUR - 1n);

      // none of that wrote a thing: no round, no balance, no transaction
      expect(await griddy.currentRoundId()).to.equal(1n);
      expect((await griddy.rounds(2n)).startTime).to.equal(0n);
      expect((await griddy.rounds(2n)).endTime).to.equal(0n);
      expect(await ethers.provider.getBalance(gAddr)).to.equal(0n);
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
    });

    it("the advertised window is the one a stake actually buys — endTime and pin both match", async () => {
      const { alice, griddy, epoch } = await deployV7();

      const B = epoch + 77n * DUR;
      await time.increaseTo(B + 4n);
      const w = await griddy.currentWindow();
      expect(w.windowStart).to.equal(B);
      expect(w.windowEnd).to.equal(B + DUR);
      expect(w.secondsLeft).to.equal(DUR - 4n);

      const id = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, B + 5n, id, [3], [MIN_STAKE]);

      const r = await griddy.rounds(id);
      expect(r.startTime).to.equal(B + 5n);      // opened when the stake landed
      expect(r.endTime).to.equal(w.windowEnd);   // ...but closes on the grid
      expect(r.drandRound).to.equal(w.drandRound);
      const cur = await griddy.getCurrentRound();
      expect(cur.roundId).to.equal(id);
      expect(cur.endTime).to.equal(w.windowEnd);
      expect(cur.timeRemaining).to.equal(w.secondsLeft - 1n);

      // a second player joining later reads the same window and the same round
      await time.increaseTo(B + 20n);
      const w2 = await griddy.currentWindow();
      expect(w2.windowStart).to.equal(B);
      expect(w2.windowEnd).to.equal(r.endTime);
      expect(await griddy.currentRoundId()).to.equal(id);
    });

    it("changing beaconGap re-pins the beacon but never moves the grid", async () => {
      const { owner, griddy, epoch } = await deployV7();
      const B = epoch + 40n * DUR;
      await time.increaseTo(B + 3n);
      const w1 = await griddy.currentWindow();

      await time.setNextBlockTimestamp(B + 4n);
      await griddy.connect(owner).setBeaconGap(31n);
      const w2 = await griddy.currentWindow();
      expect(w2.windowStart).to.equal(w1.windowStart);
      expect(w2.windowEnd).to.equal(w1.windowEnd);
      expect(w2.drandRound).to.equal(roundAtTs(w1.windowEnd + 31n));
      expect(w2.drandRound).to.be.greaterThan(w1.drandRound);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 4. MIN_BET_WINDOW — nobody gets a one-second round
  // ════════════════════════════════════════════════════════════

  describe("MIN_BET_WINDOW", () => {
    it("exactly 6s left keeps the window; 5s left rolls into the next one, and the round stays usable", async () => {
      const { alice, bob, carol, griddy, epoch } = await deployV7();

      // ── exactly MIN_BET_WINDOW seconds left: the window still counts ──
      const B1 = epoch + 120n * DUR;
      const idEdge = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, B1 - MIN_BET_WINDOW, idEdge, [3], [MIN_STAKE]);
      const edge = await griddy.rounds(idEdge);
      expect(edge.startTime).to.equal(B1 - MIN_BET_WINDOW);
      expect(edge.endTime).to.equal(B1);
      expect((await griddy.getCurrentRound()).timeRemaining).to.equal(MIN_BET_WINDOW);

      // ── one second short of it: the stake buys the NEXT window ──
      const B2 = B1 + DUR;
      await time.increaseTo(B2 - 5n);
      const w = await griddy.currentWindow();
      expect(w.windowStart).to.equal(B2);            // rolled forward
      expect(w.windowEnd).to.equal(B2 + DUR);
      expect(w.secondsLeft).to.equal(DUR + 5n);      // 5 to spare + a full window

      const idRoll = idEdge + 1n;
      await stakeAt(griddy, bob, B2 - 4n, idRoll, [7], [MIN_STAKE]);
      const roll = await griddy.rounds(idRoll);
      expect(roll.startTime).to.equal(B2 - 4n);
      expect(roll.endTime).to.equal(B2 + DUR);        // the LATER boundary
      expect(roll.endTime).to.equal(w.windowEnd);
      // the player really got a usable window, not a sliver
      expect((await griddy.getCurrentRound()).timeRemaining).to.equal(DUR + 4n);
      expect(roll.endTime - roll.startTime).to.be.greaterThan(MIN_BET_WINDOW);

      // ...and it stays one round: a later joiner does not roll past it
      await stakeAt(griddy, carol, B2 + 20n, idRoll, [7], [MIN_STAKE]);
      expect(await griddy.currentRoundId()).to.equal(idRoll);
      expect((await griddy.rounds(idRoll)).endTime).to.equal(B2 + DUR);
      expect((await griddy.rounds(idRoll)).totalStakers).to.equal(2n);

      // both rounds are still on the grid
      expect((BigInt(edge.endTime) - epoch) % DUR).to.equal(0n);
      expect((BigInt(roll.endTime) - epoch) % DUR).to.equal(0n);
    });

    it("every opened round pins a beacon emitted strictly after betting closes — normal window and rollover alike", async () => {
      const { alice, bob, beacon, griddy, epoch } = await deployV7();

      // normal window
      const B = epoch + 60n * DUR;
      const idN = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, B + 5n, idN, [1], [MIN_STAKE]);
      const n = await griddy.rounds(idN);
      expect(n.endTime).to.equal(B + DUR);
      expect(await beacon.timeOfRound(n.drandRound)).to.be.greaterThan(n.endTime);
      expect(await beacon.timeOfRound(n.drandRound)).to.be.greaterThanOrEqual(n.endTime + BEACON_GAP);
      // the pin does not exist while betting is open
      expect(await beacon.timeOfRound(n.drandRound)).to.be.greaterThan(
        (await griddy.getCurrentRound()).endTime);

      // MIN_BET_WINDOW rollover
      const B2 = B + 2n * DUR;
      const idR = idN + 1n;
      await stakeAt(griddy, bob, B2 - 2n, idR, [2], [MIN_STAKE]);
      const r = await griddy.rounds(idR);
      expect(r.endTime).to.equal(B2 + DUR);
      expect(await beacon.timeOfRound(r.drandRound)).to.be.greaterThan(r.endTime);
      expect(await beacon.timeOfRound(r.drandRound)).to.be.greaterThanOrEqual(r.endTime + BEACON_GAP);
      // rolling forward pinned a LATER beacon, never a republished one
      expect(r.drandRound).to.be.greaterThan(n.drandRound);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 5. Idle gaps and zero-cost empty windows
  // ════════════════════════════════════════════════════════════

  describe("idle windows", () => {
    it("windows stay aligned across an hour with nobody playing", async () => {
      const { alice, bob, griddy, epoch } = await deployV7();

      const t0 = epoch + 3n * DUR + 7n;
      const id1 = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, t0, id1, [4], [MIN_STAKE]);
      expect((await griddy.rounds(id1)).endTime).to.equal(bettable(epoch, t0)[1]);

      // ── an hour of nothing: 120 empty windows, not one transaction ──
      const t1 = t0 + 3600n;
      const id2 = id1 + 1n;
      await stakeAt(griddy, bob, t1, id2, [9], [MIN_STAKE]);

      const r2 = await griddy.rounds(id2);
      expect(r2.startTime).to.equal(t1);
      expect((BigInt(r2.endTime) - epoch) % DUR).to.equal(0n);     // still on the grid
      expect(r2.endTime).to.equal(bettable(epoch, t1)[1]);
      expect(r2.endTime).to.be.greaterThan(t1);
      // exactly one round was created for the whole idle stretch
      expect(await griddy.currentRoundId()).to.equal(id2);
      expect(await griddy.totalUnresolvedStakes()).to.equal(2n * MIN_STAKE);
    });

    it("empty windows cost nothing: no tx, no storage, and the next stake prices identically", async () => {
      const { alice, griddy, epoch } = await deployV7();
      const gAddr = await griddy.getAddress();

      // warm the global accumulator so the two measured stakes are comparable
      const idWarm = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, epoch + DUR + 5n, idWarm, [0], [MIN_STAKE]);

      // one idle window in between
      const idNear = idWarm + 1n;
      const near = await stakeAt(griddy, alice, epoch + 3n * DUR + 5n, idNear, [1], [MIN_STAKE]);
      const gasNear = (await near.wait())!.gasUsed;

      // ── a thousand idle windows, with zero transactions ──
      await time.increaseTo(epoch + 1003n * DUR);
      expect(await griddy.currentRoundId()).to.equal(idNear);         // nothing opened
      expect((await griddy.rounds(idNear + 1n)).startTime).to.equal(0n);
      expect(await ethers.provider.getBalance(gAddr)).to.equal(2n * MIN_STAKE);

      const idFar = idNear + 1n;
      const far = await stakeAt(griddy, alice, epoch + 1004n * DUR + 5n, idFar, [2], [MIN_STAKE]);
      const gasFar = (await far.wait())!.gasUsed;

      // skipping 1000 windows costs exactly what skipping one costs
      expect(gasFar).to.equal(gasNear);
      const r = await griddy.rounds(idFar);
      expect(r.endTime).to.equal(epoch + 1005n * DUR);
      expect(await griddy.currentRoundId()).to.equal(idFar);
    });

    it("setRoundDuration keeps working and re-phases the grid around the same anchor", async () => {
      const { owner, alice, griddy, epoch } = await deployV7();

      await time.setNextBlockTimestamp(epoch + 5n * DUR);
      await expect(griddy.connect(owner).setRoundDuration(45n))
        .to.emit(griddy, "ConfigUpdated").withArgs("roundDuration", 45n);
      expect(await griddy.roundDuration()).to.equal(45n);

      // the grid now steps by 45 from the unchanged anchor
      const t = epoch + 5n * DUR + 10n;
      await time.increaseTo(t);
      const w = await griddy.currentWindow();
      expect(w.windowStart).to.equal(gridStart(epoch, t, 45n));
      expect(w.windowEnd).to.equal(w.windowStart + 45n);
      expect((BigInt(w.windowEnd) - epoch) % 45n).to.equal(0n);
      expect(w.windowEnd).to.be.greaterThan(t);

      const id = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, t + 1n, id, [5], [MIN_STAKE]);
      expect((await griddy.rounds(id)).endTime).to.equal(w.windowEnd);
      // bounds still enforced, still owner-only
      await expect(griddy.connect(owner).setRoundDuration(9n)).to.be.revertedWith("10s-1h");
      await expect(griddy.connect(alice).setRoundDuration(60n))
        .to.be.revertedWithCustomError(griddy, "OwnableUnauthorizedAccount");
    });
  });

  // ════════════════════════════════════════════════════════════
  // 6. Continuous resolution on grid-aligned rounds
  // ════════════════════════════════════════════════════════════

  describe("resolution across several pending grid rounds", () => {
    /** Anchors two grid windows onto the two real drand fixtures. The grid is
     *  fixed by roundEpoch, so the beacon is aimed with beaconGap instead:
     *  window A closes at the last boundary before drand ROUND_10M is emitted,
     *  window B one step later, just before ROUND_B. */
    async function gridOntoBeacons(griddy: any, epoch: bigint) {
      const endA = gridStart(epoch, T10M - 3n);
      const gapA = T10M - endA;                        // 3..32
      const endB = endA + DUR;
      const gapB = timeOfRoundTs(ROUND_B) - endB;      // gapA + 9
      expect(gapA).to.be.greaterThanOrEqual(3n);
      expect(gapA).to.be.lessThanOrEqual(60n);
      expect(gapB).to.be.lessThanOrEqual(60n);
      return { endA, gapA, endB, gapB };
    }

    it("resolves grid rounds out of order while a third stays pending — V5 money math, exact", async () => {
      const { owner, alice, bob, carol, dave, griddy, epoch } = await deployV7();
      const gAddr = await griddy.getAddress();
      const { endA, gapA, endB, gapB } = await gridOntoBeacons(griddy, epoch);

      // ── round A: closes on the grid, pinned to drand ROUND_10M ──
      await griddy.connect(owner).setBeaconGap(gapA);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, endA - 20n, idA, [3], [3n * 10n ** 17n]);
      let r = await griddy.rounds(idA);
      expect(r.endTime).to.equal(endA);
      expect(r.drandRound).to.equal(ROUND_10M);

      // ── round B: the next grid step, pinned to drand ROUND_B ──
      await time.setNextBlockTimestamp(endA - 10n);
      await griddy.connect(owner).setBeaconGap(gapB);   // pin only; grid unmoved
      const idB = idA + 1n;
      await stakeAt(griddy, bob, endA + 5n, idB, [7], [2n * 10n ** 17n]);
      r = await griddy.rounds(idB);
      expect(r.endTime).to.equal(endB);
      expect(r.drandRound).to.equal(ROUND_B);
      expect(await griddy.totalUnresolvedStakes()).to.equal(5n * 10n ** 17n);

      // ── round C: staked and deliberately left pending ──
      const idC = idB + 1n;
      await stakeAt(griddy, carol, endB + 5n, idC, [11], [15n * 10n ** 16n]);
      expect((await griddy.rounds(idC)).endTime).to.equal(endB + DUR);
      expect(await griddy.totalUnresolvedStakes()).to.equal(65n * 10n ** 16n);

      // ── resolve NEWEST first, then the older one ──
      const bobBefore = await ethers.provider.getBalance(bob.address);
      await time.setNextBlockTimestamp(timeOfRoundTs(ROUND_B) + 1n);
      await griddy.connect(dave).resolveRound(idB, SIG_ROUND_B);
      const distB = 2n * 10n ** 17n - feeOf(2n * 10n ** 17n);
      expect((await griddy.rounds(idB)).winningCell).to.equal(7);
      expect(await ethers.provider.getBalance(bob.address)).to.equal(bobBefore + distB);
      expect(await griddy.totalUnresolvedStakes()).to.equal(45n * 10n ** 16n);

      const aliceBefore = await ethers.provider.getBalance(alice.address);
      await time.setNextBlockTimestamp(timeOfRoundTs(ROUND_B) + 2n);
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
      await time.setNextBlockTimestamp(timeOfRoundTs(ROUND_B) + 3n);
      await expect(griddy.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");

      // ATTACK: neither settled round can be resolved twice
      await time.setNextBlockTimestamp(timeOfRoundTs(ROUND_B) + 4n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_10M)).to.be.revertedWith("Already resolved");
      await time.setNextBlockTimestamp(timeOfRoundTs(ROUND_B) + 5n);
      await expect(griddy.resolveRound(idB, SIG_ROUND_B)).to.be.revertedWith("Already resolved");
    });

    it("a grid round cannot be resolved before its window closes, and empty windows never masquerade as rounds", async () => {
      const { owner, alice, griddy, epoch } = await deployV7();
      const { endA, gapA } = await gridOntoBeacons(griddy, epoch);

      await griddy.connect(owner).setBeaconGap(gapA);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, endA - 20n, idA, [3], [10n ** 17n]);

      // betting is still open: no resolution, whatever signature is offered
      await time.setNextBlockTimestamp(endA - 1n);
      await expect(griddy.resolveRound(idA, SIG_ROUND_10M)).to.be.revertedWith("Round not ended");
      // the deploy-time round expired empty and can never be resolved for money
      await time.setNextBlockTimestamp(endA + 1n);
      await expect(griddy.resolveRound(1n, SIG_ROUND_10M)).to.be.revertedWith("Use skipEmptyRound");
      await time.setNextBlockTimestamp(endA + 2n);
      await expect(griddy.skipEmptyRound(1n)).to.emit(griddy, "EmptyRoundSkipped").withArgs(1n);

      const before = await ethers.provider.getBalance(alice.address);
      await time.setNextBlockTimestamp(T10M + 1n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        before + 10n ** 17n - feeOf(10n ** 17n));
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
    });
  });

  it("currentWindow reports the LIVE round while one is open, not the next grid slot", async () => {
    const { griddy, alice } = await deployV7();
    const min = await griddy.minStakeWei();
    // initialize() already opened round 1 and it is still live, so a stake
    // joins THAT round rather than opening a new window
    const target = await griddy.currentRoundId();
    await griddy.connect(alice).stake(target, [3], [min], { value: min });
    const live = await griddy.rounds(target);
    const shown = await griddy.currentWindow();
    // must advertise the round a stake right now would actually join
    expect(shown[0]).to.equal(live.startTime);
    expect(shown[1]).to.equal(live.endTime);
    expect(shown[2]).to.equal(live.drandRound);
    expect(shown[3]).to.be.greaterThan(0n);
  });
});
