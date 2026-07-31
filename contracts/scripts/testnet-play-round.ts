import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * E2E dry run against the deployed testnet stack: two players enter the
 * current round, then we wait for the (separately running) keeper to resolve
 * it with the real drand beacon and print the outcome.
 *
 *   npx hardhat run scripts/testnet-play-round.ts --network robinhood-testnet
 */
async function main() {
  const file = path.join(__dirname, `../deployments/griddy-${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();
  const griddy = await ethers.getContractAt("Griddy", dep.griddy);
  const usdg = await ethers.getContractAt("MockUSDG", dep.usdg);

  // Two players: the deployer and a derived hot wallet we fund on the fly
  const p2 = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("griddy-testnet-player2")), ethers.provider);
  console.log(`Player 1 (deployer): ${deployer.address}`);
  console.log(`Player 2:            ${p2.address}`);

  if ((await ethers.provider.getBalance(p2.address)) < ethers.parseEther("0.0005")) {
    await (await deployer.sendTransaction({ to: p2.address, value: ethers.parseEther("0.002") })).wait();
    console.log("Funded player 2 with gas");
  }
  if ((await usdg.balanceOf(p2.address)) < 10_000_000n) {
    await (await usdg.mint(p2.address, 100_000_000n)).wait(); // 100 USDG
    console.log("Minted 100 USDG to player 2");
  }

  for (const [who, signer] of [["p1", deployer], ["p2", p2]] as const) {
    const allowance = await usdg.allowance(signer.address, dep.griddy);
    if (allowance < 100_000_000n) {
      await (await usdg.connect(signer).approve(dep.griddy, ethers.MaxUint256)).wait();
      console.log(`${who} approved USDG`);
    }
  }

  // Wait for a round with enough time left to get both entries in
  let roundId = await griddy.currentRoundId();
  for (;;) {
    const r = await griddy.rounds(roundId);
    const now = Math.floor(Date.now() / 1000);
    if (!r.resolved && Number(r.endTime) - now > 15) break;
    console.log(`Round ${roundId} has ${Number(r.endTime) - now}s left (resolved=${r.resolved}) — waiting for a fresh round...`);
    await new Promise((res) => setTimeout(res, 5000));
    roundId = await griddy.currentRoundId();
  }
  console.log(`Entering round ${roundId}`);

  const t1 = await griddy.connect(deployer).pickCell(7);
  await t1.wait();
  console.log(`p1 picked cell 7: ${t1.hash}`);
  const t2 = await griddy.connect(p2).pickCell(12);
  await t2.wait();
  console.log(`p2 picked cell 12: ${t2.hash}`);

  const round = await griddy.rounds(roundId);
  console.log(`Round ${roundId}: players=${round.totalPlayers} pot=${round.totalDeposits} drandRound=${round.drandRound} endTime=${round.endTime}`);

  // Now the keeper (running separately) should resolve once the beacon lands
  console.log("Waiting for the keeper to resolve with the drand beacon...");
  const deadline = Date.now() + 180_000;
  for (;;) {
    const r = await griddy.rounds(roundId);
    if (r.resolved) {
      console.log(`\n✓ RESOLVED — winning cell ${r.winningCell}${r.isBonusRound ? " (MOTHERLODE!)" : ""}`);
      console.log(`  drand round used: ${r.drandRound}`);
      console.log(`  payout per winner: ${await griddy.roundUsdcPerWinner(roundId)} (USDG base units)`);
      const winners = await griddy.getCellPlayers(roundId, r.winningCell);
      console.log(`  winners: ${winners.join(", ")}`);
      const b1 = await usdg.balanceOf(deployer.address);
      const b2 = await usdg.balanceOf(p2.address);
      console.log(`  p1 USDG: ${b1}  p2 USDG: ${b2}`);
      return;
    }
    if (Date.now() > deadline) throw new Error("Round not resolved within 3 minutes — is the keeper running?");
    await new Promise((res) => setTimeout(res, 3000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
