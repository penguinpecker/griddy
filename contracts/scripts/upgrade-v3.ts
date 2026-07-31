import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Upgrades the live Griddy proxy to V3 (no Motherlode, no reward token). */
async function main() {
  const file = path.join(__dirname, `../deployments/griddy-v2-${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const proxy = dep.griddy;
  const [signer] = await ethers.getSigners();

  if (network.config.chainId === 4663 && process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error("Mainnet upgrade requires CONFIRM_MAINNET=yes");
  }

  const before = await ethers.getContractAt("GriddyV2", proxy);
  const state = {
    roundId: await before.currentRoundId(),
    fees: await before.accumulatedFees(),
    reserve: await before.bonusReserve(),
    owner: await before.owner(),
  };
  console.log(`proxy ${proxy}`);
  console.log(`  before: round=${state.roundId} fees=${ethers.formatEther(state.fees)} reserve=${ethers.formatEther(state.reserve)} owner=${state.owner}`);
  console.log(`  signer: ${signer.address}`);

  const V3 = await ethers.getContractFactory("GriddyV4");
  const v3 = await upgrades.upgradeProxy(proxy, V3, { call: { fn: "initializeV3", args: [] } });
  await v3.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`  upgraded. new impl: ${impl}`);

  const after = {
    roundId: await v3.currentRoundId(),
    fees: await v3.accumulatedFees(),
    reserve: await v3.bonusReserve_retired(),
    owner: await v3.owner(),
  };
  console.log(`  after:  round=${after.roundId} fees=${ethers.formatEther(after.fees)} reserve=${ethers.formatEther(after.reserve)} owner=${after.owner}`);

  const ok = [
    ["round preserved", after.roundId >= state.roundId],
    ["owner preserved", after.owner === state.owner],
    ["reserve folded into fees", after.reserve === 0n && after.fees === state.fees + state.reserve],
    ["no bonus surface", v3.interface.getFunction("depositBonusReserve" as any) === null],
  ] as [string, boolean][];
  let allOk = true;
  for (const [n, o] of ok) { console.log(`  ${o ? "✓" : "✗"} ${n}`); if (!o) allOk = false; }
  if (!allOk) throw new Error("post-upgrade checks FAILED");

  dep.griddyImpl = impl;
  dep.version = "V3";
  dep.upgradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`\nWrote ${file}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
