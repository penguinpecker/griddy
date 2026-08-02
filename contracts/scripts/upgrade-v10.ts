import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Upgrades the live Griddy proxy to V10 and opens the reveal intermission.
 *
 *  V10 steps the grid by CYCLE = roundDuration + revealGap: betting occupies
 *  the first roundDuration of each cycle, the remainder is dead time reserved
 *  for resolution and the winner reveal. So the next round's clock genuinely
 *  starts AFTER the result has been shown, instead of the instant the previous
 *  round closed.
 *
 *  Two transactions on purpose:
 *    1. upgradeProxy      — revealGap is still 0, so the cycle collapses to
 *                           roundDuration and behaviour is identical to V9.
 *                           Nothing about live timing changes in this tx.
 *    2. initializeV10()   — opens the gap AND re-anchors roundEpoch to the live
 *                           round's close, so the longer cycle takes effect
 *                           cleanly from the next round rather than re-phasing
 *                           the grid underneath the one already open.
 */
async function main() {
  const chainId = network.config.chainId;
  if ((chainId === 4663 || chainId === 5042) && process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error("Mainnet upgrade requires CONFIRM_MAINNET=yes");
  }

  const file = path.join(__dirname, `../deployments/griddy-${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const proxy = dep.griddy;
  const [signer] = await ethers.getSigners();

  const before = await ethers.getContractAt("GriddyV9", proxy);
  const snap = {
    roundId: await before.currentRoundId(),
    fees: await before.accumulatedFees(),
    unresolved: await before.totalUnresolvedStakes(),
    owner: await before.owner(),
    minStake: await before.minStakeWei(),
    duration: await before.roundDuration(),
    gap: await before.beaconGap(),
    feeBps: await before.protocolFeeBps(),
    tip: await before.resolverTipWei(),
    epoch: await before.roundEpoch(),
    balance: await ethers.provider.getBalance(proxy),
  };
  const wBefore = await before.currentWindow();
  const liveRound = await before.rounds(snap.roundId);
  console.log(`proxy ${proxy}`);
  console.log(`  before: round=${snap.roundId} fees=${ethers.formatEther(snap.fees)} unresolved=${ethers.formatEther(snap.unresolved)}`);
  console.log(`          roundDuration=${snap.duration}s beaconGap=${snap.gap}s feeBps=${snap.feeBps} minStakeWei=${snap.minStake}`);
  console.log(`          roundEpoch=${snap.epoch}  balance=${ethers.formatEther(snap.balance)}`);
  console.log(`          currentWindow: [${wBefore.windowStart}, ${wBefore.windowEnd}) secondsLeft=${wBefore.secondsLeft}`);
  console.log(`          live round ${snap.roundId}: [${liveRound.startTime}, ${liveRound.endTime}) resolved=${liveRound.resolved} stakers=${liveRound.totalStakers}`);
  console.log(`  signer: ${signer.address}`);
  if (signer.address.toLowerCase() !== snap.owner.toLowerCase()) {
    throw new Error(`signer is not the owner (${snap.owner}) — initializeV10 is onlyOwner`);
  }

  // ── 1. implementation swap (behaviour-preserving: revealGap still 0) ──
  const V10 = await ethers.getContractFactory("GriddyV10");
  const v10 = await upgrades.upgradeProxy(proxy, V10);
  await v10.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`\n  [1/2] upgraded. new impl: ${impl}`);
  const gapAfterUpgrade = await v10.revealGap();
  console.log(`        revealGap after upgrade = ${gapAfterUpgrade} (0 = timing unchanged, exactly as V9)`);
  if (gapAfterUpgrade !== 0n) {
    console.log(`        note: gap already non-zero — initializeV10 will be a no-op`);
  }

  // ── 2. open the intermission + re-anchor the grid ──
  const tx = await v10.initializeV10();
  await tx.wait();
  console.log(`  [2/2] initializeV10 mined: ${tx.hash}`);

  const after = {
    roundId: await v10.currentRoundId(),
    fees: await v10.accumulatedFees(),
    unresolved: await v10.totalUnresolvedStakes(),
    owner: await v10.owner(),
    minStake: await v10.minStakeWei(),
    duration: await v10.roundDuration(),
    gap: await v10.beaconGap(),
    feeBps: await v10.protocolFeeBps(),
    tip: await v10.resolverTipWei(),
    epoch: await v10.roundEpoch(),
    revealGap: await v10.revealGap(),
    balance: await ethers.provider.getBalance(proxy),
  };
  const w = await v10.currentWindow();
  const liveAfter = await v10.rounds(snap.roundId);
  const cycle = after.duration + after.revealGap;
  console.log(`\n  after:  round=${after.roundId} fees=${ethers.formatEther(after.fees)} unresolved=${ethers.formatEther(after.unresolved)}`);
  console.log(`          roundDuration=${after.duration}s revealGap=${after.revealGap}s  => CYCLE ${cycle}s`);
  console.log(`          roundEpoch=${after.epoch} (re-anchored from ${snap.epoch})`);
  console.log(`          currentWindow: [${w.windowStart}, ${w.windowEnd}) secondsLeft=${w.secondsLeft}`);

  const reserved = after.unresolved
    + (await v10.pendingRefunds())
    + (await v10.pendingWithdrawals())
    + after.fees;

  const checks: [string, boolean][] = [
    ["round preserved", after.roundId >= snap.roundId],
    ["owner preserved", after.owner === snap.owner],
    ["fees preserved", after.fees >= snap.fees],
    ["solvent: balance covers every claim", after.balance >= reserved],
    ["minStakeWei untouched", after.minStake === snap.minStake],
    ["roundDuration untouched", after.duration === snap.duration],
    ["beaconGap untouched", after.gap === snap.gap],
    ["protocolFeeBps untouched", after.feeBps === snap.feeBps],
    ["resolverTipWei untouched", after.tip === snap.tip],
    ["revealGap opened", after.revealGap > 0n],
    ["grid still anchored", after.epoch !== 0n],
    // the round that was live must keep the exact window it was opened with
    ["live round's window unmoved", liveAfter.startTime === liveRound.startTime && liveAfter.endTime === liveRound.endTime],
    ["live round's stake unmoved", liveAfter.totalStaked === liveRound.totalStaked],
    // the re-anchor must not sit before the live round's close, or the next
    // cycle would overlap the round it follows
    ["grid re-anchored at/after the live round's close", after.epoch >= liveRound.endTime],
    ["betting window is roundDuration, not the whole cycle", w.windowEnd - w.windowStart === after.duration],
    ["advertised window sits on the new cycle grid", (BigInt(w.windowStart) - after.epoch) % cycle === 0n],
  ];
  let allOk = true;
  for (const [n, ok] of checks) { console.log(`  ${ok ? "✓" : "✗"} ${n}`); if (!ok) allOk = false; }
  if (!allOk) throw new Error("post-upgrade checks FAILED");

  dep.griddyImpl = impl;
  dep.version = "V10";
  dep.revealGap = Number(after.revealGap);
  dep.upgradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`\nWrote ${file}`);
  console.log(`Rounds now run ${after.duration}s of betting followed by a ${after.revealGap}s reveal intermission (${cycle}s cycle).`);
  console.log(`The next round's clock starts only after the intermission — i.e. after the winner has been shown.`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
