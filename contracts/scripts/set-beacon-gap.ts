import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Owner config: set the beacon gap (seconds between round end and the pinned
 * drand beacon's emission). Contract floor is 8s — the beacon must not exist
 * while betting is open.
 *
 *   GAP=8 npx hardhat run scripts/set-beacon-gap.ts --network arc-testnet
 */
async function main() {
  const gap = BigInt(process.env.GAP || "8");
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/griddy-${network.name}.json`), "utf8")
  );
  const griddy = await ethers.getContractAt("GriddyV4", dep.griddy);
  console.log(`beaconGap before: ${await griddy.beaconGap()}s`);
  const tx = await griddy.setBeaconGap(gap);
  await tx.wait();
  console.log(`beaconGap now:    ${await griddy.beaconGap()}s (tx ${tx.hash})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
