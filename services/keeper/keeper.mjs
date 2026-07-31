/**
 * Griddy keeper — permissionless drand resolver bot.
 *
 * Watches the Griddy contract on Arc testnet; when a round ends it fetches
 * the pinned drand evmnet beacon signature (public, verifiable) and calls
 * resolveRound(). The contract verifies the BLS signature on-chain, so this
 * bot holds no trust: anyone can run it, and the caller earns resolverReward.
 * Also serves the SSE event feed the frontend consumes and (optionally)
 * mirrors rounds into Supabase.
 *
 * Env:
 *   PRIVATE_KEY        keeper wallet (needs dust native USDC for gas)
 *   GRIDDY_ADDRESS      deployed Griddy contract
 *   RPC_URL            default https://rpc.testnet.arc.network
 *   CHAIN_ID           default 5042002 (Arc testnet)
 *   SEQUENCER_RPC      optional write-only endpoint (lower latency, FCFS)
 *   PORT               SSE port, default 8787
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   optional history mirror (gz_rounds)
 */
import http from "node:http";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http as viemHttp,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const SEQUENCER_RPC = process.env.SEQUENCER_RPC || RPC_URL;
const GRIDDY_ADDRESS = process.env.GRIDDY_ADDRESS;
const PORT = Number(process.env.PORT || 8787);
if (!process.env.PRIVATE_KEY || !GRIDDY_ADDRESS) {
  console.error("PRIVATE_KEY and GRIDDY_ADDRESS are required");
  process.exit(1);
}

// drand evmnet — signatures verified on-chain; mirrors are interchangeable
const DRAND_CHAIN_HASH = "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";
const DRAND_MIRRORS = [
  `https://api.drand.sh/${DRAND_CHAIN_HASH}`,
  `https://api2.drand.sh/${DRAND_CHAIN_HASH}`,
  `https://api3.drand.sh/${DRAND_CHAIN_HASH}`,
  `https://drand.cloudflare.com/${DRAND_CHAIN_HASH}`,
];
const DRAND_GENESIS = 1727521075;
const DRAND_PERIOD = 3;

export const gameChain = defineChain({
  id: Number(process.env.CHAIN_ID || 5042002),
  name: "Arc Testnet",
  // Arc's native gas token is USDC (18-decimal native representation)
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.network" },
  },
});

const ABI = parseAbi([
  "function currentRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (uint64 startTime, uint64 endTime, uint64 drandRound, uint8 winningCell, bool resolved, bool isBonusRound, uint256 totalStaked, uint256 totalStakers, uint256 winnerTotal, uint256 distributable, uint256 griddyBase)",
  "function resolveRound(uint256 roundId, uint256[2] signature)",
  "function skipEmptyRound(uint256 roundId)",
  "function repinRound(uint256 roundId)",
  "function getCellStakers(uint256 roundId, uint8 cell) view returns (address[])",
  "function stakeOf(uint256 roundId, uint8 cell, address player) view returns (uint256)",
  "event Staked(uint256 indexed roundId, address indexed player, uint8 cell, uint256 amount, uint256 playerCellTotal, uint256 cellTotalAfter)",
  "event RoundResolved(uint256 indexed roundId, uint8 winningCell, uint256 winnersCount, bool isBonusRound)",
]);

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const publicClient = createPublicClient({
  chain: gameChain,
  transport: viemHttp(RPC_URL),
  // Public Arc RPC rate-limits aggressive polling; 4s is plenty for 30s rounds
  pollingInterval: 4000,
});
const walletClient = createWalletClient({ account, chain: gameChain, transport: viemHttp(RPC_URL) });
// The sequencer endpoint is submission-only (rejects reads): when configured,
// txs are prepared+signed against the regular RPC and only the raw broadcast
// goes to the sequencer.
const seqClient =
  SEQUENCER_RPC !== RPC_URL
    ? createWalletClient({ account, chain: gameChain, transport: viemHttp(SEQUENCER_RPC) })
    : null;

// ─── SSE feed (same event shapes the frontend already consumes) ───
const sseClients = new Set();
http
  .createServer((req, res) => {
    if (req.url !== "/events") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ round: lastKnownRoundId })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  })
  .listen(PORT, () => log(`SSE feed on :${PORT}/events`));

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}
setInterval(() => broadcast("ping", { t: Date.now() }), 15000);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastKnownRoundId = null;

