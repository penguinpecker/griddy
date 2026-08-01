import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Upgrades the live Griddy proxy to V6 (raises MIN_STAKE_HI, the ceiling
 *  setMinStake may set, from 1e16 to 1e18). Pure logic upgrade: no new
 *  storage, so NO initializer call — the proxy keeps every value it holds. */
async function main() {
  const file = path.join(__dirname, `../deployments/griddy-${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const proxy = dep.griddy;
  const [signer] = await ethers.getSigners();

  const chainId = network.config.chainId;
  if ((chainId === 4663 || chainId === 5042) && process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error("Mainnet upgrade requires CONFIRM_MAINNET=yes");
  }

  const before = await ethers.getContractAt("GriddyV5", proxy);
  const state = {
    roundId: await before.currentRoundId(),
    fees: await before.accumulatedFees(),
    unresolved: await before.totalUnresolvedStakes(),
    owner: await before.owner(),
    minStake: await before.minStakeWei(),
    minStakeHi: await before.MIN_STAKE_HI(),
  };
  console.log(`proxy ${proxy}`);
  console.log(`  before: round=${state.roundId} fees=${ethers.formatEther(state.fees)} unresolved=${ethers.formatEther(state.unresolved)} owner=${state.owner}`);
  console.log(`          minStakeWei=${state.minStake} (${ethers.formatEther(state.minStake)}) MIN_STAKE_HI=${state.minStakeHi} (${ethers.formatEther(state.minStakeHi)})`);
  console.log(`  signer: ${signer.address}`);

  const V6 = await ethers.getContractFactory("GriddyV6");
  const v6 = await upgrades.upgradeProxy(proxy, V6);   // no initializer: nothing to migrate
  await v6.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`  upgraded. new impl: ${impl}`);

  const after = {
    roundId: await v6.currentRoundId(),
    fees: await v6.accumulatedFees(),
    unresolved: await v6.totalUnresolvedStakes(),
    owner: await v6.owner(),
    minStake: await v6.minStakeWei(),
    minStakeHi: await v6.MIN_STAKE_HI(),
  };
  console.log(`  after:  round=${after.roundId} fees=${ethers.formatEther(after.fees)} unresolved=${ethers.formatEther(after.unresolved)} owner=${after.owner}`);
  console.log(`          minStakeWei=${after.minStake} (${ethers.formatEther(after.minStake)}) MIN_STAKE_HI=${after.minStakeHi} (${ethers.formatEther(after.minStakeHi)})`);

  const ok = [
    ["round preserved", after.roundId >= state.roundId],
    ["owner preserved", after.owner === state.owner],
    ["fees preserved", after.fees >= state.fees],
    ["unresolved stakes preserved", after.unresolved === state.unresolved],
    ["minStakeWei untouched", after.minStake === state.minStake],
    ["ceiling raised to 1e18", after.minStakeHi === 10n ** 18n],
  ] as [string, boolean][];
  let allOk = true;
  for (const [n, o] of ok) { console.log(`  ${o ? "✓" : "✗"} ${n}`); if (!o) allOk = false; }
  if (!allOk) throw new Error("post-upgrade checks FAILED");

  dep.griddyImpl = impl;
  dep.version = "V6";
  dep.upgradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`\nWrote ${file}`);
  console.log(`Next: USDC=0.1 npx hardhat run scripts/set-min-stake.ts --network ${network.name}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
