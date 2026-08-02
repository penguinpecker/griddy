import { ethers } from "hardhat";

const PROXY = "0xfa29a5a324149a60086B3aeD20cBF42Bd761d5A1";
const BEACON = "0xC5c53BB4A93bCe76b99c726FFA1173Be31f14d8d";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// OZ Initializable v5 namespaced storage:
// keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~0xff
const INIT_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

async function main() {
  const p = ethers.provider;
  const net = await p.getNetwork();
  const blk = await p.getBlock("latest");
  console.log("chainId", net.chainId.toString(), "block", blk!.number, "ts", blk!.timestamp, new Date(blk!.timestamp * 1000).toISOString());

  const impl = await p.getStorage(PROXY, IMPL_SLOT);
  console.log("IMPL_SLOT raw", impl);
  console.log("IMPL addr    ", ethers.getAddress("0x" + impl.slice(26)));

  const initRaw = await p.getStorage(PROXY, INIT_SLOT);
  console.log("INIT_SLOT raw", initRaw);
  const initV = BigInt(initRaw) & 0xffffffffffffffffn;
  const initializing = (BigInt(initRaw) >> 64n) & 0xffn;
  console.log("_initialized =", initV.toString(), " _initializing =", initializing.toString());

  const g = await ethers.getContractAt("GriddyV7", PROXY);
  const out: Record<string, string> = {};
  const calls: [string, () => Promise<any>][] = [
    ["owner", () => g.owner()],
    ["pendingOwner", () => g.pendingOwner()],
    ["beacon", () => g.beacon()],
    ["feeRecipient", () => g.feeRecipient()],
    ["protocolFeeBps", () => g.protocolFeeBps()],
    ["resolverTipWei", () => g.resolverTipWei()],
    ["minStakeWei", () => g.minStakeWei()],
    ["roundDuration", () => g.roundDuration()],
    ["beaconGap", () => g.beaconGap()],
    ["paused", () => g.paused()],
    ["currentRoundId", () => g.currentRoundId()],
    ["accumulatedFees", () => g.accumulatedFees()],
    ["pendingRefunds", () => g.pendingRefunds()],
    ["pendingWithdrawals", () => g.pendingWithdrawals()],
    ["totalUnresolvedStakes", () => g.totalUnresolvedStakes()],
    ["roundEpoch", () => g.roundEpoch()],
    ["MIN_STAKE_HI", () => g.MIN_STAKE_HI()],
    ["MIN_STAKE_LO", () => g.MIN_STAKE_LO()],
    ["MIN_BET_WINDOW", () => g.MIN_BET_WINDOW()],
    ["MAX_RESOLVER_TIP", () => g.MAX_RESOLVER_TIP()],
    ["GRID_SIZE", () => g.GRID_SIZE()],
    ["BPS_BASE", () => g.BPS_BASE()],
    ["REFUND_DELAY", () => g.REFUND_DELAY()],
    ["VOID_GRACE", () => g.VOID_GRACE()],
    ["REPIN_TIMEOUT", () => g.REPIN_TIMEOUT()],
    ["MAX_STAKERS_PER_CELL", () => g.MAX_STAKERS_PER_CELL()],
    ["PUSH_GAS", () => g.PUSH_GAS()],
    ["griddyToken_retired", () => g.griddyToken_retired()],
    ["bonusReserve_retired", () => g.bonusReserve_retired()],
  ];
  for (const [k, fn] of calls) {
    try { out[k] = String(await fn()); } catch (e: any) { out[k] = "ERROR: " + (e.shortMessage || e.message); }
  }
  console.log("=== GAME CONFIG ===");
  for (const [k, v] of Object.entries(out)) console.log(k.padEnd(24), v);

  const bal = await p.getBalance(PROXY);
  console.log("contract balance      ", bal.toString(), "(", ethers.formatEther(bal), ")");
  const reserved = BigInt(out.accumulatedFees) + BigInt(out.pendingRefunds) + BigInt(out.pendingWithdrawals) + BigInt(out.totalUnresolvedStakes);
  console.log("reserved sum          ", reserved.toString(), "(", ethers.formatEther(reserved), ")");
  console.log("SOLVENT               ", bal >= reserved, " surplus:", (bal - reserved).toString(), "(", ethers.formatEther(bal - reserved), ")");

  // ── beacon ──
  console.log("=== BEACON ===");
  const b = await ethers.getContractAt("DrandBeaconV2", BEACON);
  const bImplRaw = await p.getStorage(BEACON, IMPL_SLOT);
  console.log("beacon impl slot", bImplRaw, "=>", bImplRaw === ethers.ZeroHash ? "(not a UUPS/1967 proxy!)" : ethers.getAddress("0x" + bImplRaw.slice(26)));
  const bInit = await p.getStorage(BEACON, INIT_SLOT);
  console.log("beacon _initialized raw", bInit, "=>", (BigInt(bInit) & 0xffffffffffffffffn).toString());
  for (const k of ["genesisTimestamp", "period", "publicKey0", "publicKey1", "publicKey2", "publicKey3", "owner"]) {
    try { console.log("beacon." + k, String(await (b as any)[k]())); } catch (e: any) { console.log("beacon." + k, "ERROR", e.shortMessage || e.message); }
  }
  console.log("beacon.DST", await b.DST());
  console.log("game.beacon == BEACON:", out.beacon.toLowerCase() === BEACON.toLowerCase());

  // ── current round + window ──
  console.log("=== ROUND STATE ===");
  const rid = BigInt(out.currentRoundId);
  for (const id of [rid - 2n, rid - 1n, rid]) {
    if (id < 1n) continue;
    const r = await g.rounds(id);
    console.log(`round ${id}: start=${r[0]} end=${r[1]} drandRound=${r[2]} winCell=${r[3]} resolved=${r[4]} totalStaked=${r[6]} stakers=${r[7]} winnerTotal=${r[8]} distributable=${r[9]} voided=${await g.roundVoided(id)}`);
  }

  console.log("=== WINDOW SAMPLES ===");
  const epoch = BigInt(out.roundEpoch);
  const dur = BigInt(out.roundDuration);
  for (let i = 0; i < 5; i++) {
    const w = await g.currentWindow();
    const bl = await p.getBlock("latest");
    const [ws, we, dr, sl] = w;
    const onGrid = (BigInt(we) - epoch) % dur === 0n;
    const startOnGrid = (BigInt(ws) - epoch) % dur === 0n;
    const beaconTime = await b.timeOfRound(dr);
    console.log(
      `t=${bl!.timestamp} blk=${bl!.number} | windowStart=${ws} windowEnd=${we} drandRound=${dr} secondsLeft=${sl}` +
      ` | endOnGrid=${onGrid} startOnGrid=${startOnGrid} k_end=${(BigInt(we) - epoch) / dur}` +
      ` | beaconTimeOfRound=${beaconTime} (end+gap=${BigInt(we) + BigInt(out.beaconGap)}) beaconAfterEnd=${beaconTime > BigInt(we)}` +
      ` | secondsLeftCheck=${BigInt(we) - BigInt(bl!.timestamp)}`
    );
    if (i < 4) await new Promise((r) => setTimeout(r, 10000));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
