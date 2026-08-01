/**
 * Griddy keeper — permissionless drand resolver bot.
 *
 * Watches the Griddy contract on Arc (mainnet 5042 by default). V5 decouples rounds: betting
 * rolls forward lazily when someone stakes, and ANY ended round with stakers
 * is resolvable permissionlessly (not just the current one). The keeper walks
 * a resolve cursor from just behind the head round; for each ended round with
 * stakers it fetches the pinned drand evmnet beacon signature (public,
 * verifiable) and calls resolveRound(). Empty ended rounds simply expire and
 * never need a transaction. The contract verifies the BLS signature on-chain,
 * so this bot holds no trust: anyone can run it, and the caller earns
 * resolverReward. Also serves the SSE event feed the frontend consumes and
 * (optionally) mirrors rounds into Supabase.
 *
 * Env:
 *   PRIVATE_KEY        keeper wallet (needs dust native USDC for gas)
 *   GRIDDY_ADDRESS      deployed Griddy contract
 *   RPC_URL            comma-separated fallback list (Arc mainnet default)
 *   CHAIN_ID           default 5042 (Arc mainnet); 5042002 = testnet
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
  fallback,
  http as viemHttp,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Comma-separated fallback list — the official public RPC rate-limits shared
// cloud egress IPs (Railway) hard, so lean on public gateways first.
const RPC_URLS = (
  process.env.RPC_URLS || process.env.RPC_URL ||
  "https://5042.rpc.thirdweb.com,https://arc-mainnet.g.alchemy.com/v2/alch-demo"
).split(",").map((s) => s.trim()).filter(Boolean);
const RPC_URL = RPC_URLS[0];
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

const CHAIN_ID = Number(process.env.CHAIN_ID || 5042);
export const gameChain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 5042002 ? "Arc Testnet" : "Arc",
  // Arc's native gas token is USDC (18-decimal native representation)
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  // Mainnet has no public explorer yet (network still pre-launch)
  ...(CHAIN_ID === 5042002
    ? { blockExplorers: { default: { name: "Arc Explorer", url: "https://testnet.arcscan.app" } } }
    : {}),
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
const rpcTransport = fallback(RPC_URLS.map((u) => viemHttp(u, { timeout: 8000 })));
const publicClient = createPublicClient({
  chain: gameChain,
  transport: rpcTransport,
  // Public Arc RPCs rate-limit aggressive polling; 4s is plenty for 30s rounds
  pollingInterval: 4000,
});
const walletClient = createWalletClient({ account, chain: gameChain, transport: rpcTransport });
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
  let lastLog = 0;
  while (Date.now() < until) {
    // Race every mirror in parallel — resolution latency matters more than
    // the three extra HTTP requests once per round.
    const attempts = DRAND_MIRRORS.map(async (base) => {
      const res = await fetch(`${base}/public/${round}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`${base} status ${res.status}`);
      const body = await res.json();
      if (body.round !== round || !/^[0-9a-f]{128}$/.test(body.signature)) {
        throw new Error(`${base} shape mismatch: round=${body.round}`);
      }
      return [BigInt("0x" + body.signature.slice(0, 64)), BigInt("0x" + body.signature.slice(64))];
    });
    try {
      return await Promise.any(attempts);
    } catch (e) {
      if (Date.now() - lastLog > 2000) {
        lastLog = Date.now();
        log(`drand round ${round} not served yet (${e.errors?.[0]?.message || e.message})`);
      }
    }
    await sleep(250);
  }
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
// Resolution is latency-critical: pay a fat tip (blocks are sub-second, so
// this buys next-block inclusion even under load; ~$0.004 extra per resolve).
const MIN_TIP = 10_000_000_000n; // 10 gwei
// A measured resolveRound costs ~382k gas plus the payout loop (each winner
// transfer is capped at PUSH_GAS=40k by the contract). The gas LIMIT is not
// just a ceiling: EIP-1559 makes the sender reserve gasLimit * maxFeePerGas
// up front, so a blanket 12M limit priced a resolve at >1 USDC on mainnet
// and bounced it for insufficient funds. Reserve what the round can use.
const RESOLVE_BASE_GAS = 500_000n;
const GAS_PER_WINNER = 60_000n;
const MAX_WINNERS = 100n; // contract's MAX_STAKERS_PER_CELL
function resolveGasLimit(totalStakers = 0n) {
  const n = totalStakers > MAX_WINNERS ? MAX_WINNERS : totalStakers;
  return RESOLVE_BASE_GAS + GAS_PER_WINNER * n;
}
async function stageTx(totalStakers = 0n) {
  const [nonce, block, estTip] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address }),
    publicClient.getBlock(),
    publicClient.estimateMaxPriorityFeePerGas().catch(() => MIN_TIP),
  ]);
  const tip = estTip * 2n > MIN_TIP ? estTip * 2n : MIN_TIP;
  const maxFee = (block.baseFeePerGas ?? 0n) * 2n + tip;
  return {
    nonce,
    maxPriorityFeePerGas: tip,
    maxFeePerGas: maxFee,
    gas: resolveGasLimit(totalStakers),
  };
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
      maxPriorityFeePerGas: MIN_TIP,
    });
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 800 });
  if (receipt.status !== "success") throw new Error(`${fn} reverted: ${hash}`);
  return hash;
}

// ─── main loop ───
// V5 continuous model: walk a resolve cursor from just behind the head round.
// Resolved rounds and expired empty rounds only advance the cursor (empty
// rounds need no transaction — they just expire); any ended round with
// stakers gets resolved. Scanning is capped per iteration because the public
// Arc RPC rate-limits, so a deep backlog catches up over a few loops.
const MAX_SCAN_PER_ITER = 5;
let resolveCursor = null;
log(`Griddy keeper starting — contract ${GRIDDY_ADDRESS}, keeper ${account.address}`);
for (;;) {
  try {
    const currentId = await publicClient.readContract({
      address: GRIDDY_ADDRESS,
      abi: ABI,
      functionName: "currentRoundId",
    });
    lastKnownRoundId = Number(currentId);
    if (resolveCursor === null) {
      const back = currentId - 20n;
      resolveCursor = back > 1n ? back : 1n;
      log(`resolve cursor boots at round ${resolveCursor} (current ${currentId})`);
    }

    let idle = true;
    let scanned = 0;
    while (resolveCursor <= currentId && scanned < MAX_SCAN_PER_ITER) {
      scanned++;
      const roundId = resolveCursor;
      const round = await publicClient.readContract({
        address: GRIDDY_ADDRESS,
        abi: ABI,
        functionName: "rounds",
        args: [roundId],
      });
      const [, endTime, drandRound, , resolved, , , totalStakers] = round;
      const now = Math.floor(Date.now() / 1000);
      const ended = now >= Number(endTime);

      if (resolved || (ended && totalStakers === 0n)) {
        // Nothing to do — already resolved, or expired empty (no tx ever needed)
        resolveCursor = roundId + 1n;
        continue;
      }
      if (!ended) break; // rounds end in id order; nothing past this is ready yet

      // Ended with stakers and unresolved → resolve it.
      // Stage nonce/gas/fees while waiting for the pinned beacon, then the
      // post-beacon path is fetch → sign → broadcast with zero extra RPCs
      const staged = await stageTx(totalStakers);
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
        idle = false; // retry promptly; next pass re-reads state (incl. any new drandRound)
        break;
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
      resolveCursor = roundId + 1n;
      idle = false;
    }
    if (idle) await sleep(4000);
  } catch (e) {
    log("loop error:", e.shortMessage || e.message);
    if (e.metaMessages?.length) log("  meta:", e.metaMessages.join(" | "));
    if (e.details) log("  details:", e.details);
    await sleep(10000);
  }
}