// ─── drand fetch with mirror failover ───
// Bounded: returns null on deadline so the main loop re-reads chain state and
// keeps logging instead of wedging silently on an API change or drand halt.
async function fetchBeacon(round, deadlineMs = 60_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    for (const base of DRAND_MIRRORS) {
      try {
        const res = await fetch(`${base}/public/${round}`, { signal: AbortSignal.timeout(4000) });
        if (res.status === 425 || res.status === 404) break; // not emitted yet — wait, don't rotate
        if (!res.ok) {
          log(`drand ${base} status ${res.status}`);
          continue;
        }
        const body = await res.json();
        if (body.round !== round || !/^[0-9a-f]{128}$/.test(body.signature)) {
          log(`drand ${base} shape mismatch: round=${body.round} sigLen=${String(body.signature).length}`);
          continue;
        }
        return [BigInt("0x" + body.signature.slice(0, 64)), BigInt("0x" + body.signature.slice(64))];
      } catch (e) {
        log(`drand ${base} error: ${e.message}`);
        continue; // mirror down — try next
      }
    }
    await sleep(250);  }
  log(`drand round ${round} not obtained within ${deadlineMs}ms — will retry`);
  return null;
}

// ─── optional Supabase mirror (schema: services/keeper/schema.sql) ───
async function sb(path, method, body, extraPrefer = "") {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: `resolution=merge-duplicates${extraPrefer}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log(`supabase ${method} ${path} failed:`, res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    log(`supabase ${method} ${path} failed:`, e.message);
  }
}

// ─── live entry feed → SSE ───
// Arc's public RPC accepts eth_newFilter but errors on eth_getFilterChanges
// (server-side filters don't survive), which breaks viem's watchContractEvent
// in both modes — so poll Staked logs manually with a block cursor.
let stakedCursor = 0n;
setInterval(async () => {
  try {
    const tip = await publicClient.getBlockNumber();
    if (stakedCursor === 0n) { stakedCursor = tip; return; }
    if (tip <= stakedCursor) return;
    const logs = await publicClient.getContractEvents({
      address: GRIDDY_ADDRESS,
      abi: ABI,
      eventName: "Staked",
      fromBlock: stakedCursor + 1n,
      toBlock: tip,
    });
    stakedCursor = tip;
    for (const l of logs) {
      broadcast("cell_picked", {
        roundId: Number(l.args.roundId),
        player: l.args.player,
        cell: Number(l.args.cell),
        amount: l.args.amount.toString(),
        playerCellTotal: l.args.playerCellTotal.toString(),
        cellTotalAfter: l.args.cellTotalAfter.toString(),
      });
      // playerCellTotal is the running total, so upsert is idempotent on replay
      sb("griddy_stakes?on_conflict=round_id,player_address,cell", "POST", {
        round_id: Number(l.args.roundId),
        player_address: l.args.player.toLowerCase(),
        cell: Number(l.args.cell),
        amount_wei: l.args.playerCellTotal.toString(),
        pick_tx_hash: l.transactionHash,
      });
    }
  } catch (e) {
    log("staked poll error:", e.shortMessage || e.message);
  }
}, 12000);

// Nonce/fees can be staged BEFORE the beacon exists so the post-beacon path
// is a single sign + broadcast (latency-critical for fast resolution).
async function stageTx() {
  const [nonce, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address }),
    publicClient.estimateFeesPerGas(),
  ]);
  return { nonce, ...fees, gas: 12_000_000n };
}

async function sendResolve(fn, roundId, args, staged) {
  const overrides = staged ?? {};
  let hash;
  const sender = seqClient ?? walletClient;
  if (staged) {
    // Everything known — sign locally and fire the raw tx immediately
    const serializedTransaction = await walletClient.signTransaction(
      await walletClient.prepareTransactionRequest({
        to: GRIDDY_ADDRESS,
        data: encodeFunctionData({ abi: ABI, functionName: fn, args }),
        ...overrides,
      })
    );
    hash = await sender.sendRawTransaction({ serializedTransaction });
  } else {
    hash = await walletClient.writeContract({
      address: GRIDDY_ADDRESS,
      abi: ABI,
      functionName: fn,
      args,
    });
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${fn} reverted: ${hash}`);
  return hash;
}

