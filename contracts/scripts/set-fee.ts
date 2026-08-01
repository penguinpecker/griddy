import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Owner config: set the protocol fee in basis points (contract cap 2000 = 20%).
 * The resolver tip is paid OUT OF this fee, never on top, so players always
 * receive exactly (100% − fee) of the pot.
 *
 *   BPS=1000 npx hardhat run scripts/set-fee.ts --network arc-mainnet
 */
async function main() {
  const bps = BigInt(process.env.BPS || "1000");
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/griddy-${network.name}.json`), "utf8")
  );
  const griddy = await ethers.getContractAt("GriddyV5", dep.griddy);
  const before = await griddy.protocolFeeBps();
  console.log(`protocolFeeBps before: ${before} (${Number(before) / 100}% fee, players get ${100 - Number(before) / 100}%)`);
  const tx = await griddy.setProtocolFeeBps(bps);
  await tx.wait();
  const after = await griddy.protocolFeeBps();
  console.log(`protocolFeeBps now:    ${after} (${Number(after) / 100}% fee, players get ${100 - Number(after) / 100}%)`);
  console.log(`tx ${tx.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
