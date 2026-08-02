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
const SIG_ROUND_10M: [bigint, bigint] = [
  0x2c7b65b5acfe55256910ca71cf0a0fa71ac34c2a1167f86a22930a03e70ebec0n,
  0x0f7a530796e7ee38600b06da0390634a9b154e3eebc3b323dde2111e1c8ebdf3n,
];
const ROUND_10M = 10_000_000n;

const MIN_STAKE = 10n ** 14n;
const DUR = 30n;                 // default roundDuration == the grid step
const MIN_BET_WINDOW = 6n;

const timeOfRoundTs = (r: bigint) => EVMNET_GENESIS + (r - 1n) * EVMNET_PERIOD;
const T10M = timeOfRoundTs(ROUND_10M);

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

// ─── grid replicas (mirror _windowOf / _bettableWindow exactly) ───
const gridStart = (epoch: bigint, t: bigint, d = DUR) =>
  t > epoch ? epoch + ((t - epoch) / d) * d : epoch;

/** The window a stake landing at `t` actually buys into under V9. */
function bettableWindow(epoch: bigint, t: bigint, d = DUR) {
  let wStart = gridStart(epoch, t, d);
  let wEnd = wStart + d;
  if (wEnd - t < MIN_BET_WINDOW) {
    wStart = wEnd;
    wEnd = wStart + d;
  }
  return { wStart, wEnd };
}

