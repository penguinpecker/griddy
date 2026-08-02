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
const DUR = 30n;                 // default roundDuration
const GAP = 12n;                 // DEFAULT_REVEAL_GAP
const CYC = DUR + GAP;
const MIN_BET_WINDOW = 6n;

const timeOfRoundTs = (r: bigint) => EVMNET_GENESIS + (r - 1n) * EVMNET_PERIOD;
const T10M = timeOfRoundTs(ROUND_10M);

const vrfFromSig = (sig: [bigint, bigint]) =>
  BigInt(ethers.solidityPackedKeccak256(["uint256", "uint256"], [sig[0], sig[1]]));

function pickWinner(vrf: bigint, cellTotals: Map<number, bigint>, pool: bigint) {
  const target = vrf % pool;
  let acc = 0n;
  for (let i = 0; i < 25; i++) {
    acc += cellTotals.get(i) ?? 0n;
    if (target < acc) return i;
  }
  throw new Error("no winner drawn");
}

// ─── cycle replicas (mirror _cycleOf / _bettableWindow exactly) ───
function cycleOf(epoch: bigint, t: bigint, dur = DUR, gap = GAP) {
  const cyc = dur + gap;
  const idx = t > epoch ? (t - epoch) / cyc : 0n;
  const cStart = epoch + idx * cyc;
  return { cStart, betEnd: cStart + dur, cEnd: cStart + cyc };
}
function bettableWindow(epoch: bigint, t: bigint, dur = DUR, gap = GAP) {
  const { cStart, betEnd, cEnd } = cycleOf(epoch, t, dur, gap);
  if (t < betEnd && betEnd - t >= MIN_BET_WINDOW) return { wStart: cStart, wEnd: betEnd };
  return { wStart: cEnd, wEnd: cEnd + dur };
}

/** The latest betting-close at or before `target`. The cycle containing
 *  `target` may close AFTER it (when target lands in the betting half), so this
 *  walks back a cycle at a time instead of assuming. */
function latestCloseAtOrBefore(epoch: bigint, target: bigint) {
  let c = cycleOf(epoch, target).cStart;
  while (c + DUR > target) c -= CYC;
  return c + DUR;
}

