import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Upgrades the live Griddy proxy to V10: RESOLUTION starts the next round.
 *
 *  When the round that just settled is the newest one, resolveRound opens the
 *  next round starting at that instant — so a player sees a full roundDuration
 *  begin the moment the winner is known, instead of a clock already part-spent.
 *
 *  The grid is kept as the fallback: when nothing resolves (an empty round, or
 *  a keeper that is slow or gone) the next stake opens a round on the grid
 *  exactly as V9 does, so no single actor can halt the game by declining to
 *  resolve. Opening can never revert a resolution — if the beacon invariant
 *  cannot be met it silently declines and the grid path takes over.
 *
 *  Pure logic change: no new storage, so there is NO initializer call. */
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
  const liveBefore = await before.rounds(snap.roundId);
  console.log(`proxy ${proxy}`);
  console.log(`  before: round=${snap.roundId} fees=${ethers.formatEther(snap.fees)} unresolved=${ethers.formatEther(snap.unresolved)}`);
  console.log(`          roundDuration=${snap.duration}s beaconGap=${snap.gap}s feeBps=${snap.feeBps} minStakeWei=${snap.minStake}`);
  console.log(`          roundEpoch=${snap.epoch}  balance=${ethers.formatEther(snap.balance)}`);
  console.log(`          currentWindow: [${wBefore.windowStart}, ${wBefore.windowEnd}) secondsLeft=${wBefore.secondsLeft}`);
  console.log(`          live round ${snap.roundId}: [${liveBefore.startTime}, ${liveBefore.endTime}) resolved=${liveBefore.resolved} stakers=${liveBefore.totalStakers}`);
  console.log(`  signer: ${signer.address}`);

  const V10 = await ethers.getContractFactory("GriddyV10");
  const v10 = await upgrades.upgradeProxy(proxy, V10);
  await v10.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`\n  upgraded. new impl: ${impl}`);

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
    balance: await ethers.provider.getBalance(proxy),
  };
  const w = await v10.currentWindow();
  const liveAfter = await v10.rounds(snap.roundId);
  console.log(`  after:  round=${after.roundId} fees=${ethers.formatEther(after.fees)} unresolved=${ethers.formatEther(after.unresolved)}`);
  console.log(`          roundDuration=${after.duration}s beaconGap=${after.gap}s roundEpoch=${after.epoch}`);
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
    ["roundEpoch untouched (no initializer ran)", after.epoch === snap.epoch],
    ["fallback grid still anchored", after.epoch !== 0n],
    ["live round's window unmoved", liveAfter.startTime === liveBefore.startTime && liveAfter.endTime === liveBefore.endTime],
    ["live round's stake unmoved", liveAfter.totalStaked === liveBefore.totalStaked],
    ["advertised window is a full roundDuration", w.windowEnd - w.windowStart === after.duration],
  ];
  let allOk = true;
  for (const [n, ok] of checks) { console.log(`  ${ok ? "✓" : "✗"} ${n}`); if (!ok) allOk = false; }
  if (!allOk) throw new Error("post-upgrade checks FAILED");

  dep.griddyImpl = impl;
  dep.version = "V10";
  dep.upgradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`\nWrote ${file}`);
  console.log(`Resolution now starts the next round: a full ${after.duration}s begins the moment a winner is known.`);
  console.log(`The grid remains the fallback — empty rounds roll straight on, and a stalled keeper cannot halt the game.`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
