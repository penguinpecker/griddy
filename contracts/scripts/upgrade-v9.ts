import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Upgrades the live Griddy proxy to V9: round boundaries go back on the fixed
 *  grid, so a round's deadline no longer depends on the moment somebody staked.
 *  The countdown becomes a pure function of (roundEpoch, roundDuration, now) —
 *  identical on every client and ticking through rounds nobody plays. V8's
 *  anti-sliver guarantee is kept via the MIN_BET_WINDOW roll. Pure logic change
 *  — no new storage, so there is NO initializer call: everything the proxy
 *  holds, roundEpoch included, is carried over untouched. */
async function main() {
  // Guard first: real money lives behind the Arc mainnet proxy, so bail out
  // before touching the network at all.
  const chainId = network.config.chainId;
  if ((chainId === 4663 || chainId === 5042) && process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error("Mainnet upgrade requires CONFIRM_MAINNET=yes");
  }

  const file = path.join(__dirname, `../deployments/griddy-${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const proxy = dep.griddy;
  const [signer] = await ethers.getSigners();

  const before = await ethers.getContractAt("GriddyV8", proxy);
  const state = {
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
  console.log(`proxy ${proxy}`);
  console.log(`  before: round=${state.roundId} fees=${ethers.formatEther(state.fees)} unresolved=${ethers.formatEther(state.unresolved)} owner=${state.owner}`);
  console.log(`          minStakeWei=${state.minStake} roundDuration=${state.duration}s beaconGap=${state.gap}s balance=${ethers.formatEther(state.balance)}`);
  console.log(`          roundEpoch=${state.epoch} (${new Date(Number(state.epoch) * 1000).toISOString()})`);
  console.log(`          currentWindow: [${wBefore.windowStart}, ${wBefore.windowEnd}) drand=${wBefore.drandRound} secondsLeft=${wBefore.secondsLeft}`);
  console.log(`  signer: ${signer.address}`);

  const V9 = await ethers.getContractFactory("GriddyV9");
  // No call: V9 appends no storage, so re-running an initializer would only
  // risk re-phasing a grid that is already anchored.
  const v9 = await upgrades.upgradeProxy(proxy, V9);
  await v9.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`  upgraded. new impl: ${impl}`);

  const after = {
    roundId: await v9.currentRoundId(),
    fees: await v9.accumulatedFees(),
    unresolved: await v9.totalUnresolvedStakes(),
    owner: await v9.owner(),
    minStake: await v9.minStakeWei(),
    duration: await v9.roundDuration(),
    gap: await v9.beaconGap(),
    feeBps: await v9.protocolFeeBps(),
    tip: await v9.resolverTipWei(),
    epoch: await v9.roundEpoch(),
    balance: await ethers.provider.getBalance(proxy),
  };
  const w = await v9.currentWindow();
  console.log(`  after:  round=${after.roundId} fees=${ethers.formatEther(after.fees)} unresolved=${ethers.formatEther(after.unresolved)} owner=${after.owner}`);
  console.log(`          minStakeWei=${after.minStake} roundDuration=${after.duration}s beaconGap=${after.gap}s balance=${ethers.formatEther(after.balance)}`);
  console.log(`          roundEpoch=${after.epoch} (${new Date(Number(after.epoch) * 1000).toISOString()})`);
  console.log(`          currentWindow: [${w.windowStart}, ${w.windowEnd}) drand=${w.drandRound} secondsLeft=${w.secondsLeft}`);

  // Solvency, not raw equality, is the invariant that must hold: a player can
  // legitimately stake or resolve in the blocks the upgrade straddles, which
  // moves roundId / fees / unresolved / balance without anything being lost.
  const reserved = after.unresolved
    + (await v9.pendingRefunds())
    + (await v9.pendingWithdrawals())
    + after.fees;
  if (after.unresolved !== state.unresolved || after.balance !== state.balance) {
    console.log(`  note: live play moved unresolved ${state.unresolved} -> ${after.unresolved}, balance ${state.balance} -> ${after.balance}`);
  }
  const ok = [
    ["round preserved", after.roundId >= state.roundId],
    ["owner preserved", after.owner === state.owner],
    ["fees preserved", after.fees >= state.fees],
    ["solvent: balance covers every claim", after.balance >= reserved],
    ["minStakeWei untouched", after.minStake === state.minStake],
    ["roundDuration untouched", after.duration === state.duration],
    ["beaconGap untouched", after.gap === state.gap],
    ["protocolFeeBps untouched", after.feeBps === state.feeBps],
    ["resolverTipWei untouched", after.tip === state.tip],
    ["roundEpoch untouched (no initializer ran)", after.epoch === state.epoch],
    ["grid still anchored (roundEpoch != 0)", after.epoch !== 0n],
    ["lobby clock still live (secondsLeft > 0)", w.secondsLeft > 0n],
  ] as [string, boolean][];
  let allOk = true;
  for (const [n, o] of ok) { console.log(`  ${o ? "✓" : "✗"} ${n}`); if (!o) allOk = false; }
  if (!allOk) throw new Error("post-upgrade checks FAILED");

  dep.griddyImpl = impl;
  dep.version = "V9";
  dep.upgradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`\nWrote ${file}`);
  const onGrid = (Number(w.windowEnd) - Number(after.epoch)) % Number(after.duration) === 0;
  console.log(`  ${onGrid ? "✓" : "✗"} advertised window ends on a grid boundary`);
  if (!onGrid) throw new Error("window is off-grid after upgrade");
  console.log(`\nRounds now tick on the ${after.duration}s grid anchored at roundEpoch — no player can start, reset or extend the clock.`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
