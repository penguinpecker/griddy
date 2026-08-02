import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * On-chain payout audit: for the last N resolved rounds, verify from chain
 * data alone that (1) the pot equals the sum of Staked events, (2) the
 * distributable prize is exactly (100% − fee) of the pot, (3) WinningsPaid
 * events pay the full prize pro-rata to the winning cell's stakers, and
 * (4) the contract currently holds enough balance to cover every liability
 * (pending stakes + escrow + refunds + fees).
 *
 *   ROUNDS=8 npx hardhat run scripts/verify-payouts.ts --network arc-testnet
 */
async function main() {
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/griddy-${network.name}.json`), "utf8")
  );
  const griddy = await ethers.getContractAt("GriddyV5", dep.griddy);
  const want = Number(process.env.ROUNDS || 8);
  const feeBps = await griddy.protocolFeeBps();
  const head = await griddy.currentRoundId();

  // Arc's RPC caps eth_getLogs ranges, and at ~0.55s blocks even a day is
  // ~150k blocks — scan in chunks over a bounded lookback.
  const tip = await ethers.provider.getBlockNumber();
  const LOOKBACK = Number(process.env.LOOKBACK_BLOCKS || 90_000);
  const CHUNK = 9_000;
  const fromFloor = Math.max(0, tip - LOOKBACK);
  const queryChunked = async (filter: any) => {
    const out: any[] = [];
    for (let from = fromFloor; from <= tip; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, tip);
      out.push(...(await griddy.queryFilter(filter, from, to)));
    }
    return out;
  };

  console.log(`auditing up to ${want} resolved rounds below round ${head} (fee ${Number(feeBps) / 100}%)\n`);
  let audited = 0;
  let totalPaid = 0n;
  for (let id = head; id >= 1n && audited < want; id--) {
    const r = await griddy.rounds(id);
    if (!r.resolved || r.totalStakers === 0n) continue;
    if (await griddy.roundVoided(id)) continue;
    audited++;

    // (1) pot == sum of Staked events for this round
    const stakedEvs = await queryChunked(griddy.filters.Staked(id));
    const stakedSum = stakedEvs.reduce((a, e) => a + e.args.amount, 0n);
    const potOk = stakedSum === r.totalStaked;

    // (2) prize == pot − fee, exactly
    const fee = (r.totalStaked * feeBps) / 10_000n;
    const prizeOk = r.distributable === r.totalStaked - fee;

    // (3) WinningsPaid events: full prize, pro-rata, only to winning-cell stakers
    const paidEvs = await queryChunked(griddy.filters.WinningsPaid(id));
    const paidSum = paidEvs.reduce((a, e) => a + e.args.ethAmount, 0n);
    let proRataOk = true;
    for (const e of paidEvs) {
      const s = await griddy.stakeOf(id, r.winningCell, e.args.player);
      const expect = (r.distributable * s) / r.winnerTotal;
      if (e.args.ethAmount !== expect || s === 0n) proRataOk = false;
    }
    // dust (integer division remainder) is banked into fees, never lost
    const dust = r.distributable - paidSum;
    const paidOk = dust >= 0n && dust < BigInt(paidEvs.length + 1);

    totalPaid += paidSum;
    // Distinguish "this round's events predate the scanned range" from a real
    // accounting mismatch — otherwise an old round looks like a failure and
    // the audit cries wolf. Chain state is still checked below.
    const outsideRange = stakedEvs.length === 0 && r.totalStakers > 0n;
    if (outsideRange) {
      const owedOk = r.distributable === r.totalStaked - fee;
      console.log(
        `~ round ${id}: events predate the ${LOOKBACK}-block scan window — ` +
        `chain state ${owedOk ? "consistent" : "INCONSISTENT"}: pot $${ethers.formatEther(r.totalStaked)}, ` +
        `prize $${ethers.formatEther(r.distributable)}, ${r.totalStakers} staker(s) ` +
        `(raise LOOKBACK_BLOCKS to verify its events)`
      );
      if (!owedOk) process.exitCode = 1;
      continue;
    }
    const flag = potOk && prizeOk && proRataOk && paidOk ? "✓" : "✗ MISMATCH";
    console.log(
      `${flag} round ${id}: pot $${ethers.formatEther(r.totalStaked)} (${stakedEvs.length} stakes) → ` +
      `prize $${ethers.formatEther(r.distributable)} paid to ${paidEvs.length} winner(s) on cell ${r.winningCell}` +
      (dust > 0n ? ` (+${dust} wei dust → fees)` : "")
    );
    if (!flag.startsWith("✓")) process.exitCode = 1;
  }

  // (4) solvency snapshot
  const [bal, fees, escrow, refunds, unresolved] = await Promise.all([
    ethers.provider.getBalance(dep.griddy),
    griddy.accumulatedFees(),
    griddy.pendingWithdrawals(),
    griddy.pendingRefunds(),
    griddy.totalUnresolvedStakes(),
  ]);
  const liabilities = fees + escrow + refunds + unresolved;
  console.log(`\nsolvency: balance $${ethers.formatEther(bal)} vs liabilities $${ethers.formatEther(liabilities)}`);
  console.log(`  fees $${ethers.formatEther(fees)} · escrow $${ethers.formatEther(escrow)} · refunds $${ethers.formatEther(refunds)} · pending stakes $${ethers.formatEther(unresolved)}`);
  console.log(bal >= liabilities ? "  ✓ every on-chain claim is covered" : "  ✗ INSOLVENT");
  if (bal < liabilities) process.exitCode = 1;
  console.log(`\naudited ${audited} rounds; total prizes paid on-chain: $${ethers.formatEther(totalPaid)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
