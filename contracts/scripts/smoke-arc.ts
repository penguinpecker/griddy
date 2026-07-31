import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * E2E smoke of a full round on Arc testnet with NO keeper: three players
 * stake uneven native-USDC amounts across two cells, then this script
 * fetches the pinned drand evmnet beacon itself and calls resolveRound()
 * — the contract verifies the BLS signature on-chain and auto-pays.
 *
 *   npx hardhat run scripts/smoke-arc.ts --network arc-testnet
 */

const DRAND_CHAIN_HASH = "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";
const DRAND_API = [
  `https://api.drand.sh/${DRAND_CHAIN_HASH}`,
  `https://drand.cloudflare.com/${DRAND_CHAIN_HASH}`,
];

async function fetchBeacon(round: number, deadlineMs = 90_000): Promise<[bigint, bigint]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    for (const base of DRAND_API) {
      try {
        const res = await fetch(`${base}/public/${round}`);
        if (res.ok) {
          const body = (await res.json()) as { round: number; signature: string };
          if (body.round === round && /^[0-9a-f]{128}$/.test(body.signature)) {
            return [BigInt("0x" + body.signature.slice(0, 64)), BigInt("0x" + body.signature.slice(64))];
          }
        }
      } catch {}
    }
    if (Date.now() > deadline) throw new Error(`drand round ${round} not available in time`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/griddy-${network.name}.json`), "utf8")
  );
  const [deployer] = await ethers.getSigners();
  const griddy = await ethers.getContractAt("GriddyV4", dep.griddy);

  // Two extra hot wallets funded from the deployer (deterministic test keys)
  const p2 = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("griddy-arc-p2")), ethers.provider);
  const p3 = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("griddy-arc-p3")), ethers.provider);
  for (const p of [p2, p3]) {
    if ((await ethers.provider.getBalance(p.address)) < ethers.parseEther("0.04")) {
      await (await deployer.sendTransaction({ to: p.address, value: ethers.parseEther("0.06") })).wait();
    }
  }
  console.log(`P1 ${deployer.address}\nP2 ${p2.address}\nP3 ${p3.address}`);

  // Wait for a round with room to stake. Rounds only roll over on
  // resolution, so with no keeper running an expired round sits unresolved
  // forever — resolve it ourselves to open a fresh one.
  let roundId = await griddy.currentRoundId();
  for (;;) {
    const r = await griddy.rounds(roundId);
    const now = Math.floor(Date.now() / 1000);
    if (!r.resolved && Number(r.endTime) - now > 15) break;
    if (!r.resolved && now > Number(r.endTime) + Number(dep.params.beaconGap ?? 10)) {
      if (r.totalStakers === 0n) {
        console.log(`Round ${roundId} expired empty — skipEmptyRound() to open a fresh round...`);
        await (await griddy.skipEmptyRound(roundId)).wait();
      } else {
        console.log(`Round ${roundId} expired unresolved — resolving it to open a fresh round...`);
        const staleSig = await fetchBeacon(Number(r.drandRound));
        await (await griddy.resolveRound(roundId, staleSig)).wait();
      }
      console.log(`  done.`);
    }
    await new Promise((res) => setTimeout(res, 3000));
    roundId = await griddy.currentRoundId();
  }
  console.log(`\nStaking into round ${roundId}`);

  // Uneven stakes: P1 $0.03 on cell 7, P2 $0.01 on cell 7, P3 $0.015 on cell 12
  const A = ethers.parseEther("0.03");
  const B = ethers.parseEther("0.01");
  const C = ethers.parseEther("0.015");
  await (await griddy.connect(deployer).stake(roundId, [7], [A], { value: A })).wait();
  console.log(`  P1 staked $${ethers.formatEther(A)} on cell 7`);
  await (await griddy.connect(p2).stake(roundId, [7], [B], { value: B })).wait();
  console.log(`  P2 staked $${ethers.formatEther(B)} on cell 7`);
  await (await griddy.connect(p3).stake(roundId, [12], [C], { value: C })).wait();
  console.log(`  P3 staked $${ethers.formatEther(C)} on cell 12`);

  const round = await griddy.rounds(roundId);
  console.log(
    `\nRound ${roundId}: pot $${ethers.formatEther(round.totalStaked)} · ${round.totalStakers} stakers · drand #${round.drandRound}`
  );

  const before = {
    p2: await ethers.provider.getBalance(p2.address),
    p3: await ethers.provider.getBalance(p3.address),
  };

  // Wait for round end, fetch the pinned beacon, resolve ourselves
  const endTime = Number(round.endTime);
  const waitS = Math.max(0, endTime - Math.floor(Date.now() / 1000)) + Number(dep.params.beaconGap ?? 10) + 3;
  console.log(`Waiting ~${waitS}s for round end + beacon emission...`);
  await new Promise((r) => setTimeout(r, waitS * 1000));

  const sig = await fetchBeacon(Number(round.drandRound));
  console.log(`Fetched drand beacon #${round.drandRound}; submitting resolveRound...`);
  const tx = await griddy.resolveRound(roundId, sig);
  const rc = await tx.wait();
  console.log(`resolveRound tx: ${rc?.hash}`);

  const r = await griddy.rounds(roundId);
  if (!r.resolved) throw new Error("round not resolved after resolveRound tx");
  console.log(`\n✓ RESOLVED — winning cell ${r.winningCell}`);
  console.log(`  winnerTotal:   $${ethers.formatEther(r.winnerTotal)}`);
  console.log(`  distributable: $${ethers.formatEther(r.distributable)} (should be 95% of pot)`);

  const winners = await griddy.getCellStakers(roundId, r.winningCell);
  for (const w of winners) {
    const s = await griddy.stakeOf(roundId, r.winningCell, w);
    const expected = (r.distributable * s) / r.winnerTotal;
    const label = w === deployer.address ? "P1" : w === p2.address ? "P2" : w === p3.address ? "P3" : w;
    const share = (Number(s) / Number(r.winnerTotal)) * 100;
    console.log(`  ${label}: staked $${ethers.formatEther(s)} (${share.toFixed(1)}% of cell) → expected $${ethers.formatEther(expected)}`);
  }
  const after = {
    p2: await ethers.provider.getBalance(p2.address),
    p3: await ethers.provider.getBalance(p3.address),
  };
  console.log(`\n  P2 balance delta: $${ethers.formatEther(after.p2 - before.p2)}`);
  console.log(`  P3 balance delta: $${ethers.formatEther(after.p3 - before.p3)}`);
  console.log(`\nExplorer: https://explorer.testnet.arc.network/address/${dep.griddy}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
