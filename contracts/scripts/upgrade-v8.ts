import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Upgrades the live Griddy proxy to V8 (full-length rounds: a round opened
 *  mid-window no longer inherits only that window's remainder, it always runs
 *  the whole roundDuration). Pure logic change — no new storage, so there is
 *  NO initializer call: everything the proxy holds, roundEpoch included, is
 *  carried over untouched and the lobby clock keeps ticking on the same grid. */
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

  const before = await ethers.getContractAt("GriddyV7", proxy);
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

  const V8 = await ethers.getContractFactory("GriddyV8");
  // No call: V8 appends no storage, so re-running an initializer would only
  // risk re-phasing a grid that is already anchored.
  const v8 = await upgrades.upgradeProxy(proxy, V8);
  await v8.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`  upgraded. new impl: ${impl}`);

  const after = {
    roundId: await v8.currentRoundId(),
    fees: await v8.accumulatedFees(),
    unresolved: await v8.totalUnresolvedStakes(),
    owner: await v8.owner(),
    minStake: await v8.minStakeWei(),
    duration: await v8.roundDuration(),
    gap: await v8.beaconGap(),
    feeBps: await v8.protocolFeeBps(),
    tip: await v8.resolverTipWei(),
    epoch: await v8.roundEpoch(),
    balance: await ethers.provider.getBalance(proxy),
  };
  const w = await v8.currentWindow();
  console.log(`  after:  round=${after.roundId} fees=${ethers.formatEther(after.fees)} unresolved=${ethers.formatEther(after.unresolved)} owner=${after.owner}`);
  console.log(`          minStakeWei=${after.minStake} roundDuration=${after.duration}s beaconGap=${after.gap}s balance=${ethers.formatEther(after.balance)}`);
  console.log(`          roundEpoch=${after.epoch} (${new Date(Number(after.epoch) * 1000).toISOString()})`);
  console.log(`          currentWindow: [${w.windowStart}, ${w.windowEnd}) drand=${w.drandRound} secondsLeft=${w.secondsLeft}`);

  // Solvency, not raw equality, is the invariant that must hold: a player can
  // legitimately stake or resolve in the blocks the upgrade straddles, which
  // moves roundId / fees / unresolved / balance without anything being lost.
  const reserved = after.unresolved
    + (await v8.pendingRefunds())
    + (await v8.pendingWithdrawals())
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
  dep.version = "V8";
  dep.upgradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`\nWrote ${file}`);
  console.log(`Every round now runs the full ${after.duration}s from the stake that opens it.`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
