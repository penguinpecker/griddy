import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Upgrades the live Griddy proxy to V7 (grid-aligned betting windows, so the
 *  round clock keeps running with zero players). Appends ONE slot, roundEpoch,
 *  which initializeV7 anchors at the upgrade block — hence the initializer
 *  call. Everything else the proxy holds is carried over untouched. */
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

  const before = await ethers.getContractAt("GriddyV6", proxy);
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
    balance: await ethers.provider.getBalance(proxy),
  };
  console.log(`proxy ${proxy}`);
  console.log(`  before: round=${state.roundId} fees=${ethers.formatEther(state.fees)} unresolved=${ethers.formatEther(state.unresolved)} owner=${state.owner}`);
  console.log(`          minStakeWei=${state.minStake} roundDuration=${state.duration}s beaconGap=${state.gap}s balance=${ethers.formatEther(state.balance)}`);
  console.log(`          roundEpoch=<absent on V6>  currentWindow=<absent on V6: the lobby has no clock without players>`);
  console.log(`  signer: ${signer.address}`);

  const V7 = await ethers.getContractFactory("GriddyV7");
  const v7 = await upgrades.upgradeProxy(proxy, V7, { call: { fn: "initializeV7", args: [] } });
  await v7.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`  upgraded. new impl: ${impl}`);

  const after = {
    roundId: await v7.currentRoundId(),
    fees: await v7.accumulatedFees(),
    unresolved: await v7.totalUnresolvedStakes(),
    owner: await v7.owner(),
    minStake: await v7.minStakeWei(),
    duration: await v7.roundDuration(),
    gap: await v7.beaconGap(),
    feeBps: await v7.protocolFeeBps(),
    tip: await v7.resolverTipWei(),
    balance: await ethers.provider.getBalance(proxy),
    epoch: await v7.roundEpoch(),
  };
  const w = await v7.currentWindow();
  console.log(`  after:  round=${after.roundId} fees=${ethers.formatEther(after.fees)} unresolved=${ethers.formatEther(after.unresolved)} owner=${after.owner}`);
  console.log(`          minStakeWei=${after.minStake} roundDuration=${after.duration}s beaconGap=${after.gap}s balance=${ethers.formatEther(after.balance)}`);
  console.log(`          roundEpoch=${after.epoch} (${new Date(Number(after.epoch) * 1000).toISOString()})`);
  console.log(`          currentWindow: [${w.windowStart}, ${w.windowEnd}) drand=${w.drandRound} secondsLeft=${w.secondsLeft}`);

  // Solvency, not raw equality, is the invariant that must hold: a player can
  // legitimately stake or resolve in the blocks the upgrade straddles, which
  // moves roundId / fees / unresolved / balance without anything being lost.
  const reserved = after.unresolved
    + (await v7.pendingRefunds())
    + (await v7.pendingWithdrawals())
    + after.fees;
  if (after.unresolved !== state.unresolved || after.balance !== state.balance) {
    console.log(`  note: live play moved unresolved ${state.unresolved} -> ${after.unresolved}, balance ${state.balance} -> ${after.balance}`);
  }
  const gridAligned =
    (BigInt(w.windowEnd) - BigInt(after.epoch)) % BigInt(after.duration) === 0n;
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
    ["grid anchored (roundEpoch != 0)", after.epoch !== 0n],
    ["window sits on the grid", gridAligned],
    ["clock is live (secondsLeft > 0)", w.secondsLeft > 0n],
  ] as [string, boolean][];
  let allOk = true;
  for (const [n, o] of ok) { console.log(`  ${o ? "✓" : "✗"} ${n}`); if (!o) allOk = false; }
  if (!allOk) throw new Error("post-upgrade checks FAILED");

  dep.griddyImpl = impl;
  dep.version = "V7";
  dep.roundEpoch = after.epoch.toString();
  dep.upgradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`\nWrote ${file}`);
  console.log(`The lobby now counts down with zero players: read currentWindow() from the client.`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
