import { ethers } from "hardhat";

const PROXY = "0xfa29a5a324149a60086B3aeD20cBF42Bd761d5A1";
const BEACON = "0xC5c53BB4A93bCe76b99c726FFA1173Be31f14d8d";

async function main() {
  const p = ethers.provider;
  const g = await ethers.getContractAt("GriddyV7", PROXY);
  const latest = await p.getBlockNumber();
  const iface = g.interface;
  const upgIface = new ethers.Interface(["event Upgraded(address indexed implementation)", "event Initialized(uint64 version)", "event OwnershipTransferred(address indexed p, address indexed n)", "event OwnershipTransferStarted(address indexed p, address indexed n)"]);

  const START = latest - 100000;
  for (const addr of [PROXY, BEACON]) {
    console.log("\n########", addr === PROXY ? "GAME PROXY" : "BEACON PROXY", addr, "########");
    const seen: string[] = [];
    for (let from = START; from <= latest; from += 9999) {
      const to = Math.min(from + 9998, latest);
      let logs;
      try { logs = await p.getLogs({ address: addr, fromBlock: from, toBlock: to }); }
      catch (e: any) { console.log("  chunk", from, to, "err", (e.shortMessage || e.message).slice(0, 60)); continue; }
      for (const l of logs) {
        let d: any = null;
        try { d = iface.parseLog(l as any); } catch {}
        if (!d) { try { d = upgIface.parseLog(l as any); } catch {} }
        const blk = await p.getBlock(l.blockNumber);
        const line = `  blk ${l.blockNumber} ts ${blk!.timestamp} ${new Date(blk!.timestamp * 1000).toISOString()} tx ${l.transactionHash.slice(0, 12)} ${d ? d.name + " " + JSON.stringify(d.args.map((a: any) => String(a))) : "UNKNOWN topic0=" + l.topics[0]}`;
        // only print admin/lifecycle events, plus counts for the rest
        if (!d || ["Upgraded", "Initialized", "ConfigUpdated", "PausedSet", "BeaconUpdated", "FeeRecipientUpdated", "OwnershipTransferred", "OwnershipTransferStarted", "RoundVoided", "VoidRequested", "Refunded", "WinningsEscrowed", "WinningsWithdrawn", "RoundRepinned", "EmptyRoundSkipped"].includes(d.name)) {
          console.log(line);
        }
        seen.push(d ? d.name : "UNKNOWN");
      }
    }
    const counts: Record<string, number> = {};
    for (const s of seen) counts[s] = (counts[s] || 0) + 1;
    console.log("  event counts:", JSON.stringify(counts));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