describe("GriddyV9 — the clock runs on the grid, never on a player's stake", () => {
  beforeEach(async () => { await reset(); });

  async function deployBeacon() {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    return Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  }

  /** The live proxy's current shape: V8 behind UUPS. */
  async function deployV8() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const beacon = await deployBeacon();
    const V8 = await ethers.getContractFactory("GriddyV8");
    const griddy: any = await upgrades.deployProxy(
      V8, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    return { owner, alice, bob, carol, dave, beacon, griddy, epoch: await griddy.roundEpoch() };
  }

  /** The upgrade under test: V8 proxy → V9. Pure logic change, NO initializer. */
  async function upgradeToV9(griddy: any): Promise<any> {
    const V9 = await ethers.getContractFactory("GriddyV9");
    return upgrades.upgradeProxy(await griddy.getAddress(), V9);
  }

  async function deployV9() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const beacon = await deployBeacon();
    const V9 = await ethers.getContractFactory("GriddyV9");
    const griddy: any = await upgrades.deployProxy(
      V9, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    const epoch: bigint = await griddy.roundEpoch();
    expect(epoch).to.equal(BigInt(await time.latest()));
    // the deploy-time round already sits on the grid
    const first = await griddy.rounds(1n);
    expect(first.startTime).to.equal(epoch);
    expect(first.endTime).to.equal(epoch + DUR);
    return { owner, alice, bob, carol, dave, beacon, griddy, epoch };
  }

  async function stakeAt(griddy: any, signer: any, ts: bigint, id: bigint, cells: number[], amounts: bigint[]) {
    await time.setNextBlockTimestamp(ts);
    const value = amounts.reduce((a, b) => a + b, 0n);
    return griddy.connect(signer).stake(id, cells, amounts, { value });
  }

  /** A timestamp `offset` seconds into some window strictly after `now`. */
  async function futureSlot(epoch: bigint, offset: bigint) {
    const now = BigInt(await time.latest());
    let ws = gridStart(epoch, now) + DUR;
    while (ws + offset <= now) ws += DUR;
    return { ws, t: ws + offset };
  }

  const reservedOf = async (g: any) =>
    (await g.totalUnresolvedStakes()) + (await g.pendingRefunds())
    + (await g.pendingWithdrawals()) + (await g.accumulatedFees());

  // ════════════════════════════════════════════════════════════
  // 1. Grid-aligned rounds — the property the whole change exists for
  // ════════════════════════════════════════════════════════════

  describe("round boundaries come from the grid, not the stake", () => {
    it("a stake at ANY offset inside a window opens a round ending on that window's boundary", async () => {
      const { alice, griddy, epoch } = await deployV9();

      for (const offset of [0n, 1n, 7n, 15n, 23n]) {
        const { ws, t } = await futureSlot(epoch, offset);
        const id = (await griddy.currentRoundId()) + 1n;
        await stakeAt(griddy, alice, t, id, [3], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        // startTime is the window start even though the stake landed later
        expect(r.startTime, `offset ${offset} start`).to.equal(ws);
        expect(r.endTime, `offset ${offset} end`).to.equal(ws + DUR);
        // and the deadline is a pure function of the clock: it does NOT move
        // with the stake, the way V8's did
        expect(r.endTime - BigInt(t), `offset ${offset} remaining`).to.equal(DUR - offset);
      }
    });

    it("the V8 regression, side by side: the same 20s-into-the-window stake ran to stake+30 on V8 and now ends on the boundary", async () => {
      // ── V8: deadline measured from the stake ──
      const v8 = await deployV8();
      const s8 = await futureSlot(v8.epoch, 20n);
      const id8 = (await v8.griddy.currentRoundId()) + 1n;
      await stakeAt(v8.griddy, v8.alice, s8.t, id8, [3], [MIN_STAKE]);
      const r8 = await v8.griddy.rounds(id8);
      expect(r8.startTime).to.equal(s8.t);              // the player's own clock
      expect(r8.endTime).to.equal(s8.t + DUR);          // 30s from the stake
      expect(r8.endTime).to.equal(s8.ws + DUR + 20n);   // 20s PAST the boundary

      // ── V9: deadline measured from the grid ──
      await reset();
      const v9 = await deployV9();
      const s9 = await futureSlot(v9.epoch, 20n);
      const id9 = (await v9.griddy.currentRoundId()) + 1n;
      await stakeAt(v9.griddy, v9.alice, s9.t, id9, [3], [MIN_STAKE]);
      const r9 = await v9.griddy.rounds(id9);
      expect(r9.startTime).to.equal(s9.ws);             // the shared grid
      expect(r9.endTime).to.equal(s9.ws + DUR);         // ON the boundary
      expect(BigInt(r9.endTime) - s9.t).to.equal(10n);  // 10s left, honestly
    });

    it("a late stake rolls to the NEXT slot rather than buying a sliver of this one", async () => {
      const { alice, griddy, epoch } = await deployV9();
      // 27s into a 30s window: only 3s left, under MIN_BET_WINDOW
      const { ws, t } = await futureSlot(epoch, DUR - 3n);
      expect(ws + DUR - t).to.be.lessThan(MIN_BET_WINDOW);

      const id = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, t, id, [3], [MIN_STAKE]);
      const r = await griddy.rounds(id);
      // rolled forward a whole window — still grid-aligned, still full length
      expect(r.startTime).to.equal(ws + DUR);
      expect(r.endTime).to.equal(ws + 2n * DUR);
      expect(r.endTime - r.startTime).to.equal(DUR);
      // the staker is early for a round that has not opened yet, which is fine:
      // betting is bounded by endTime, and they get MORE than MIN_BET_WINDOW
      expect(BigInt(r.endTime) - t).to.be.greaterThan(MIN_BET_WINDOW);
    });

    it("back-to-back rounds tile the grid exactly — no drift across many rounds", async () => {
      const { alice, griddy, epoch } = await deployV9();
      const ends: bigint[] = [];
      for (let i = 0; i < 6; i++) {
        const { t } = await futureSlot(epoch, 5n + BigInt(i) * 3n);   // varying offsets
        const id = (await griddy.currentRoundId()) + 1n;
        await stakeAt(griddy, alice, t, id, [i % 25], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect((BigInt(r.startTime) - epoch) % DUR, "start is on the grid").to.equal(0n);
        expect(r.endTime - r.startTime).to.equal(DUR);
        ends.push(BigInt(r.endTime));
      }
      // every boundary is a whole number of steps from the epoch — the defining
      // property of "the clock does not depend on who played when"
      for (const e of ends) expect((e - epoch) % DUR).to.equal(0n);
      // and they are strictly increasing, never overlapping
      for (let i = 1; i < ends.length; i++) expect(ends[i]).to.be.greaterThan(ends[i - 1]);
    });

    it("two rounds can never claim the same window", async () => {
      const { alice, bob, griddy, epoch } = await deployV9();
      const a = await futureSlot(epoch, 2n);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, a.t, idA, [1], [MIN_STAKE]);
      const rA = await griddy.rounds(idA);

      // a second staker inside the SAME window joins round A, never opens a new one
      await stakeAt(griddy, bob, a.ws + 10n, idA, [2], [MIN_STAKE]);
      expect(await griddy.currentRoundId()).to.equal(idA);
      expect((await griddy.rounds(idA)).totalStakers).to.equal(2n);

      // the next round can only start at or after A's boundary
      const b = await futureSlot(epoch, 4n);
      const idB = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, b.t, idB, [3], [MIN_STAKE]);
      const rB = await griddy.rounds(idB);
      expect(rB.startTime).to.be.greaterThanOrEqual(rA.endTime);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 2. The lobby clock is now a promise, not a hint
  // ════════════════════════════════════════════════════════════

  describe("the advertised countdown matches the round actually opened", () => {
    it("currentWindow's idle reading is EXACTLY the round the next stake opens", async () => {
      const { alice, griddy, epoch } = await deployV9();
      // let the deploy round lapse so the lobby is genuinely idle
      await time.increaseTo(epoch + DUR + 1n);

      for (const offset of [0n, 6n, 14n, 22n]) {
        const { t } = await futureSlot(epoch, offset);
        await time.setNextBlockTimestamp(t);
        await ethers.provider.send("evm_mine", []);

        const [wStart, wEnd, drandRound, secsLeft] = await griddy.currentWindow();
        const id = (await griddy.currentRoundId()) + 1n;
        // stake one second later, still inside the advertised window
        await stakeAt(griddy, alice, t + 1n, id, [4], [MIN_STAKE]);
        const r = await griddy.rounds(id);

        expect(r.startTime, `offset ${offset}`).to.equal(wStart);
        expect(r.endTime, `offset ${offset}`).to.equal(wEnd);
        expect(r.drandRound, `offset ${offset}`).to.equal(drandRound);
        expect(secsLeft).to.equal(wEnd - t);
      }
    });

    it("a client computing the countdown from (roundEpoch, roundDuration, now) alone agrees with the chain", async () => {
      const { griddy, epoch } = await deployV9();
      await time.increaseTo(epoch + DUR + 1n);

      for (const skip of [1n, 17n, 45n, 300n, 4_000n]) {
        await time.increase(skip);
        const now = BigInt(await time.latest());
        const [, wEnd, , secsLeft] = await griddy.currentWindow();
        // pure client-side replica — no chain reads at all
        const predicted = bettableWindow(epoch, now);
        expect(wEnd, `skip ${skip}`).to.equal(predicted.wEnd);
        expect(secsLeft, `skip ${skip}`).to.equal(predicted.wEnd - now);
      }
    });

    it("keeps ticking with zero players and zero materialised rounds", async () => {
      const { griddy, epoch } = await deployV9();
      await time.increaseTo(epoch + DUR + 1n);
      const idBefore = await griddy.currentRoundId();

      let prevEnd = 0n;
      for (let i = 0; i < 5; i++) {
        await time.increase(DUR);
        const [, wEnd, , secsLeft] = await griddy.currentWindow();
        expect(secsLeft).to.be.greaterThan(0n);
        expect(secsLeft).to.be.lessThanOrEqual(DUR);
        if (prevEnd > 0n) expect(wEnd).to.be.greaterThan(prevEnd);
        prevEnd = wEnd;
      }
      // nothing was written on-chain the whole time it kept counting
      expect(await griddy.currentRoundId()).to.equal(idBefore);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 3. Fairness invariant survives the realignment
  // ════════════════════════════════════════════════════════════

  describe("beacon fairness", () => {
    it("every grid-aligned round pins a beacon emitted strictly AFTER its endTime, at every offset", async () => {
      const { alice, beacon, griddy, epoch } = await deployV9();
      for (const offset of [0n, 3n, 11n, 19n, 24n, 27n]) {
        const { t } = await futureSlot(epoch, offset);
        const id = (await griddy.currentRoundId()) + 1n;
        await stakeAt(griddy, alice, t, id, [5], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        const emitted = await beacon.timeOfRound(r.drandRound);
        expect(emitted, `offset ${offset}`).to.be.greaterThan(r.endTime);
      }
    });

    it("holds at both beaconGap extremes and a long roundDuration", async () => {
      const { owner, alice, beacon, griddy, epoch } = await deployV9();
      for (const [gap, dur] of [[3n, 10n], [60n, 3600n]] as const) {
        await griddy.connect(owner).setBeaconGap(gap);
        await griddy.connect(owner).setRoundDuration(dur);
        // step past the live round first, or the stake would JOIN it instead of
        // opening the grid-aligned one under test
        const live = await griddy.rounds(await griddy.currentRoundId());
        const now = BigInt(await time.latest());
        const base = now > BigInt(live.endTime) ? now : BigInt(live.endTime);
        const t = gridStart(epoch, base, dur) + dur + 2n;
        const id = (await griddy.currentRoundId()) + 1n;
        await stakeAt(griddy, alice, t, id, [6], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect(r.endTime - r.startTime).to.equal(dur);
        expect(await beacon.timeOfRound(r.drandRound)).to.be.greaterThan(r.endTime);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 4. Upgrade with money in flight
  // ════════════════════════════════════════════════════════════

  describe("upgrade V8 → V9", () => {
    it("preserves every slot and the in-flight V8 round still resolves to the exact wei", async () => {
      const { owner, alice, bob, carol, beacon, griddy, epoch } = await deployV8();
      const proxy = await griddy.getAddress();

      // Aim the V8 round's pin at real drand ROUND_10M: end == T10M - gap.
      const gap = 12n;
      await griddy.connect(owner).setBeaconGap(gap);
      const end = T10M - gap;
      const openAt = end - DUR;                       // V8: end == stake + DUR
      const id = (await griddy.currentRoundId()) + 1n;

      const aliceStake = 3n * 10n ** 17n;
      const bobStake = 1n * 10n ** 17n;
      const carolStake = 6n * 10n ** 17n;
      await stakeAt(griddy, alice, openAt, id, [7], [aliceStake]);
      await stakeAt(griddy, bob, openAt + 5n, id, [7], [bobStake]);
      await stakeAt(griddy, carol, openAt + 9n, id, [8], [carolStake]);
      const r0 = await griddy.rounds(id);
      expect(r0.endTime).to.equal(end);
      expect(r0.drandRound).to.equal(ROUND_10M);

      const feeBps: bigint = await griddy.protocolFeeBps();
      const tipWei: bigint = await griddy.resolverTipWei();
      const reservedBefore = await reservedOf(griddy);
      const balBefore = await ethers.provider.getBalance(proxy);
      const epochBefore = await griddy.roundEpoch();

      // ── the upgrade lands while the round is live and funded ──
      const g9 = await upgradeToV9(griddy);
      expect(await g9.getAddress()).to.equal(proxy);
      expect(await g9.roundEpoch()).to.equal(epochBefore);
      expect(await g9.currentRoundId()).to.equal(id);
      expect(await reservedOf(g9)).to.equal(reservedBefore);
      expect(await ethers.provider.getBalance(proxy)).to.equal(balBefore);
      const r1 = await g9.rounds(id);
      expect(r1.startTime).to.equal(r0.startTime);
      expect(r1.endTime).to.equal(r0.endTime);
      expect(r1.totalStaked).to.equal(aliceStake + bobStake + carolStake);

      // ── resolve the V8-shaped round under V9 code ──
      await time.increaseTo(end + 1n);
      const pool = aliceStake + bobStake + carolStake;
      const cellTotals = new Map<number, bigint>([[7, aliceStake + bobStake], [8, carolStake]]);
      const winner = pickWinner(vrfFromSig(SIG_ROUND_10M), cellTotals, pool);

      const fee = (pool * feeBps) / 10_000n;
      const dist = pool - fee;
      const winTotal = cellTotals.get(winner)!;
      const before = {
        alice: await ethers.provider.getBalance(alice.address),
        bob: await ethers.provider.getBalance(bob.address),
        carol: await ethers.provider.getBalance(carol.address),
      };

      await g9.connect(owner).resolveRound(id, SIG_ROUND_10M);
      const rr = await g9.rounds(id);
      expect(rr.resolved).to.equal(true);
      expect(rr.winningCell).to.equal(winner);

      const expectedOut = (s: bigint) => (dist * s) / winTotal;
      if (winner === 7) {
        expect(await ethers.provider.getBalance(alice.address) - before.alice).to.equal(expectedOut(aliceStake));
        expect(await ethers.provider.getBalance(bob.address) - before.bob).to.equal(expectedOut(bobStake));
        expect(await ethers.provider.getBalance(carol.address)).to.equal(before.carol);
      } else {
        expect(await ethers.provider.getBalance(carol.address) - before.carol).to.equal(expectedOut(carolStake));
        expect(await ethers.provider.getBalance(alice.address)).to.equal(before.alice);
        expect(await ethers.provider.getBalance(bob.address)).to.equal(before.bob);
      }
      // no stake money left reserved for this round, and the contract still
      // holds exactly what it owes
      expect(await g9.totalUnresolvedStakes()).to.equal(0n);
      expect(await ethers.provider.getBalance(proxy)).to.be.greaterThanOrEqual(await reservedOf(g9));
      void tipWei;
    });

    it("the FIRST round opened after the upgrade is already back on the grid", async () => {
      const { alice, griddy, epoch } = await deployV8();
      // a V8 round whose end is deliberately off-grid
      const off = await futureSlot(epoch, 20n);
      const idV8 = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, off.t, idV8, [3], [MIN_STAKE]);
      expect((await griddy.rounds(idV8)).endTime).to.equal(off.t + DUR);
      expect(((await griddy.rounds(idV8)).endTime - epoch) % DUR).to.not.equal(0n);

      const g9 = await upgradeToV9(griddy);
      await time.increaseTo(off.t + DUR + 1n);

      const now = BigInt(await time.latest());
      const predicted = bettableWindow(epoch, now + 1n);
      const idV9 = (await g9.currentRoundId()) + 1n;
      await stakeAt(g9, alice, now + 1n, idV9, [4], [MIN_STAKE]);
      const r = await g9.rounds(idV9);
      expect(r.startTime).to.equal(predicted.wStart);
      expect(r.endTime).to.equal(predicted.wEnd);
      expect((BigInt(r.endTime) - epoch) % DUR).to.equal(0n);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 5. Money math is untouched
  // ════════════════════════════════════════════════════════════

  describe("money math is unchanged by the realignment", () => {
    it("stake-weighted draw + pro-rata split still pays to the wei, and win chance == cell share of pot", async () => {
      const { owner, alice, bob, carol, griddy, epoch } = await deployV9();
      // V9 boundaries are grid slots, so the pin has to be aimed with beaconGap
      // rather than by choosing the end: take the last boundary before
      // ROUND_10M is emitted and let the gap cover the remainder.
      const end = gridStart(epoch, T10M - 3n);
      const gap = T10M - end;
      expect(gap).to.be.greaterThanOrEqual(3n);
      expect(gap).to.be.lessThanOrEqual(60n);
      await griddy.connect(owner).setBeaconGap(gap);
      expect((end - epoch) % DUR, "fixture must land on the grid").to.equal(0n);
      const id = (await griddy.currentRoundId()) + 1n;
      const aStake = 25n * 10n ** 16n;
      const bStake = 75n * 10n ** 16n;
      const cStake = 100n * 10n ** 16n;
      await stakeAt(griddy, alice, end - DUR + 1n, id, [2], [aStake]);
      await stakeAt(griddy, bob, end - DUR + 3n, id, [2], [bStake]);
      await stakeAt(griddy, carol, end - DUR + 5n, id, [9], [cStake]);
      const r = await griddy.rounds(id);
      expect(r.endTime).to.equal(end);
      expect(r.drandRound).to.equal(ROUND_10M);

      const pool = aStake + bStake + cStake;
      // the UI's win-chance formula: share of the POT sitting on your cells
      const cell2 = aStake + bStake;
      expect((cell2 * 1000n) / pool).to.equal(500n);   // 50.0% for alice AND bob
      expect((cStake * 1000n) / pool).to.equal(500n);  // 50.0% for carol

      await time.increaseTo(end + 1n);
      const feeBps: bigint = await griddy.protocolFeeBps();
      const fee = (pool * feeBps) / 10_000n;
      const dist = pool - fee;
      const cellTotals = new Map<number, bigint>([[2, cell2], [9, cStake]]);
      const winner = pickWinner(vrfFromSig(SIG_ROUND_10M), cellTotals, pool);
      const winTotal = cellTotals.get(winner)!;

      const before = {
        alice: await ethers.provider.getBalance(alice.address),
        bob: await ethers.provider.getBalance(bob.address),
        carol: await ethers.provider.getBalance(carol.address),
      };
      await griddy.connect(owner).resolveRound(id, SIG_ROUND_10M);
      expect((await griddy.rounds(id)).winningCell).to.equal(winner);

      const paid = (s: bigint) => (dist * s) / winTotal;
      if (winner === 2) {
        expect(await ethers.provider.getBalance(alice.address) - before.alice).to.equal(paid(aStake));
        expect(await ethers.provider.getBalance(bob.address) - before.bob).to.equal(paid(bStake));
      } else {
        expect(await ethers.provider.getBalance(carol.address) - before.carol).to.equal(paid(cStake));
      }
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
    });
  });
});
