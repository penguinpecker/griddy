import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Upgrades the live Griddy proxy to V5 (continuous rounds: betting rolls
 *  lazily on stake, resolution is independent, empty rounds cost no gas). */
async function main() {
  const file = path.join(__dirname, `../deployments/griddy-${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const proxy = dep.griddy;
  const [signer] = await ethers.getSigners();

  if (network.config.chainId === 4663 && process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error("Mainnet upgrade requires CONFIRM_MAINNET=yes");
  }

  const before = await ethers.getContractAt("GriddyV4", proxy);
  const state = {
    roundId: await before.currentRoundId(),
    fees: await before.accumulatedFees(),
    owner: await before.owner(),
  };
  console.log(`proxy ${proxy}`);
  console.log(`  before: round=${state.roundId} fees=${ethers.formatEther(state.fees)} owner=${state.owner}`);
  console.log(`  signer: ${signer.address}`);

  const V5 = await ethers.getContractFactory("GriddyV5");
  const v5 = await upgrades.upgradeProxy(proxy, V5, { call: { fn: "initializeV5", args: [] } });
  await v5.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`  upgraded. new impl: ${impl}`);

  const after = {
    roundId: await v5.currentRoundId(),
    fees: await v5.accumulatedFees(),
    unresolved: await v5.totalUnresolvedStakes(),
    owner: await v5.owner(),
  };
  console.log(`  after:  round=${after.roundId} fees=${ethers.formatEther(after.fees)} unresolved=${ethers.formatEther(after.unresolved)} owner=${after.owner}`);

  const ok = [
    ["round preserved", after.roundId >= state.roundId],
    ["owner preserved", after.owner === state.owner],
    ["fees preserved", after.fees >= state.fees],
  ] as [string, boolean][];
  let allOk = true;
  for (const [n, o] of ok) { console.log(`  ${o ? "✓" : "✗"} ${n}`); if (!o) allOk = false; }
  if (!allOk) throw new Error("post-upgrade checks FAILED");

  dep.griddyImpl = impl;
  dep.version = "V5";
  dep.upgradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`\nWrote ${file}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
