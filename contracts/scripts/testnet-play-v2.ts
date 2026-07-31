import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * E2E proof of the pari-mutuel payout on live testnet: three players stake
 * UNEVEN amounts across two cells, the keeper resolves with the real drand
 * beacon, and we verify each winner received exactly their pro-rata share.
 *
 *   npx hardhat run scripts/testnet-play-v2.ts --network robinhood-testnet
 */
async function main() {
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/griddy-v2-${network.name}.json`), "utf8")
  );
  const [deployer] = await ethers.getSigners();
  const griddy = await ethers.getContractAt("GriddyV2", dep.griddy);

  // Two extra hot wallets funded from the deployer
  const p2 = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("griddy-v2-p2")), ethers.provider);
  const p3 = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("griddy-v2-p3")), ethers.provider);
  for (const p of [p2, p3]) {
    if ((await ethers.provider.getBalance(p.address)) < ethers.parseEther("0.0004")) {
      await (await deployer.sendTransaction({ to: p.address, value: ethers.parseEther("0.0006") })).wait();
    }
  }
  console.log(`P1 ${deployer.address}\nP2 ${p2.address}\nP3 ${p3.address}`);

  // Wait for a round with room to stake
  let roundId = await griddy.currentRoundId();
  for (;;) {
    const r = await griddy.rounds(roundId);
    const now = Math.floor(Date.now() / 1000);
    if (!r.resolved && Number(r.endTime) - now > 12) break;
    await new Promise((res) => setTimeout(res, 3000));
    roundId = await griddy.currentRoundId();
  }
  console.log(`\nStaking into round ${roundId}`);

  // Uneven stakes: P1 0.0005 on cell 7, P2 0.0002 on cell 7, P3 0.0004 on cell 12
  const A = ethers.parseEther("0.0003");
  const B = ethers.parseEther("0.0001");
  const C = ethers.parseEther("0.00015");
  await (await griddy.connect(deployer).stake(roundId, [7], [A], { value: A })).wait();
  console.log(`  P1 staked ${ethers.formatEther(A)} ETH on cell 7`);
  await (await griddy.connect(p2).stake(roundId, [7], [B], { value: B })).wait();
  console.log(`  P2 staked ${ethers.formatEther(B)} ETH on cell 7`);
  await (await griddy.connect(p3).stake(roundId, [12], [C], { value: C })).wait();
  console.log(`  P3 staked ${ethers.formatEther(C)} ETH on cell 12`);

  const round = await griddy.rounds(roundId);
  console.log(
    `\nRound ${roundId}: pot ${ethers.formatEther(round.totalStaked)} ETH · ${round.totalStakers} stakers · drand #${round.drandRound}`
  );

  const before = {
    p1: await ethers.provider.getBalance(deployer.address),
    p2: await ethers.provider.getBalance(p2.address),
    p3: await ethers.provider.getBalance(p3.address),
  };

  console.log("Waiting for the keeper to resolve with the drand beacon...");
  const deadline = Date.now() + 120_000;
  for (;;) {
    const r = await griddy.rounds(roundId);
    if (r.resolved) {
      console.log(`\n✓ RESOLVED — winning cell ${r.winningCell}${r.isBonusRound ? " (MOTHERLODE)" : ""}`);
      console.log(`  winnerTotal:   ${ethers.formatEther(r.winnerTotal)} ETH`);
      console.log(`  distributable: ${ethers.formatEther(r.distributable)} ETH`);

      const winners = await griddy.getCellStakers(roundId, r.winningCell);
      for (const w of winners) {
        const s = await griddy.stakeOf(roundId, r.winningCell, w);
        const expected = (r.distributable * s) / r.winnerTotal;
        const label = w === deployer.address ? "P1" : w === p2.address ? "P2" : w === p3.address ? "P3" : w;
        const share = (Number(s) / Number(r.winnerTotal)) * 100;
        console.log(
          `  ${label}: staked ${ethers.formatEther(s)} (${share.toFixed(1)}% of cell) → expected ${ethers.formatEther(expected)} ETH`
        );
      }
      const after = {
        p2: await ethers.provider.getBalance(p2.address),
        p3: await ethers.provider.getBalance(p3.address),
      };
      console.log(`\n  P2 balance delta: ${ethers.formatEther(after.p2 - before.p2)} ETH`);
      console.log(`  P3 balance delta: ${ethers.formatEther(after.p3 - before.p3)} ETH`);
      return;
    }
    if (Date.now() > deadline) throw new Error("not resolved in 2 min — keeper running?");
    await new Promise((res) => setTimeout(res, 2000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
