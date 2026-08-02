import { ethers, network } from "hardhat";
import * as fs from "fs"; import * as path from "path";

/**
 * Owner config: set the round length in seconds (contract bounds 10s–1h).
 * On V7 this also re-phases the window grid, which is safe: live rounds keep
 * the endTime and beacon they were opened with.
 *
 *   SECS=60 npx hardhat run scripts/set-round-duration.ts --network arc-mainnet
 */
async function main() {
  const secs = BigInt(process.env.SECS || "60");
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/griddy-${network.name}.json`), "utf8")
  );
  const g = await ethers.getContractAt("GriddyV7", dep.griddy);
  console.log(`roundDuration before: ${await g.roundDuration()}s`);
  const tx = await g.setRoundDuration(secs);
  await tx.wait();
  console.log(`roundDuration now:    ${await g.roundDuration()}s  (tx ${tx.hash})`);
  const w = await g.currentWindow();
  console.log(`currentWindow: [${w[0]}, ${w[1]}) span ${w[1] - w[0]}s, secondsLeft ${w[3]}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
