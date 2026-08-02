import { ethers } from "hardhat";
const PROXY = "0xfa29a5a324149a60086B3aeD20cBF42Bd761d5A1";

async function main() {
  const p = ethers.provider;
  const g = await ethers.getContractAt("GriddyV7", PROXY);
  const latest = await p.getBlockNumber();
  const tip = await g.resolverTipWei();
  const fee = await p.getFeeData();
  console.log("gasPrice", fee.gasPrice?.toString(), "maxFee", fee.maxFeePerGas?.toString(), "maxPrio", fee.maxPriorityFeePerGas?.toString());
  console.log("resolverTipWei", tip.toString(), "=", ethers.formatEther(tip));

  const topic = ethers.id("RoundResolved(uint256,uint8,uint256,uint256,uint256)");
  const stakeTopic = ethers.id("Staked(uint256,address,uint8,uint256,uint256,uint256)");
  const rows: any[] = [];
  for (let from = latest - 100000; from <= latest; from += 9999) {
    const to = Math.min(from + 9998, latest);
    let logs: any[] = [];
    try { logs = await p.getLogs({ address: PROXY, fromBlock: from, toBlock: to, topics: [[topic, stakeTopic]] }); } catch { continue; }
    for (const l of logs) {
      const rc = await p.getTransactionReceipt(l.transactionHash);
      const tx = await p.getTransaction(l.transactionHash);
      const kind = l.topics[0] === topic ? "resolve" : "stake";
      const cost = rc!.gasUsed * rc!.gasPrice;
      rows.push({ kind, blk: l.blockNumber, from: rc!.from, gasLimit: tx!.gasLimit.toString(), gasUsed: rc!.gasUsed.toString(), gasPrice: rc!.gasPrice.toString(), costWei: cost.toString(), cost: ethers.formatEther(cost) });
    }
  }
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.kind + r.blk;
    if (seen.has(k)) continue;
    seen.add(k);
    const net = r.kind === "resolve" ? ` | tip-cost = ${ethers.formatEther(tip - BigInt(r.costWei))}` : "";
    console.log(`${r.kind.padEnd(8)} blk ${r.blk} from ${r.from} gasLimit=${r.gasLimit} gasUsed=${r.gasUsed} gasPrice=${r.gasPrice} cost=${r.cost}${net}`);
  }

  const bal = await p.getBalance("0x52c59BC217fD0C0b2157f1B2Da1a12635E19Da4c");
  console.log("\nkeeper/owner wallet balance:", ethers.formatEther(bal));
  console.log("contract balance:", ethers.formatEther(await p.getBalance(PROXY)));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