// ─── main loop ───
log(`Griddy keeper starting — contract ${GRIDDY_ADDRESS}, keeper ${account.address}`);
for (;;) {
  try {
    const roundId = await publicClient.readContract({
      address: GRIDDY_ADDRESS,
      abi: ABI,
      functionName: "currentRoundId",
    });
    const round = await publicClient.readContract({
      address: GRIDDY_ADDRESS,
      abi: ABI,
      functionName: "rounds",
      args: [roundId],
    });
    const [, endTime, drandRound, , resolved, , , totalStakers] = round;

    lastKnownRoundId = Number(roundId);
    const now = Math.floor(Date.now() / 1000);
    if (now < Number(endTime)) {
      await sleep(Math.min((Number(endTime) - now) * 1000, 5000));
      continue;
    }
    if (resolved) {
      await sleep(4000);
      continue;
    }

    if (totalStakers === 0n) {
      // Gas guard: skipping an empty round costs a real tx (~$0.008 on Arc,
      // where gas is USDC), and rounds tick every 30s — an unconditional
      // skip burns ~$20/day with zero players. Only keep empty rounds
      // rolling while somebody is actually watching (SSE clients); a
      // viewer's page connects on load, which un-sticks the round for them.
      if (sseClients.size === 0) {
        await sleep(10000);
        continue;
      }
      const hash = await sendResolve("skipEmptyRound", roundId, [roundId]);
      log(`round ${roundId} empty — skipped (${hash})`);
      broadcast("round_resolved", { roundId: Number(roundId), skipped: true, txHash: hash });
      continue;
    }

    // Stage nonce/gas/fees while waiting for the pinned beacon, then the
    // post-beacon path is fetch → sign → broadcast with zero extra RPCs
    const staged = await stageTx();
    const beaconTime = DRAND_GENESIS + (Number(drandRound) - 1) * DRAND_PERIOD;
    const now2 = Math.floor(Date.now() / 1000);
    if (now2 < beaconTime) await sleep(Math.max(0, (beaconTime - now2) * 1000 - 500));
    const sig = await fetchBeacon(Number(drandRound));
    if (!sig) {
      // drand appears to have missed the pinned round; once the contract's
      // 5-minute timeout passes, re-pin to a fresh future beacon
      if (Math.floor(Date.now() / 1000) > beaconTime + 300) {
        try {
          const h = await sendResolve("repinRound", roundId, [roundId]);
          log(`round ${roundId} re-pinned to a later beacon (${h})`);
        } catch (e) {
          log("repin failed:", e.shortMessage || e.message);
        }
      }
      continue; // loop re-reads state (incl. any new drandRound) and retries
    }
    const hash = await sendResolve("resolveRound", roundId, [roundId, sig], staged);

    const after = await publicClient.readContract({
      address: GRIDDY_ADDRESS,
      abi: ABI,
      functionName: "rounds",
      args: [roundId],
    });
    const payload = {
      roundId: Number(roundId),
      skipped: false,
      winningCell: Number(after[3]),
      players: Number(after[7]),
      txHash: hash,
      drandRound: Number(drandRound),
    };
    log(`round ${roundId} resolved → cell ${payload.winningCell}${after[5] ? " MOTHERLODE" : ""} (${hash})`);
    broadcast("round_resolved", payload);
    if (after[5]) broadcast("bonus_round", { roundId: Number(roundId) });
    // Column names match what the frontend reads (see schema.sql)
    await sb("griddy_rounds?on_conflict=round_id", "POST", {
      round_id: Number(roundId),
      winning_cell: payload.winningCell,
      total_staked_wei: after[6].toString(),
      total_stakers: Number(after[7]),
      winner_total_wei: after[8].toString(),
      distributable_wei: after[9].toString(),
      drand_round: Number(drandRound),
      resolve_tx_hash: hash,
    });
    // Mark winners so user history shows won/lost correctly
    const winners = await publicClient.readContract({
      address: GRIDDY_ADDRESS,
      abi: ABI,
      functionName: "getCellStakers",
      args: [roundId, payload.winningCell],
    });
    const winnerTotal = after[8], distributable = after[9];
    for (const w of winners) {
      const s = await publicClient.readContract({
        address: GRIDDY_ADDRESS, abi: ABI, functionName: "stakeOf",
        args: [roundId, payload.winningCell, w],
      });
      const payout = winnerTotal > 0n ? (distributable * s) / winnerTotal : 0n;
      await sb(
        `griddy_stakes?round_id=eq.${Number(roundId)}&player_address=eq.${w.toLowerCase()}&cell=eq.${payload.winningCell}`,
        "PATCH",
        { is_winner: true, payout_wei: payout.toString() }
      );
    }
  } catch (e) {
    log("loop error:", e.shortMessage || e.message);
    if (e.metaMessages?.length) log("  meta:", e.metaMessages.join(" | "));
    if (e.details) log("  details:", e.details);
    await sleep(10000);
  }
}
