import { ethers } from "hardhat";

const PROXY = "0xfa29a5a324149a60086B3aeD20cBF42Bd761d5A1";
const BEACON = "0xC5c53BB4A93bCe76b99c726FFA1173Be31f14d8d";

async function main() {
  const p = ethers.provider;
  const g = await ethers.getContractAt("GriddyV7", PROXY);
  const b = await ethers.getContractAt("DrandBeaconV2", BEACON);

  // ── live BLS verification against a real drand evmnet beacon (eth_call only) ──
  const r = await fetch("https://api.drand.sh/v2/chains/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/rounds/latest").then((x) => x.json() as any);
  const sig = r.signature as string;
  const s0 = BigInt("0x" + sig.slice(0, 64));
  const s1 = BigInt("0x" + sig.slice(64, 128));
  console.log("drand latest round", r.round, "sig", sig);
  try {
    await b.verifyBeaconRound(r.round, [s0, s1]);
    console.log("BLS verifyBeaconRound(", r.round, ") => OK (real drand evmnet beacon verifies on Arc mainnet)");
  } catch (e: any) {
    console.log("BLS verifyBeaconRound FAILED:", e.shortMessage || e.message);
  }
  // negative control: tamper the round number
  try {
    await b.verifyBeaconRound(Number(r.round) - 1, [s0, s1]);
    console.log("!! NEGATIVE CONTROL PASSED — beacon accepts a WRONG round (BROKEN)");
  } catch (e: any) {
    console.log("negative control correctly reverts:", (e.shortMessage || e.message).slice(0, 90));
  }
  console.log("beacon.roundAt(now)", (await b.roundAt(Math.floor(Date.now() / 1000))).toString(), " (drand says latest =", r.round, ")");

  // ── round ledger reconciliation ──
  const cur = Number(await g.currentRoundId());
  const feeBps = await g.protocolFeeBps();
  const tip = await g.resolverTipWei();
  console.log("\n=== ALL ROUNDS 1..%d ===", cur);
  let staked = 0n, dist = 0n, resolvedCount = 0;
  for (let i = 1; i <= cur; i++) {
    const rd = await g.rounds(i);
    const voided = await g.roundVoided(i);
    console.log(
      `round ${i}: start=${rd[0]} end=${rd[1]} dur=${rd[1] - rd[0]}s drand=${rd[2]} winCell=${rd[3]} resolved=${rd[4]} bonus=${rd[5]} staked=${ethers.formatEther(rd[6])} stakers=${rd[7]} winnerTotal=${ethers.formatEther(rd[8])} dist=${ethers.formatEther(rd[9])} voided=${voided}`
    );
    staked += rd[6];
    dist += rd[9];
    if (rd[4]) resolvedCount++;
  }
  console.log("totals: staked", ethers.formatEther(staked), " distributed", ethers.formatEther(dist), " resolved", resolvedCount);
  console.log("implied gross fees (staked-dist)", ethers.formatEther(staked - dist));
  console.log("live accumulatedFees          ", ethers.formatEther(await g.accumulatedFees()));
  console.log("=> tips paid out              ", ethers.formatEther(staked - dist - (await g.accumulatedFees())));
  console.log("feeBps", feeBps.toString(), "tip", ethers.formatEther(tip));

  // ── grid alignment of every round's endTime ──
  const epoch = await g.roundEpoch();
  const dur = await g.roundDuration();
  console.log("\n=== GRID ALIGNMENT (epoch %s, dur %s) ===", epoch.toString(), dur.toString());
  for (let i = 1; i <= cur; i++) {
    const rd = await g.rounds(i);
    if (rd[1] === 0n) continue;
    const preEpoch = rd[1] < epoch;
    const k = preEpoch ? "-" : ((rd[1] - epoch) % dur === 0n ? `k=${(rd[1] - epoch) / dur}` : `OFF-GRID rem=${(rd[1] - epoch) % dur}`);
    console.log(`  round ${i} end=${rd[1]} ${preEpoch ? "(pre-V7-epoch)" : k}`);
  }

  // ── owner-side escrow sanity: any unclaimed winnings for the known player(s)? ──
  console.log("\n=== EVENT SCAN (last ~40k blocks) ===");
  const latest = await p.getBlockNumber();
  const from = Math.max(0, latest - 40000);
  for (const name of ["RoundStarted", "RoundResolved", "WinningsPaid", "WinningsEscrowed", "ConfigUpdated", "PausedSet", "BeaconUpdated", "FeeRecipientUpdated", "RoundVoided", "Refunded"]) {
    try {
      const evs = await g.queryFilter((g.filters as any)[name](), from, latest);
      if (evs.length) console.log(name, "x" + evs.length, evs.slice(-6).map((e: any) => JSON.stringify(e.args.map((a: any) => String(a)))).join(" | "));
      else console.log(name, "x0");
    } catch (e: any) { console.log(name, "scan error", (e.shortMessage || e.message).slice(0, 120)); }
  }
  // ERC1967 Upgraded events on the proxy
  const iface = new ethers.Interface(["event Upgraded(address indexed implementation)"]);
  const logs = await p.getLogs({ address: PROXY, topics: [ethers.id("Upgraded(address)")], fromBlock: from, toBlock: latest });
  console.log("Upgraded events:", logs.map((l) => ({ blk: l.blockNumber, impl: ethers.getAddress("0x" + l.topics[1].slice(26)) })));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