describe("GriddyV10 — a reveal intermission sits between rounds", () => {
  beforeEach(async () => { await reset(); });

  async function deployBeacon() {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    return Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  }

  /** The live proxy's current shape: V9 behind UUPS. */
  async function deployV9() {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const beacon = await deployBeacon();
    const V9 = await ethers.getContractFactory("GriddyV9");
    const griddy: any = await upgrades.deployProxy(
      V9, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    return { owner, alice, bob, carol, beacon, griddy, epoch: await griddy.roundEpoch() };
  }

  async function upgradeToV10(griddy: any): Promise<any> {
    const V10 = await ethers.getContractFactory("GriddyV10");
    return upgrades.upgradeProxy(await griddy.getAddress(), V10);
  }

  async function deployV10() {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const beacon = await deployBeacon();
    const V10 = await ethers.getContractFactory("GriddyV10");
    const griddy: any = await upgrades.deployProxy(
      V10, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    const epoch: bigint = await griddy.roundEpoch();
    expect(await griddy.revealGap()).to.equal(GAP);
    const first = await griddy.rounds(1n);
    expect(first.startTime).to.equal(epoch);
    expect(first.endTime).to.equal(epoch + DUR);   // betting occupies dur, not cycle
    return { owner, alice, bob, carol, beacon, griddy, epoch };
  }

  async function stakeAt(griddy: any, signer: any, ts: bigint, id: bigint, cells: number[], amounts: bigint[]) {
    await time.setNextBlockTimestamp(ts);
    const value = amounts.reduce((a, b) => a + b, 0n);
    return griddy.connect(signer).stake(id, cells, amounts, { value });
  }

  /** A timestamp `offset` seconds into a CYCLE strictly after now. */
  async function futureCycle(epoch: bigint, offset: bigint) {
    const now = BigInt(await time.latest());
    let cs = cycleOf(epoch, now).cStart + CYC;
    while (cs + offset <= now) cs += CYC;
    return { cs, t: cs + offset };
  }

  const reservedOf = async (g: any) =>
    (await g.totalUnresolvedStakes()) + (await g.pendingRefunds())
    + (await g.pendingWithdrawals()) + (await g.accumulatedFees());

  // ════════════════════════════════════════════════════════════
  // 1. The intermission itself
  // ════════════════════════════════════════════════════════════

  describe("cycle shape", () => {
    it("betting occupies only the first roundDuration of each cycle", async () => {
      const { alice, griddy, epoch } = await deployV10();
      for (const offset of [0n, 1n, 12n, 23n]) {
        const { cs, t } = await futureCycle(epoch, offset);
        const id = (await griddy.currentRoundId()) + 1n;
        await stakeAt(griddy, alice, t, id, [3], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect(r.startTime, `offset ${offset}`).to.equal(cs);
        expect(r.endTime, `offset ${offset}`).to.equal(cs + DUR);
        // the cycle runs GAP seconds longer than the betting window
        expect(cs + CYC - BigInt(r.endTime)).to.equal(GAP);
      }
    });

    it("a stake landing INSIDE the intermission opens the next cycle, not this one", async () => {
      const { alice, griddy, epoch } = await deployV10();
      // 4s into the intermission
      const { cs, t } = await futureCycle(epoch, DUR + 4n);
      const id = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, t, id, [5], [MIN_STAKE]);
      const r = await griddy.rounds(id);
      expect(r.startTime).to.equal(cs + CYC);          // next cycle
      expect(r.endTime).to.equal(cs + CYC + DUR);
      // and it has not started yet — the player pre-bought into it
      expect(r.startTime).to.be.greaterThan(t);
      expect(r.endTime - r.startTime).to.equal(DUR);
    });

    it("the gap between one round closing and the next opening is exactly revealGap", async () => {
      const { alice, griddy, epoch } = await deployV10();
      const a = await futureCycle(epoch, 2n);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, a.t, idA, [1], [MIN_STAKE]);
      const rA = await griddy.rounds(idA);

      // next stake after A's betting closes, inside the intermission
      const idB = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, BigInt(rA.endTime) + 2n, idB, [2], [MIN_STAKE]);
      const rB = await griddy.rounds(idB);

      expect(BigInt(rB.startTime) - BigInt(rA.endTime)).to.equal(GAP);
    });

    it("a late stake still rolls forward a whole cycle, never into a sliver", async () => {
      const { alice, griddy, epoch } = await deployV10();
      const { cs, t } = await futureCycle(epoch, DUR - 3n);   // 3s of betting left
      const id = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, t, id, [7], [MIN_STAKE]);
      const r = await griddy.rounds(id);
      expect(r.startTime).to.equal(cs + CYC);
      expect(r.endTime - r.startTime).to.equal(DUR);
    });

    it("every boundary is a whole number of cycles from the epoch — no drift", async () => {
      const { alice, griddy, epoch } = await deployV10();
      for (let i = 0; i < 6; i++) {
        const { t } = await futureCycle(epoch, 3n + BigInt(i) * 4n);
        const id = (await griddy.currentRoundId()) + 1n;
        await stakeAt(griddy, alice, t, id, [i % 25], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect((BigInt(r.startTime) - epoch) % CYC, "start on cycle").to.equal(0n);
        expect(r.endTime - r.startTime).to.equal(DUR);
      }
    });

    it("two rounds can never share a cycle", async () => {
      const { alice, bob, griddy, epoch } = await deployV10();
      const a = await futureCycle(epoch, 1n);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, a.t, idA, [1], [MIN_STAKE]);
      // a second staker inside the same betting window joins A
      await stakeAt(griddy, bob, a.cs + 5n, idA, [2], [MIN_STAKE]);
      expect(await griddy.currentRoundId()).to.equal(idA);

      const idB = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, a.cs + CYC + 1n, idB, [3], [MIN_STAKE]);
      const rA = await griddy.rounds(idA), rB = await griddy.rounds(idB);
      expect(BigInt(rB.startTime) - BigInt(rA.startTime)).to.equal(CYC);
      expect(rB.startTime).to.be.greaterThanOrEqual(rA.endTime);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 2. currentWindow contract with the client
  // ════════════════════════════════════════════════════════════

  describe("currentWindow", () => {
    it("idle reading is exactly the window the next stake opens, at every offset in the cycle", async () => {
      const { alice, griddy, epoch } = await deployV10();
      await time.increaseTo(epoch + DUR + 1n);

      for (const offset of [0n, 9n, 22n, DUR + 1n, DUR + 8n]) {
        const { t } = await futureCycle(epoch, offset);
        await time.setNextBlockTimestamp(t);
        await ethers.provider.send("evm_mine", []);
        const [wStart, wEnd, drandRound] = await griddy.currentWindow();
        const id = (await griddy.currentRoundId()) + 1n;
        await stakeAt(griddy, alice, t + 1n, id, [4], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect(r.startTime, `offset ${offset}`).to.equal(wStart);
        expect(r.endTime, `offset ${offset}`).to.equal(wEnd);
        expect(r.drandRound, `offset ${offset}`).to.equal(drandRound);
      }
    });

    it("during an intermission it advertises a window that has NOT started yet", async () => {
      const { griddy, epoch } = await deployV10();
      const { cs } = await futureCycle(epoch, 0n);
      await time.increaseTo(cs + DUR + 3n);      // 3s into the intermission
      const now = BigInt(await time.latest());
      const [wStart, wEnd, , secondsLeft] = await griddy.currentWindow();
      expect(wStart).to.be.greaterThan(now);      // betting is not open yet
      expect(wStart).to.equal(cs + CYC);
      expect(wEnd - wStart).to.equal(DUR);
      // secondsLeft spans the rest of the intermission PLUS the whole window,
      // which is exactly why a client must gate on windowStart
      expect(secondsLeft).to.equal(wEnd - now);
      expect(secondsLeft).to.be.greaterThan(DUR);
    });

    it("a client mirroring the cycle from (roundEpoch, roundDuration, revealGap, now) agrees with the chain", async () => {
      const { griddy, epoch } = await deployV10();
      await time.increaseTo(epoch + CYC + 1n);
      for (const skip of [1n, 7n, 19n, 33n, 41n, 260n, 3_000n]) {
        await time.increase(skip);
        const now = BigInt(await time.latest());
        const [wStart, wEnd] = await griddy.currentWindow();
        const p = bettableWindow(epoch, now);
        expect(wStart, `skip ${skip}`).to.equal(p.wStart);
        expect(wEnd, `skip ${skip}`).to.equal(p.wEnd);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 3. Fairness + money
  // ════════════════════════════════════════════════════════════

  describe("beacon fairness", () => {
    it("pins a beacon emitted strictly AFTER the betting close, at every offset including the intermission", async () => {
      const { alice, beacon, griddy, epoch } = await deployV10();
      for (const offset of [0n, 5n, 17n, 26n, DUR + 1n, DUR + 9n]) {
        const { t } = await futureCycle(epoch, offset);
        const id = (await griddy.currentRoundId()) + 1n;
        await stakeAt(griddy, alice, t, id, [5], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect(await beacon.timeOfRound(r.drandRound), `offset ${offset}`)
          .to.be.greaterThan(r.endTime);
      }
    });
  });

  describe("money math is untouched by the intermission", () => {
    it("stake-weighted draw + pro-rata split still pays to the wei", async () => {
      const { owner, alice, bob, carol, griddy, epoch } = await deployV10();
      // aim the pin at real drand ROUND_10M by choosing beaconGap
      const end = latestCloseAtOrBefore(epoch, T10M - 3n);
      const gap = T10M - end;
      expect(gap).to.be.greaterThanOrEqual(3n);
      expect(gap).to.be.lessThanOrEqual(60n);
      await griddy.connect(owner).setBeaconGap(gap);

      const id = (await griddy.currentRoundId()) + 1n;
      const aS = 25n * 10n ** 16n, bS = 75n * 10n ** 16n, cS = 100n * 10n ** 16n;
      await stakeAt(griddy, alice, end - DUR + 1n, id, [2], [aS]);
      await stakeAt(griddy, bob, end - DUR + 3n, id, [2], [bS]);
      await stakeAt(griddy, carol, end - DUR + 5n, id, [9], [cS]);
      const r = await griddy.rounds(id);
      expect(r.endTime).to.equal(end);
      expect(r.drandRound).to.equal(ROUND_10M);

      await time.increaseTo(end + 1n);
      const pool = aS + bS + cS;
      const feeBps: bigint = await griddy.protocolFeeBps();
      const dist = pool - (pool * feeBps) / 10_000n;
      const totals = new Map<number, bigint>([[2, aS + bS], [9, cS]]);
      const winner = pickWinner(vrfFromSig(SIG_ROUND_10M), totals, pool);
      const winTotal = totals.get(winner)!;

      const before = {
        a: await ethers.provider.getBalance(alice.address),
        b: await ethers.provider.getBalance(bob.address),
        c: await ethers.provider.getBalance(carol.address),
      };
      await griddy.connect(owner).resolveRound(id, SIG_ROUND_10M);
      expect((await griddy.rounds(id)).winningCell).to.equal(winner);
      const paid = (s: bigint) => (dist * s) / winTotal;
      if (winner === 2) {
        expect(await ethers.provider.getBalance(alice.address) - before.a).to.equal(paid(aS));
        expect(await ethers.provider.getBalance(bob.address) - before.b).to.equal(paid(bS));
      } else {
        expect(await ethers.provider.getBalance(carol.address) - before.c).to.equal(paid(cS));
      }
      expect(await griddy.totalUnresolvedStakes()).to.equal(0n);
    });

    it("resolution fits inside the intermission — a round is resolvable before the next one opens", async () => {
      const { owner, alice, griddy, epoch } = await deployV10();
      const end = latestCloseAtOrBefore(epoch, T10M - 3n);
      await griddy.connect(owner).setBeaconGap(T10M - end);
      const id = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, end - DUR + 1n, id, [4], [5n * 10n ** 16n]);

      // 4s after close — mid-intermission, the keeper's measured latency
      await time.increaseTo(end + 4n);
      await griddy.connect(owner).resolveRound(id, SIG_ROUND_10M);
      const r = await griddy.rounds(id);
      expect(r.resolved).to.equal(true);
      // the next betting window has still not opened
      const now = BigInt(await time.latest());
      expect(BigInt(r.endTime) + GAP).to.be.greaterThan(now);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 4. Upgrade safety — the whole point of the zero guard
  // ════════════════════════════════════════════════════════════

  describe("upgrade V9 → V10", () => {
    it("the upgrade alone changes NO timing: revealGap is 0 until initializeV10 runs", async () => {
      const { alice, griddy, epoch } = await deployV9();
      const g10 = await upgradeToV10(griddy);
      expect(await g10.revealGap()).to.equal(0n);

      // with gap 0 the cycle collapses to roundDuration — V9 behaviour exactly
      const now = BigInt(await time.latest());
      let cs = cycleOf(epoch, now, DUR, 0n).cStart + DUR;
      while (cs + 2n <= now) cs += DUR;
      const id = (await g10.currentRoundId()) + 1n;
      await stakeAt(g10, alice, cs + 2n, id, [3], [MIN_STAKE]);
      const r = await g10.rounds(id);
      expect(r.startTime).to.equal(cs);
      expect(r.endTime).to.equal(cs + DUR);        // back-to-back, no gap
    });

    it("initializeV10 opens the gap, preserves every slot, and is idempotent", async () => {
      const { owner, alice, griddy, epoch } = await deployV9();
      // money in flight across the upgrade
      const now0 = BigInt(await time.latest());
      let cs = cycleOf(epoch, now0, DUR, 0n).cStart + DUR;
      while (cs + 1n <= now0) cs += DUR;
      const idLive = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, cs + 1n, idLive, [6], [4n * 10n ** 16n]);

      const before = {
        round: await griddy.currentRoundId(),
        epoch: await griddy.roundEpoch(),
        dur: await griddy.roundDuration(),
        fees: await griddy.accumulatedFees(),
        unresolved: await griddy.totalUnresolvedStakes(),
        owner: await griddy.owner(),
        bal: await ethers.provider.getBalance(await griddy.getAddress()),
      };
      const liveWindow = await griddy.rounds(idLive);

      const g10 = await upgradeToV10(griddy);
      // permissionless callers are now rejected outright
      const [, , , , stranger] = await ethers.getSigners();
      await expect(g10.connect(stranger).initializeV10()).to.be.reverted;

      await g10.connect(owner).initializeV10();
      expect(await g10.revealGap()).to.equal(GAP);

      expect(await g10.currentRoundId()).to.equal(before.round);
      expect(await g10.roundDuration()).to.equal(before.dur);
      // the grid is deliberately RE-ANCHORED so the longer cycle takes effect
      // from the live round's close instead of re-phasing underneath it
      const newEpoch: bigint = await g10.roundEpoch();
      expect(newEpoch).to.equal(BigInt(liveWindow.endTime));
      expect(newEpoch).to.not.equal(before.epoch);
      expect(await g10.accumulatedFees()).to.equal(before.fees);
      expect(await g10.totalUnresolvedStakes()).to.equal(before.unresolved);
      expect(await g10.owner()).to.equal(before.owner);
      expect(await ethers.provider.getBalance(await g10.getAddress())).to.equal(before.bal);
      // the round already open keeps the exact window it was opened with
      const after = await g10.rounds(idLive);
      expect(after.startTime).to.equal(liveWindow.startTime);
      expect(after.endTime).to.equal(liveWindow.endTime);
      expect(after.totalStaked).to.equal(liveWindow.totalStaked);

      // reinitializer(5) cannot run twice
      await expect(g10.connect(owner).initializeV10()).to.be.reverted;
    });

    it("initializeV10 is owner-gated and never overwrites a gap already set", async () => {
      const { owner, griddy } = await deployV10();          // fresh: gap already set
      await griddy.connect(owner).setRevealGap(25n);
      // reinitializer(5) is unclaimed on a fresh deploy, but no longer callable
      // by a stranger — that was the single most-reported audit surface
      const [, stranger] = await ethers.getSigners();
      await expect(griddy.connect(stranger).initializeV10()).to.be.reverted;
      // and the owner running it is a no-op, not a re-time
      const epochBefore = await griddy.roundEpoch();
      await griddy.connect(owner).initializeV10();
      expect(await griddy.revealGap()).to.equal(25n);        // untouched
      expect(await griddy.roundEpoch()).to.equal(epochBefore);
    });

    it("the first cycle after migration is full length and does not overlap the round it follows", async () => {
      const { owner, alice, griddy, epoch } = await deployV9();
      // a live V9 round straddling the upgrade
      const now0 = BigInt(await time.latest());
      let cs = cycleOf(epoch, now0, DUR, 0n).cStart + DUR;
      while (cs + 1n <= now0) cs += DUR;
      const idLive = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, cs + 1n, idLive, [6], [MIN_STAKE]);
      const liveEnd = BigInt((await griddy.rounds(idLive)).endTime);

      const g10 = await upgradeToV10(griddy);
      await g10.connect(owner).initializeV10();
      const newEpoch: bigint = await g10.roundEpoch();

      // first round opened after the live one closes
      await time.increaseTo(liveEnd + 1n);
      const idNext = (await g10.currentRoundId()) + 1n;
      await stakeAt(g10, alice, liveEnd + 2n, idNext, [7], [MIN_STAKE]);
      const rNext = await g10.rounds(idNext);

      expect(rNext.startTime, "no overlap with the round it follows")
        .to.be.greaterThanOrEqual(liveEnd);
      expect(rNext.endTime - rNext.startTime, "full betting window").to.equal(DUR);
      expect((BigInt(rNext.startTime) - newEpoch) % (DUR + GAP), "on the new cycle grid").to.equal(0n);
    });
  });

  describe("setRevealGap", () => {
    it("is owner-only and bounded", async () => {
      const { owner, alice, griddy } = await deployV10();
      await expect(griddy.connect(alice).setRevealGap(5n)).to.be.reverted;
      await expect(griddy.connect(owner).setRevealGap(301n)).to.be.revertedWith("gap too long");
      await griddy.connect(owner).setRevealGap(0n);
      expect(await griddy.revealGap()).to.equal(0n);
      await griddy.connect(owner).setRevealGap(300n);
      expect(await griddy.revealGap()).to.equal(300n);
    });

    it("never moves a round that is already open", async () => {
      const { owner, alice, griddy, epoch } = await deployV10();
      const { t } = await futureCycle(epoch, 2n);
      const id = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, t, id, [8], [MIN_STAKE]);
      const before = await griddy.rounds(id);
      await griddy.connect(owner).setRevealGap(120n);
      const after = await griddy.rounds(id);
      expect(after.startTime).to.equal(before.startTime);
      expect(after.endTime).to.equal(before.endTime);
      expect(after.drandRound).to.equal(before.drandRound);
    });
  });
});
