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
const SIG_ROUND_B: [bigint, bigint] = [
  0x13d1b70855d04ea9af3efc4a03378f655459da97819ca4c63427104cf20bd724n,
  0x2c4116eba1899aefcc969a160faa09d164ef5c2dbcef91ad7455ad7c0457d37cn,
];
const ROUND_B = 10_000_013n;

const MIN_STAKE = 10n ** 14n;
const DUR = 30n;
const MIN_BET_WINDOW = 6n;

const timeOfRoundTs = (r: bigint) => EVMNET_GENESIS + (r - 1n) * EVMNET_PERIOD;
const T10M = timeOfRoundTs(ROUND_10M);
const TB = timeOfRoundTs(ROUND_B);

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

const gridStart = (epoch: bigint, t: bigint, d = DUR) =>
  t > epoch ? epoch + ((t - epoch) / d) * d : epoch;
function bettableWindow(epoch: bigint, t: bigint, d = DUR) {
  let wStart = gridStart(epoch, t, d);
  let wEnd = wStart + d;
  if (wEnd - t < MIN_BET_WINDOW) { wStart = wEnd; wEnd = wStart + d; }
  return { wStart, wEnd };
}

describe("GriddyV10 — resolution starts the next round; the grid is the fallback", () => {
  beforeEach(async () => { await reset(); });

  async function deployBeacon() {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    return Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  }

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
    return { owner, alice, bob, carol, beacon, griddy, epoch: await griddy.roundEpoch() };
  }

  async function stakeAt(griddy: any, signer: any, ts: bigint, id: bigint, cells: number[], amounts: bigint[]) {
    await time.setNextBlockTimestamp(ts);
    const value = amounts.reduce((a, b) => a + b, 0n);
    return griddy.connect(signer).stake(id, cells, amounts, { value });
  }

  /** Aim a round's close at `target - gap` so its pin is a real drand round. */
  function aimAt(epoch: bigint, target: bigint) {
    let c = gridStart(epoch, target);
    while (c + DUR > target) c -= DUR;
    const end = c + DUR;
    return { end, gap: target - end };
  }

  const reservedOf = async (g: any) =>
    (await g.totalUnresolvedStakes()) + (await g.pendingRefunds())
    + (await g.pendingWithdrawals()) + (await g.accumulatedFees());

  // ════════════════════════════════════════════════════════════
  // 1. The fast path — resolution starts the clock
  // ════════════════════════════════════════════════════════════

  describe("resolution opens the next round", () => {
    it("the next round starts AT the resolution, with a full roundDuration", async () => {
      const { owner, alice, griddy, epoch } = await deployV10();
      const { end, gap } = aimAt(epoch, T10M);
      expect(gap).to.be.greaterThanOrEqual(3n);
      await griddy.connect(owner).setBeaconGap(gap);

      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, end - DUR + 2n, idA, [3], [MIN_STAKE]);
      expect((await griddy.rounds(idA)).endTime).to.equal(end);

      // keeper resolves 4s after the close — the measured live latency
      const resolveAt = end + 4n;
      await time.setNextBlockTimestamp(resolveAt);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);

      const idB = await griddy.currentRoundId();
      expect(idB, "resolution opened the next round").to.equal(idA + 1n);
      const rB = await griddy.rounds(idB);
      expect(rB.startTime, "starts at the resolution instant").to.equal(resolveAt);
      expect(rB.endTime - rB.startTime, "a FULL window, not one part-spent").to.equal(DUR);
      // this is the whole point: a player looking now sees the full duration
      expect(BigInt(rB.endTime) - resolveAt).to.equal(DUR);
    });

    it("currentWindow reports that fresh round, so a client shows a full clock", async () => {
      const { owner, alice, griddy, epoch } = await deployV10();
      const { end, gap } = aimAt(epoch, T10M);
      await griddy.connect(owner).setBeaconGap(gap);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, end - DUR + 2n, idA, [3], [MIN_STAKE]);

      const resolveAt = end + 5n;
      await time.setNextBlockTimestamp(resolveAt);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);

      const [wStart, wEnd, , secsLeft] = await griddy.currentWindow();
      expect(wStart).to.equal(resolveAt);
      expect(wEnd).to.equal(resolveAt + DUR);
      expect(secsLeft).to.equal(DUR);        // a full clock, exactly as asked
    });

    it("the freshly opened round is immediately stakeable and resolves normally", async () => {
      const { owner, alice, bob, griddy, epoch } = await deployV10();
      const a = aimAt(epoch, T10M);
      await griddy.connect(owner).setBeaconGap(a.gap);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, a.end - DUR + 2n, idA, [3], [MIN_STAKE]);
      const resolveAt = a.end + 4n;
      await time.setNextBlockTimestamp(resolveAt);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);

      const idB = await griddy.currentRoundId();
      const rB = await griddy.rounds(idB);
      // stake into the round resolution just opened
      await stakeAt(griddy, bob, resolveAt + 3n, idB, [9], [2n * MIN_STAKE]);
      expect((await griddy.rounds(idB)).totalStakers).to.equal(1n);

      // and it resolves on its own pin
      await time.increaseTo(BigInt(rB.endTime) + 1n);
      const emitted = await (await deployBeacon()).timeOfRound(rB.drandRound);
      expect(emitted).to.be.greaterThan(rB.endTime);
    });

    it("resolving an OLD round while a newer one is live opens nothing", async () => {
      const { owner, alice, griddy, epoch } = await deployV10();
      // Round A aimed at ROUND_10M, round B aimed at ROUND_B, both staked and
      // ended, so A can be resolved late while B is already the newest.
      const a = aimAt(epoch, T10M);
      await griddy.connect(owner).setBeaconGap(a.gap);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, a.end - DUR + 2n, idA, [3], [MIN_STAKE]);

      const b = aimAt(epoch, TB);
      expect(b.end).to.be.greaterThan(a.end);
      await time.setNextBlockTimestamp(a.end + 1n);
      await griddy.connect(owner).setBeaconGap(b.gap);
      const idB = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, b.end - DUR + 2n, idB, [4], [MIN_STAKE]);
      expect(await griddy.currentRoundId()).to.equal(idB);

      // resolve the OLDER round A now — must not touch currentRoundId
      await time.increaseTo(b.end - 3n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);
      expect(await griddy.currentRoundId(), "no round opened for a stale resolve").to.equal(idB);
      expect((await griddy.rounds(idA)).resolved).to.equal(true);
    });

    it("a paused game does not open a round on resolve", async () => {
      const { owner, alice, griddy, epoch } = await deployV10();
      const { end, gap } = aimAt(epoch, T10M);
      await griddy.connect(owner).setBeaconGap(gap);
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, end - DUR + 2n, idA, [3], [MIN_STAKE]);
      await time.setNextBlockTimestamp(end + 1n);
      await griddy.connect(owner).setPaused(true);
      await time.setNextBlockTimestamp(end + 4n);
      await griddy.connect(owner).resolveRound(idA, SIG_ROUND_10M);
      expect(await griddy.currentRoundId()).to.equal(idA);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 2. The fallback — nothing may halt the game
  // ════════════════════════════════════════════════════════════

  describe("the grid still backstops everything", () => {
    it("an EMPTY round rolls straight on with no dead wait — no resolution needed", async () => {
      const { alice, griddy, epoch } = await deployV10();
      // open a round and let it expire with nobody in it
      const now = BigInt(await time.latest());
      let ws = gridStart(epoch, now) + DUR;
      while (ws + 2n <= now) ws += DUR;
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, ws + 2n, idA, [3], [MIN_STAKE]);
      const endA = BigInt((await griddy.rounds(idA)).endTime);

      // never resolved (keeper absent). A stake 2s after it ends still works,
      // and lands on the grid — no intermission, no stall.
      const t = endA + 2n;
      const predicted = bettableWindow(epoch, t);
      const idB = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, t, idB, [4], [MIN_STAKE]);
      const rB = await griddy.rounds(idB);
      expect(rB.startTime).to.equal(predicted.wStart);
      expect(rB.endTime).to.equal(predicted.wEnd);
      expect(BigInt(rB.startTime)).to.be.lessThanOrEqual(t);   // already running
    });

    it("a keeper that never resolves cannot halt the game", async () => {
      const { alice, griddy, epoch } = await deployV10();
      const now = BigInt(await time.latest());
      let ws = gridStart(epoch, now) + DUR;
      while (ws + 2n <= now) ws += DUR;
      const idA = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, ws + 2n, idA, [3], [5n * MIN_STAKE]);
      const endA = BigInt((await griddy.rounds(idA)).endTime);

      // round A has players and is NEVER resolved
      for (let i = 0; i < 3; i++) {
        const t = endA + BigInt(i + 1) * (DUR + 7n);
        const predicted = bettableWindow(epoch, t);
        const id = (await griddy.currentRoundId()) + 1n;
        await stakeAt(griddy, alice, t, id, [5 + i], [MIN_STAKE]);
        const r = await griddy.rounds(id);
        expect(r.startTime, `round ${i} still opens`).to.equal(predicted.wStart);
        expect(r.endTime).to.equal(predicted.wEnd);
      }
      // and A is still resolvable later — nothing was lost
      expect((await griddy.rounds(idA)).resolved).to.equal(false);
      expect(await griddy.totalUnresolvedStakes()).to.be.greaterThan(0n);
    });

    it("opening can never DECLINE for any config the setters allow, so resolution is never silently degraded", async () => {
      // _openRoundNow bails out if the pin it would choose is not emitted
      // strictly after the round closes. That guard exists so a resolution can
      // never be reverted by round-opening — but it must also be unreachable in
      // practice, or resolutions would quietly stop advancing the game.
      // setBeaconGap allows 3..60, setRoundDuration allows 10..3600.
      const beacon = await deployBeacon();
      for (const gap of [3n, 4n, 17n, 60n]) {
        for (const dur of [10n, 30n, 60n, 600n, 3600n]) {
          for (const off of [0n, 1n, 2n, 3n]) {
            const start = 1_800_000_000n + off;      // arbitrary future instant
            const end = start + dur;
            const dr = await beacon.roundAt(end + gap);
            expect(
              await beacon.timeOfRound(dr),
              `pin must post-date the close: gap ${gap}, dur ${dur}, offset ${off}`
            ).to.be.greaterThan(end);
          }
        }
      }
    });

    it("a resolution that escrows an unpayable winner still opens the next round", async () => {
      // A winner whose receive() reverts is escrowed rather than reverting the
      // resolution — the round-open sits after that loop, so confirm the two
      // cannot interfere.
      const { owner, alice, griddy, epoch } = await deployV10();
      const { end, gap } = aimAt(epoch, T10M);
      await griddy.connect(owner).setBeaconGap(gap);
      const id = (await griddy.currentRoundId()) + 1n;
      await stakeAt(griddy, alice, end - DUR + 2n, id, [3], [MIN_STAKE]);

      const resolveAt = end + 4n;
      await time.setNextBlockTimestamp(resolveAt);
      await griddy.connect(owner).resolveRound(id, SIG_ROUND_10M);

      expect((await griddy.rounds(id)).resolved).to.equal(true);
      expect(await griddy.currentRoundId()).to.equal(id + 1n);
      const next = await griddy.rounds(id + 1n);
      expect(next.startTime).to.equal(resolveAt);
      expect(next.endTime - next.startTime).to.equal(DUR);
      // whatever route the money took, the contract still covers every claim
      expect(await ethers.provider.getBalance(await griddy.getAddress()))
        .to.be.greaterThanOrEqual(await reservedOf(griddy));
    });
  });

  // ════════════════════════════════════════════════════════════
  // 3. Money is untouched
  // ════════════════════════════════════════════════════════════

  describe("money math and solvency are unchanged", () => {
    it("stake-weighted draw + pro-rata payout still lands to the wei, and the new round holds no money", async () => {
      const { owner, alice, bob, carol, griddy, epoch } = await deployV10();
      const { end, gap } = aimAt(epoch, T10M);
      await griddy.connect(owner).setBeaconGap(gap);

      const id = (await griddy.currentRoundId()) + 1n;
      const aS = 25n * 10n ** 16n, bS = 75n * 10n ** 16n, cS = 100n * 10n ** 16n;
      await stakeAt(griddy, alice, end - DUR + 1n, id, [2], [aS]);
      await stakeAt(griddy, bob, end - DUR + 3n, id, [2], [bS]);
      await stakeAt(griddy, carol, end - DUR + 5n, id, [9], [cS]);

      const pool = aS + bS + cS;
      const feeBps: bigint = await griddy.protocolFeeBps();
      const dist = pool - (pool * feeBps) / 10_000n;
      const totals = new Map<number, bigint>([[2, aS + bS], [9, cS]]);
      const winner = pickWinner(vrfFromSig(SIG_ROUND_10M), totals, pool);
      const winTotal = totals.get(winner)!;

      await time.increaseTo(end + 4n);
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

      // the round resolution opened is empty and reserves nothing
      const fresh = await griddy.rounds(await griddy.currentRoundId());
      expect(fresh.totalStaked).to.equal(0n);
      expect(fresh.totalStakers).to.equal(0n);
      expect(await ethers.provider.getBalance(await griddy.getAddress()))
        .to.be.greaterThanOrEqual(await reservedOf(griddy));
    });
  });

  // ════════════════════════════════════════════════════════════
  // 4. Upgrade from the live V9
  // ════════════════════════════════════════════════════════════

  describe("upgrade V9 → V10", () => {
    it("preserves every slot with money in flight, and the in-flight round resolves and opens the next", async () => {
      const { owner, alice, bob, griddy, epoch } = await deployV9();
      const proxy = await griddy.getAddress();
      const { end, gap } = aimAt(epoch, T10M);
      await griddy.connect(owner).setBeaconGap(gap);

      const id = (await griddy.currentRoundId()) + 1n;
      const aS = 3n * 10n ** 17n, bS = 1n * 10n ** 17n;
      await stakeAt(griddy, alice, end - DUR + 2n, id, [7], [aS]);
      await stakeAt(griddy, bob, end - DUR + 4n, id, [8], [bS]);

      const snap = {
        round: await griddy.currentRoundId(),
        epoch: await griddy.roundEpoch(),
        fees: await griddy.accumulatedFees(),
        unresolved: await griddy.totalUnresolvedStakes(),
        owner: await griddy.owner(),
        dur: await griddy.roundDuration(),
        bal: await ethers.provider.getBalance(proxy),
      };
      const liveBefore = await griddy.rounds(id);

      const g10 = await upgradeToV10(griddy);
      expect(await g10.getAddress()).to.equal(proxy);
      expect(await g10.currentRoundId()).to.equal(snap.round);
      expect(await g10.roundEpoch()).to.equal(snap.epoch);
      expect(await g10.accumulatedFees()).to.equal(snap.fees);
      expect(await g10.totalUnresolvedStakes()).to.equal(snap.unresolved);
      expect(await g10.owner()).to.equal(snap.owner);
      expect(await g10.roundDuration()).to.equal(snap.dur);
      expect(await ethers.provider.getBalance(proxy)).to.equal(snap.bal);
      const liveAfter = await g10.rounds(id);
      expect(liveAfter.startTime).to.equal(liveBefore.startTime);
      expect(liveAfter.endTime).to.equal(liveBefore.endTime);
      expect(liveAfter.totalStaked).to.equal(liveBefore.totalStaked);

      // the V9-shaped round resolves under V10 and opens the next one
      const resolveAt = end + 4n;
      await time.setNextBlockTimestamp(resolveAt);
      await g10.connect(owner).resolveRound(id, SIG_ROUND_10M);
      expect((await g10.rounds(id)).resolved).to.equal(true);
      expect(await g10.currentRoundId()).to.equal(id + 1n);
      const next = await g10.rounds(id + 1n);
      expect(next.startTime).to.equal(resolveAt);
      expect(next.endTime - next.startTime).to.equal(DUR);
      expect(await ethers.provider.getBalance(proxy)).to.be.greaterThanOrEqual(await reservedOf(g10));
    });

    it("needs no initializer — V10 appends no storage", async () => {
      const { griddy, epoch } = await deployV9();
      const g10 = await upgradeToV10(griddy);
      expect(await g10.roundEpoch()).to.equal(epoch);
      expect(await g10.roundDuration()).to.equal(DUR);
    });
  });
});
