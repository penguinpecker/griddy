import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, `../deployments/griddy-v2-${network.name}.json`), "utf8"));
  const [me] = await ethers.getSigners();
  const g = await ethers.getContractAt("GriddyV3", dep.griddy);

  console.log(`chain ${network.config.chainId} · game ${dep.griddy}`);
  console.log(`deployer ${me.address} · balance ${ethers.formatEther(await ethers.provider.getBalance(me.address))} ETH\n`);

  // Config sanity — these are the audit-hardened values
  console.log(`config: minStake=${ethers.formatEther(await g.minStakeWei())} tip=${ethers.formatEther(await g.resolverTipWei())} fee=${await g.protocolFeeBps()}bps gap=${await g.beaconGap()}s dur=${await g.roundDuration()}s`);
  console.log(`repin timeout ${Number(await g.REPIN_TIMEOUT()) / 3600}h · max stakers/cell ${await g.MAX_STAKERS_PER_CELL()}`);

  // Find a round with room
  let rid = await g.currentRoundId();
  for (;;) {
    const r = await g.rounds(rid);
    const left = Number(r.endTime) - Math.floor(Date.now() / 1000);
    if (!r.resolved && left > 16) { console.log(`\nround ${rid} · ${left}s left · drand #${r.drandRound}`); break; }
    await new Promise((s) => setTimeout(s, 2500));
    rid = await g.currentRoundId();
  }

  // Uneven multi-cell stake in ONE tx: 0.0004 on cell 7, 0.0001 on cell 18
  const a = ethers.parseEther("0.0004");
  const b = ethers.parseEther("0.0001");
  const predicted = await g.getExpectedPayout.staticCall(7, a);
  const tx = await g.stake(rid, [7, 18], [a, b], { value: a + b });
  await tx.wait();
  console.log(`staked 0.0004 on cell 7 + 0.0001 on cell 18 (one tx): ${tx.hash}`);
  console.log(`getExpectedPayout(cell 7, 0.0004) said: ${ethers.formatEther(predicted)} ETH`);

  const before = await ethers.provider.getBalance(me.address);
  console.log(`\nwaiting for keeper resolution...`);
  const deadline = Date.now() + 150_000;
  for (;;) {
    const r = await g.rounds(rid);
    if (r.resolved) {
      const t1 = Number((await ethers.provider.getBlock("latest"))!.timestamp);
      console.log(`\n✓ RESOLVED round ${rid}`);
      console.log(`  winning cell   : ${r.winningCell}`);
      console.log(`  pot            : ${ethers.formatEther(r.totalStaked)} ETH`);
      console.log(`  winnerTotal    : ${ethers.formatEther(r.winnerTotal)} ETH`);
      console.log(`  distributable  : ${ethers.formatEther(r.distributable)} ETH`);
      const myStake = await g.stakeOf(rid, r.winningCell, me.address);
      const expected = r.winnerTotal > 0n ? (r.distributable * myStake) / r.winnerTotal : 0n;
      console.log(`  my stake on it : ${ethers.formatEther(myStake)} ETH -> owed ${ethers.formatEther(expected)} ETH`);
      console.log(`  accumulatedFees: ${ethers.formatEther(await g.accumulatedFees())} ETH`);
      console.log(`  next round     : ${await g.currentRoundId()}`);

      // solvency invariant on mainnet
      const bal = await ethers.provider.getBalance(dep.griddy);
      const cur = await g.rounds(await g.currentRoundId());
      const reserved = cur.totalStaked + (await g.pendingRefunds()) + (await g.pendingWithdrawals()) + (await g.accumulatedFees());
      console.log(`\n  SOLVENCY: contract holds ${ethers.formatEther(bal)} ETH, owes ${ethers.formatEther(reserved)} ETH -> ${bal >= reserved ? "OK ✓" : "UNDER-COLLATERALISED ✗"}`);
      return;
    }
    if (Date.now() > deadline) throw new Error("not resolved in 150s");
    await new Promise((s) => setTimeout(s, 2000));
  }
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
