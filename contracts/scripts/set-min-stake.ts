import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Owner config: set the minimum stake for a NEW position, in whole USDC
 * (Arc's native gas token, 18-dec native representation). Top-ups on an
 * existing position stay any-amount. Contract bounds: MIN_STAKE_LO 1e13
 * .. MIN_STAKE_HI 1e18 ($1) on V6 — on V5 the ceiling was 1e16 ($0.01).
 *
 *   USDC=0.1 npx hardhat run scripts/set-min-stake.ts --network arc-mainnet
 */
async function main() {
  const wei = ethers.parseEther(process.env.USDC || "0.1");
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/griddy-${network.name}.json`), "utf8")
  );
  const griddy = await ethers.getContractAt("GriddyV6", dep.griddy);
  const hi = await griddy.MIN_STAKE_HI();
  const before = await griddy.minStakeWei();
  console.log(`minStakeWei before: ${before} wei ($${ethers.formatEther(before)})`);
  console.log(`ceiling MIN_STAKE_HI: ${hi} wei ($${ethers.formatEther(hi)})`);
  console.log(`setting to:         ${wei} wei ($${ethers.formatEther(wei)})`);
  const tx = await griddy.setMinStake(wei);
  await tx.wait();
  const after = await griddy.minStakeWei();
  console.log(`minStakeWei now:    ${after} wei ($${ethers.formatEther(after)})`);
  console.log(`tx ${tx.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
