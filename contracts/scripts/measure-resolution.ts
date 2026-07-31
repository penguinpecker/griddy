import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Measures live keeper resolution latency: stakes a dust amount into a fresh
 * round, then waits for the KEEPER (not this script) to resolve it and
 * reports round-end → resolution latency from block timestamps.
 *
 *   npx hardhat run scripts/measure-resolution.ts --network arc-testnet
 */
async function main() {
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/griddy-${network.name}.json`), "utf8")
  );
  const [p1] = await ethers.getSigners();
  const griddy = await ethers.getContractAt("GriddyV4", dep.griddy);

  // V5 continuous rounds: an expired betting round never rolls by itself —
  // the first stake with the PREDICTED id (current+1) opens a fresh window.
  let roundId = await griddy.currentRoundId();
  for (;;) {
    const r = await griddy.rounds(roundId);
    const now = Math.floor(Date.now() / 1000);
    if (now >= Number(r.endTime) || r.resolved) { roundId = roundId + 1n; break; }
    if (Number(r.endTime) - now > 12) break;
    await new Promise((res) => setTimeout(res, 2000));
    roundId = await griddy.currentRoundId();
  }

  const stake = ethers.parseEther("0.01");
  await (await griddy.stake(roundId, [4], [stake], { value: stake })).wait();
  const r = await griddy.rounds(roundId);
  console.log(`staked $0.01 into round ${roundId}; endTime ${r.endTime}, drand #${r.drandRound}`);
  console.log(`waiting for the KEEPER to resolve...`);

  const deadline = Date.now() + 120_000;
  for (;;) {
    const cur = await griddy.rounds(roundId);
    if (cur.resolved) {
      // Find the resolution block via the RoundResolved event
      const evs = await griddy.queryFilter(griddy.filters.RoundResolved(roundId), -5000);
      const ev = evs[evs.length - 1];
      const blk = await ev.getBlock();
      const latency = blk.timestamp - Number(cur.endTime);
      console.log(`✓ resolved in tx ${ev.transactionHash}`);
      console.log(`  round endTime:     ${cur.endTime}`);
      console.log(`  resolution block:  ${blk.timestamp}`);
      console.log(`  END → RESOLVED:    ${latency}s (floor = beaconGap ${await griddy.beaconGap()}s)`);
      return;
    }
    if (Date.now() > deadline) throw new Error("keeper did not resolve within 2 min — check railway logs");
    await new Promise((res) => setTimeout(res, 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
