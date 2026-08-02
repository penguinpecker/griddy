"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { usePrivy, useWallets, useSendTransaction } from "@privy-io/react-auth";
import { useResolverSSE } from "./useResolverSSE";
import { createPublicClient, http, fallback, parseEther, encodeFunctionData } from "viem";
import {
  gameChain, CHAIN_ID, RPC_URL, EXPLORER, GRID_ADDR,
  ALCHEMY_RPC, GAS_SPONSOR, SSE_URL, SUPABASE_URL, SUPABASE_ANON, DRAND_CHAIN_HASH,
} from "@/lib/config";

// ═══════════════════════════════════════════════════════════════
// GRIDDY CONTRACT ABI — drand-powered 5x5 grid game (Auto-Pay)
// Chain: Arc Testnet (see lib/config.js — env-switchable)
// Stake asset: native USDC — Arc's gas token, 18 decimals on the chain-native
// balance (variable amounts, pro-rata payouts)
// Randomness: drand evmnet beacon, BLS-verified on-chain
// ═══════════════════════════════════════════════════════════════
const GRID_ABI = [
  { name: "currentRoundId", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "rounds", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [
      { name: "startTime", type: "uint64" },
      { name: "endTime", type: "uint64" },
      { name: "drandRound", type: "uint64" },
      { name: "winningCell", type: "uint8" },
      { name: "resolved", type: "bool" },
      { name: "isBonusRound", type: "bool" },
      { name: "totalStaked", type: "uint256" },
      { name: "totalStakers", type: "uint256" },
      { name: "winnerTotal", type: "uint256" },
      { name: "distributable", type: "uint256" },
      { name: "griddyBase", type: "uint256" },
    ] },
  { name: "stake", type: "function", stateMutability: "payable",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "cells", type: "uint8[]" },
      { name: "amounts", type: "uint256[]" },
    ], outputs: [] },
  { name: "getCellTotals", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ name: "totals", type: "uint256[25]" }] },
  { name: "getCellStakerCounts", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ name: "counts", type: "uint256[25]" }] },
  { name: "getPlayerStakes", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }, { name: "player", type: "address" }],
    outputs: [{ name: "stakes", type: "uint256[25]" }] },
  { name: "minStakeWei", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "protocolFeeBps", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "resolverTipWei", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "unclaimedWinnings", type: "function", stateMutability: "view",
    inputs: [{ name: "player", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "withdrawWinnings", type: "function", stateMutability: "nonpayable",
    inputs: [], outputs: [] },
  { name: "RoundResolved", type: "event", inputs: [
    { name: "roundId", type: "uint256", indexed: true },
    { name: "winningCell", type: "uint8" },
    { name: "winnersCount", type: "uint256" },
    { name: "winnerTotal", type: "uint256" },
    { name: "distributable", type: "uint256" },
  ] },
  { name: "Staked", type: "event", inputs: [
    { name: "roundId", type: "uint256", indexed: true },
    { name: "player", type: "address", indexed: true },
    { name: "cell", type: "uint8" },
    { name: "amount", type: "uint256" },
    { name: "playerCellTotal", type: "uint256" },
    { name: "cellTotalAfter", type: "uint256" },
  ] },
  { name: "WinningsPaid", type: "event", inputs: [
    { name: "roundId", type: "uint256", indexed: true },
    { name: "player", type: "address", indexed: true },
    { name: "ethAmount", type: "uint256" },
  ] },
];

// Quick-stake chips (dollars of USDC). Manual entry allowed down to MIN_STAKE.
// "1000" renders as "1K" in the chip UI; the value string stays "1000" for parseEther.
const STAKE_CHIPS = ["0.1", "1", "10", "100", "1000"];
// Host only: the debug box must never render a keyed RPC path/query
const RPC_HOST = (() => {
  try { return new URL(RPC_URL).host; } catch { return "unset"; }
})();
// Secondary panels live in an on-demand drawer so the play screen stays
// inside one viewport — nothing is removed, just folded away until asked for.
// YOUR HISTORY is no longer in here: it lives in the right rail on every
// viewport (above the bet card on desktop, below it on phones).
const DRAWER_TABS = [
  { id: "feed", label: "LIVE FEED" },
  { id: "rounds", label: "ROUND HISTORY" },
];
const MIN_STAKE_DEFAULT = 100000000000000n; // $0.0001 — fallback only; chain minStakeWei is the source of truth
const ROUND_DURATION = 30; // V5: fresh 30s window — opened by the first stake after expiry
const GRID_SIZE = 5;
const TOTAL_CELLS = GRID_SIZE * GRID_SIZE;
// Clean-slate views for the not-yet-opened next round (V5: an ended round
// never rolls forward on its own — the first stake after expiry opens it)
const EMPTY_COUNTS = new Array(TOTAL_CELLS).fill(0);
const EMPTY_TOTALS = new Array(TOTAL_CELLS).fill(0n);
const EMPTY_SET = new Set();
const dbHeaders = { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` };

const CELL_LABELS = [];
for (let r = 0; r < GRID_SIZE; r++)
  for (let c = 0; c < GRID_SIZE; c++)
    CELL_LABELS.push(`${String.fromCharCode(65 + r)}${c + 1}`);

// Our own public client — WE control the RPC, not MetaMask
const publicClient = createPublicClient({
  chain: gameChain,
  batch: { multicall: true },
  transport: fallback([
    ...(ALCHEMY_RPC ? [http(ALCHEMY_RPC, {
      timeout: 8_000,
      retryCount: 2,
      retryDelay: 500,
    })] : []),
    http(RPC_URL, {
      timeout: 8_000,
      retryCount: 1,
      retryDelay: 1_000,
    }),
  ]),
});

// Dollar display (native USDC, 18 decimals): trims to significant digits without scientific notation
const fmt = (v, d = 4) => {
  if (!v) return (0).toFixed(d);
  const n = Number(v) / 1e18;
  if (n === 0) return (0).toFixed(d);
  if (n < 0.0001) return n.toFixed(6);
  return n.toFixed(d);
};
// Spendable max: truncate (never round up) and keep gas back
const GAS_RESERVE = 50000000000000000n; // ~$0.05 — Arc gas runs ~20 gwei so a typical tx costs ~$0.004; the reserve keeps withdrawals from stranding the wallet
// Arc blocks are sub-second; a fat priority fee buys next-block inclusion for ~$0.002 extra
const TX_TIP = 10_000_000_000n; // 10 gwei
const TX_MAX_FEE = 60_000_000_000n; // 60 gwei cap (base runs ~20 gwei)
const maxWithdraw = (bal) => {
  const b = BigInt(bal || 0);
  const spend = b > GAS_RESERVE ? b - GAS_RESERVE : 0n;
  const s = spend.toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18).slice(0, 6)}`;
};
const fmtEth = (v, d = 2) => {
  if (!v) return (0).toFixed(d);
  return (Number(v) / 1e18).toFixed(d);
};

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════
export default function TheGrid() {
  const { ready, authenticated, login, logout, user, exportWallet } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();

  // Contract state
  const [round, setRound] = useState(0);
  const [roundStart, setRoundStart] = useState(0);
  const [roundEnd, setRoundEnd] = useState(0);
  const [potSize, setPotSize] = useState("0");
  const [activePlayers, setActivePlayers] = useState(0);
  const [resolved, setResolved] = useState(false);
  const [winningCell, setWinningCell] = useState(-1);
  const [claimedCells, setClaimedCells] = useState(new Set());
  const [cellCounts, setCellCounts] = useState(new Array(TOTAL_CELLS).fill(0));
  const [cellTotals, setCellTotals] = useState(new Array(TOTAL_CELLS).fill(0n));
  const [myStakes, setMyStakes] = useState(new Array(TOTAL_CELLS).fill(0n));
  const [stakeAmount, setStakeAmount] = useState("1");
  const [unclaimed, setUnclaimed] = useState(0n);
  const [ethBalance, setEthBalance] = useState("0");

  // UI state
  const [smoothTime, setSmoothTime] = useState(0);
  const [selectedCell, setSelectedCell] = useState(null);
  const lastTapRef = useRef({ cell: -1, time: 0 });
  const [hoveredCell, setHoveredCell] = useState(-1);
  const [claiming, setClaiming] = useState(false);
  const [feed, setFeed] = useState([]);
  const [userHistory, setUserHistory] = useState([]);
  const [userHistoryLoading, setUserHistoryLoading] = useState(false);
  const userHistoryLoaded = useRef(false);
  const [scanLine, setScanLine] = useState(0);
  const [error, setError] = useState(null);
  const [openPanel, setOpenPanel] = useState(null); // null | "feed" | "rounds" | "you"
  const [mobileMenu, setMobileMenu] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAddr, setWithdrawAddr] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const [withdrawSuccess, setWithdrawSuccess] = useState("");
  const [copied, setCopied] = useState(false);
  const [walletDropdown, setWalletDropdown] = useState(false); // dropdown open
  const [walletView, setWalletView] = useState("menu"); // "menu" | "withdraw"
  const walletDropdownRef = useRef(null);
  const [lastResult, setLastResult] = useState(null); // { roundId, cell, players, pot, txHash }
  const feeConfig = useRef({ feeBps: 1000n, resolverTipWei: 30000000000000n, minStakeWei: MIN_STAKE_DEFAULT }); // defaults, updated from chain
  const [roundHistory, setRoundHistory] = useState([]); // array of ALL loaded past results, newest first
  const [moneyFlow, setMoneyFlow] = useState(false);
  const [gridFlash, setGridFlash] = useState(false);
  const [historyPage, setHistoryPage] = useState(0); // current page (0 = newest)
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFullyLoaded, setHistoryFullyLoaded] = useState(false); // true when scanned back to round 1
  const historyCursor = useRef(0); // next round ID to scan backwards from
  const resolverTxHash = useRef(null);
  const HISTORY_PAGE_SIZE = 10;

  const animFrame = useRef(null);
  const pollRef = useRef(null);
  const lastRoundRef = useRef(0);
  const resolverCalledForRound = useRef(0);
  const resolvedRef = useRef(false);
  const hasStakesRef = useRef(false);

  // ─── Refresh top of history table (picks up TX hash + drand round after resolution) ───
  const refreshHistoryTop = () => {
    chainHistory.current = null;   // force a re-read from chain
    fetchRoundHistory(0, HISTORY_PAGE_SIZE).then(fresh => {
      if (!fresh.length) return;
      setRoundHistory(prev => {
        const freshIds = new Set(fresh.map(r => r.roundId));
        const older = prev.filter(r => !freshIds.has(r.roundId));
        return [...fresh, ...older];
      });
    });
  };

  // ─── SSE: Real-time events from keeper ───
  const { connected: sseConnected } = useResolverSSE({
    url: SSE_URL,
    onRoundResolved: () => {
      pollState();
      // drand beacons are final at emission — one refresh picks up the TX hash
      setTimeout(refreshHistoryTop, 3000);
    },
    onCellPicked: (data) => {
      setCellCounts(prev => {
        const next = [...prev];
        next[data.cell] = (next[data.cell] || 0) + 1;
        return next;
      });
      setClaimedCells(prev => new Set([...prev, data.cell]));
    },
  });

  // ─── Read fee config once on mount ───
  useEffect(() => {
    Promise.all([
      publicClient.readContract({ address: GRID_ADDR, abi: GRID_ABI, functionName: "protocolFeeBps" }).catch(() => 1000n),
      publicClient.readContract({ address: GRID_ADDR, abi: GRID_ABI, functionName: "resolverTipWei" }).catch(() => 30000000000000n),
      publicClient.readContract({ address: GRID_ADDR, abi: GRID_ABI, functionName: "minStakeWei" }).catch(() => MIN_STAKE_DEFAULT),
    ]).then(([bps, tip, minS]) => {
      feeConfig.current = { feeBps: BigInt(bps), resolverTipWei: BigInt(tip), minStakeWei: BigInt(minS) };
    });
  }, []);

  // ─── Lock body scroll when mobile sidebar is open ───
  useEffect(() => {
    if (mobileMenu) {
      const scrollY = window.scrollY;
      document.body.style.overflow = "hidden";
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = "0";
      document.body.style.right = "0";
      document.body.style.width = "100%";
      return () => {
        document.body.style.overflow = "";
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.left = "";
        document.body.style.right = "";
        document.body.style.width = "";
        window.scrollTo(0, scrollY);
      };
    }
  }, [mobileMenu]);

  // ─── Close wallet dropdown on click outside ───
  useEffect(() => {
    if (!walletDropdown) return;
    const handler = (e) => {
      if (walletDropdownRef.current && !walletDropdownRef.current.contains(e.target)) {
        setWalletDropdown(false);
        setWalletView("menu");
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [walletDropdown]);

  // Get the embedded wallet address
  const wallet = wallets.find((w) => w.walletClientType === "privy") || wallets[0];
  const address = wallet?.address;

  // ─── Smooth 60fps Timer ───
  useEffect(() => {
    const tick = () => {
      if (roundEnd > 0) {
        const remaining = Math.max(0, roundEnd - Date.now() / 1000);
        setSmoothTime(remaining);
      }
      animFrame.current = requestAnimationFrame(tick);
    };
    animFrame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrame.current);
  }, [roundEnd]);

  // ─── Scan Line ───
  useEffect(() => {
    const iv = setInterval(() => setScanLine((p) => (p + 1) % 100), 40);
    return () => clearInterval(iv);
  }, []);

  // ─── Poll Contract (uses OUR public client, not wallet) ───
  const pollError = useRef(null);
  const pollCount = useRef(0);
  const pollBusy = useRef(false);
  const pollState = useCallback(async () => {
    if (pollBusy.current) return; // skip if previous poll still running
    pollBusy.current = true;
    pollCount.current++;
    try {
      // 1. Get current round (CRITICAL - everything depends on this)
      let roundId;
      try {
        roundId = await publicClient.readContract({
          address: GRID_ADDR, abi: GRID_ABI, functionName: "currentRoundId",
        });
      } catch (e) {
        pollError.current = "RPC: currentRoundId failed - " + (e.shortMessage || e.message || "unknown");
        console.error("Poll: currentRoundId failed", e);
        return;
      }
      const rNum = Number(roundId);
      pollError.current = null;

      // 2. Fire ALL reads in parallel (viem multicall batches these into ~1 RPC call)
      const promises = [
        publicClient.readContract({
          address: GRID_ADDR, abi: GRID_ABI, functionName: "rounds", args: [roundId],
        }).catch(() => null),
        publicClient.readContract({
          address: GRID_ADDR, abi: GRID_ABI, functionName: "getCellStakerCounts", args: [roundId],
        }).catch(() => null),
        publicClient.readContract({
          address: GRID_ADDR, abi: GRID_ABI, functionName: "getCellTotals", args: [roundId],
        }).catch(() => null),
      ];

      // Player-specific calls (only if wallet connected)
      if (address) {
        promises.push(
          publicClient.readContract({
            address: GRID_ADDR, abi: GRID_ABI, functionName: "getPlayerStakes", args: [roundId, address],
          }).catch(() => null),
          publicClient.getBalance({ address }).catch(() => null),
          publicClient.readContract({
            address: GRID_ADDR, abi: GRID_ABI, functionName: "unclaimedWinnings", args: [address],
          }).catch(() => null),
        );
      }

      const results = await Promise.all(promises);
      const [rd, counts, totals] = results;

      // Process round data. The round id and its timing MUST land together:
      // advancing `round` while a failed rounds() read leaves `roundEnd`
      // stale makes the UI think a freshly-opened round has already ended,
      // so it hides the countdown and offers round+1 instead. (Seen live
      // when the RPC rate-limited this call but not currentRoundId.)
      if (rd) {
        setRound(rNum);
        setRoundStart(Number(rd[0]));
        setRoundEnd(Number(rd[1]));
        setPotSize(rd[6].toString());
        setActivePlayers(Number(rd[7]));
        hasStakesRef.current = Number(rd[7]) > 0;
        const isResolved = rd[4];
        setResolved(isResolved);
        resolvedRef.current = isResolved;
        if (isResolved && Number(rd[3]) >= 0) {
          setWinningCell(Number(rd[3]));
        } else if (!isResolved) {
          setWinningCell(-1);
        }
      } else {
        pollError.current = "RPC: rounds() failed - keeping last known round state";
      }

      // Process cell counts
      if (counts) {
        const claimed = new Set();
        const countsArr = new Array(TOTAL_CELLS).fill(0);
        for (let i = 0; i < TOTAL_CELLS; i++) {
          const count = Number(counts[i]);
          countsArr[i] = count;
          if (count > 0) claimed.add(i);
        }
        setClaimedCells(claimed);
        setCellCounts(countsArr);
      }
      if (totals) {
        setCellTotals(Array.from({ length: TOTAL_CELLS }, (_, i) => BigInt(totals[i])));
      }

      // Process player data
      if (address) {
        const [, , , stakes, ethBal, owed] = results;
        if (stakes) setMyStakes(Array.from({ length: TOTAL_CELLS }, (_, i) => BigInt(stakes[i])));
        if (ethBal != null) setEthBalance(ethBal.toString());
        if (owed != null) setUnclaimed(BigInt(owed));
      }
    } catch (e) {
      pollError.current = "Poll error: " + (e.shortMessage || e.message || "unknown");
      console.error("Poll error:", e);
    } finally {
      pollBusy.current = false;
    }
  }, [address, roundEnd]);

  useEffect(() => {
    pollState();
    const tick = () => {
      pollState();
      // Fast poll (500ms) only while an ended round WITH stakes awaits the
      // keeper's reveal — an ended empty round is the normal idle state (V5),
      // normal (3s) otherwise. When SSE connected, slow to 10s as safety net
      const awaitingReveal = roundEnd > 0 && Date.now() / 1000 > roundEnd && !resolvedRef.current && hasStakesRef.current;
      const interval = sseConnected ? 10000 : (awaitingReveal ? 500 : 3000);
      pollRef.current = setTimeout(tick, interval);
    };
    pollRef.current = setTimeout(tick, 3000);
    return () => { clearTimeout(pollRef.current); };
  }, [pollState, sseConnected]);

  // ─── Load round history from Supabase ───
  const historyLoaded = useRef(false);
  const historyLoadingRef = useRef(false);
  const historyFullyLoadedRef = useRef(false);
  const historyOffset = useRef(0);
  const historyTotal = useRef(0);

  // Round history read straight from chain logs — trustless, and needs no
  // database or credentials. The RPC serves the full range in one call.
  const chainHistory = useRef(null);

  const loadChainHistory = async () => {
    if (chainHistory.current) return chainHistory.current;
    const logs = await publicClient.getContractEvents({
      address: GRID_ADDR, abi: GRID_ABI, eventName: "RoundResolved",
      fromBlock: 0n, toBlock: "latest",
    });
    const rows = await Promise.all(
      logs.slice().reverse().map(async (l) => {
        let pot = 0n, drandRound = null;
        try {
          const rd = await publicClient.readContract({
            address: GRID_ADDR, abi: GRID_ABI, functionName: "rounds", args: [l.args.roundId],
          });
          pot = rd[6];
          drandRound = Number(rd[2]);
        } catch {}
        return {
          roundId: Number(l.args.roundId),
          cell: Number(l.args.winningCell),
          players: Number(l.args.winnersCount),
          pot: pot.toString(),
          resolved: true,
          txHash: l.transactionHash,
          drandRound,
        };
      })
    );
    chainHistory.current = rows;
    historyFullyLoadedRef.current = true;
    setHistoryFullyLoaded(true);
    return rows;
  };

  const fetchRoundHistory = async (offset, limit = HISTORY_PAGE_SIZE) => {
    if (historyLoadingRef.current) return [];
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    try {
      const all = await loadChainHistory();
      historyTotal.current = all.length;
      const page = all.slice(offset, offset + limit);
      historyOffset.current = offset + page.length;
      return page;
    } catch (e) {
      console.error("chain history error:", e);
      return [];
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    if (!historyLoaded.current) {
      historyLoaded.current = true;
      fetchRoundHistory(0, HISTORY_PAGE_SIZE).then(results => {
        if (results.length > 0) setRoundHistory(results);
      });
    }
  }, []);

  // Load older pages on demand
  const loadOlderHistory = () => {
    if (historyLoadingRef.current || historyFullyLoadedRef.current) return;
    fetchRoundHistory(historyOffset.current, HISTORY_PAGE_SIZE).then(results => {
      if (results.length > 0) {
        setRoundHistory(prev => {
          const existingIds = new Set(prev.map(r => r.roundId));
          const newOnes = results.filter(r => !existingIds.has(r.roundId));
          return [...prev, ...newOnes];
        });
      }
    });
  };

  // ─── User History from Supabase ───
  const userHistoryOffset = useRef(0);
  const userHistoryTotal = useRef(0);

  const fetchUserHistory = async (offset, limit = 10) => {
    if (!address) return [];
    try {
      const [mine, paid] = await Promise.all([
        publicClient.getContractEvents({
          address: GRID_ADDR, abi: GRID_ABI, eventName: "Staked",
          args: { player: address }, fromBlock: 0n, toBlock: "latest",
        }),
        publicClient.getContractEvents({
          address: GRID_ADDR, abi: GRID_ABI, eventName: "WinningsPaid",
          args: { player: address }, fromBlock: 0n, toBlock: "latest",
        }),
      ]);
      // exact USDC received per round, straight from the payout event
      const payouts = new Map();
      for (const p of paid) {
        const k = Number(p.args.roundId);
        payouts.set(k, (payouts.get(k) || 0n) + p.args.ethAmount);
      }
      // my total stake per (round, cell)
      const byKey = new Map();
      for (const l of mine) {
        const k = `${l.args.roundId}-${l.args.cell}`;
        byKey.set(k, {
          roundId: Number(l.args.roundId),
          cell: Number(l.args.cell),
          stakedWei: l.args.playerCellTotal.toString(),
        });
      }
      const rows = [...byKey.values()]
        .sort((a, b) => b.roundId - a.roundId)
        .map((r) => {
          const won = payouts.has(r.roundId);
          return {
            ...r,
            won,
            resolved: true,
            amountWei: won ? payouts.get(r.roundId).toString() : r.stakedWei,
          };
        });
      userHistoryTotal.current = rows.length;
      return rows.slice(offset, offset + limit);
    } catch (e) {
      console.error("user history error:", e);
      return [];
    }
  };

  useEffect(() => {
    if (address && !userHistoryLoaded.current) {
      userHistoryLoaded.current = true;
      userHistoryOffset.current = 0;
      setUserHistoryLoading(true);
      fetchUserHistory(0, 10).then(results => {
        setUserHistory(results);
        userHistoryOffset.current = results.length;
        setUserHistoryLoading(false);
      });
    }
  }, [address]);

  // Refresh user history when round changes (new resolved round might include user)
  useEffect(() => {
    if (round > 1 && address && userHistoryLoaded.current) {
      // Re-fetch latest to pick up new entries
      fetchUserHistory(0, 10).then(results => {
        if (results.length > 0) {
          setUserHistory(prev => {
            const merged = [...results];
            const newIds = new Set(results.map(r => r.roundId));
            for (const old of prev) {
              if (!newIds.has(old.roundId)) merged.push(old);
            }
            return merged.sort((a, b) => b.roundId - a.roundId);
          });
          userHistoryOffset.current = Math.max(userHistoryOffset.current, results.length);
        }
      });
    }
  }, [round]);

  // ─── Round Change — fetch previous round data, save to history, reset grid ───
  useEffect(() => {
    if (round > 0 && round !== lastRoundRef.current) {
      const prevRound = lastRoundRef.current;

      // Fetch previous round data from contract (don't rely on stale state)
      if (prevRound > 0) {
        publicClient.readContract({
          address: GRID_ADDR, abi: GRID_ABI, functionName: "rounds", args: [BigInt(prevRound)],
        }).then(rd => {
          // V2 tuple: [3]=winningCell [4]=resolved [6]=totalStaked [7]=totalStakers
          const players = Number(rd[7]);
          const cell = Number(rd[3]);
          const pot = rd[6].toString();
          const isResolved = rd[4];
          if (players > 0 && isResolved) { // V3: cell 0 is valid
            const result = {
              roundId: prevRound,
              cell,
              players,
              pot,
              resolved: true,
              txHash: resolverTxHash.current || null,
            };
            setLastResult(result);
            setRoundHistory(prev => {
              if (prev.some(r => r.roundId === prevRound)) return prev;
              return [result, ...prev];
            });
            addFeed(`★ Round ${prevRound} winner: Cell ${CELL_LABELS[cell] || cell}`);
            setMoneyFlow(true);
            setTimeout(() => setMoneyFlow(false), 2500);
            setHistoryPage(0);
          } else if (players > 0) {
            // V5: normal — the keeper reveals an ended round ~8-12s after
            // expiry while betting continues here; the history refresh picks
            // up the winner + tx hash once the reveal lands
            addFeed(`◈ Round ${prevRound} revealing — keeper resolving`);
            setTimeout(refreshHistoryTop, 12000);
          }
          resolverTxHash.current = null;
        }).catch(e => console.error("Failed to fetch prev round:", e));
      }

      // Flash grid on reset
      setGridFlash(true);
      setTimeout(() => setGridFlash(false), 600);
      addFeed(`◆ Round ${round} started`);
      lastRoundRef.current = round;
      setSelectedCell(null);
      setMyStakes(new Array(TOTAL_CELLS).fill(0n));
      setCellTotals(new Array(TOTAL_CELLS).fill(0n));
      setClaimedCells(new Set());
      setCellCounts(new Array(TOTAL_CELLS).fill(0));
      setWinningCell(-1);
      setResolved(false);
      resolvedRef.current = false;
    }
  }, [round]);

  // ─── Winner detected — trigger animation + update history entry ───
  useEffect(() => {
    if (resolved && winningCell >= 0 && round > 0) {
      const result = {
        roundId: round,
        cell: winningCell,
        players: activePlayers,
        pot: potSize,
        resolved: true,
        txHash: resolverTxHash.current || null,
      };
      setLastResult(result);
      setMoneyFlow(true);
      setTimeout(() => setMoneyFlow(false), 2500);
      // Upsert: update existing entry or prepend new one
      setRoundHistory(prev => {
        const idx = prev.findIndex(r => r.roundId === round);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = result;
          return updated;
        }
        return [result, ...prev];
      });
      setHistoryPage(0);
    }
  }, [resolved, winningCell]);

  // ─── Stake USDC on a cell (native value, no approvals) ───
  const stakeOnCell = async (cellIndex, amountWei) => {
    if (!wallet || claiming || round === 0 || roundEnd === 0) return;
    setClaiming(true);
    setError(null);
    // V5: rounds never roll forward on their own. A live round takes stakes at
    // its own id; once ended, the next stake must target round+1 (the contract
    // lazily opens it, then checks the id)
    const liveNow = Date.now() / 1000 < roundEnd;
    const targetRoundId = liveNow ? round : round + 1;
    try {
      const data = encodeFunctionData({
        abi: GRID_ABI,
        functionName: "stake",
        args: [BigInt(targetRoundId), [cellIndex], [amountWei]],
      });
      const receipt = await sendTransaction(
        { to: GRID_ADDR, data, value: amountWei, chainId: CHAIN_ID, maxPriorityFeePerGas: TX_TIP, maxFeePerGas: TX_MAX_FEE },
        { sponsor: GAS_SPONSOR }
      );
      addFeed(`◈ Staking $${fmt(amountWei)} on ${CELL_LABELS[cellIndex]}...`);
      await publicClient.waitForTransactionReceipt({ hash: receipt.hash, pollingInterval: 800 });
      addFeed(`✓ $${fmt(amountWei)} on ${CELL_LABELS[cellIndex]}`);
      setSelectedCell(null);
      if (targetRoundId > round) {
        // Our stake opened the next round — optimistically start its clock;
        // the poll confirms the real startTime/endTime
        const nowSec = Math.floor(Date.now() / 1000);
        setRound(targetRoundId);
        setRoundStart(nowSec);
        setRoundEnd(nowSec + ROUND_DURATION);
      }
      pollState();
    } catch (e) {
      const msg = e.shortMessage || e.message || "Transaction failed";
      setError(msg);
      addFeed(`✗ Failed: ${msg.slice(0, 80)}`);
    }
    setClaiming(false);
  };

  // ─── Claim escrowed winnings (only if a push transfer ever failed) ───
  const claimEscrow = async () => {
    if (!wallet || claiming) return;
    setClaiming(true);
    try {
      const data = encodeFunctionData({ abi: GRID_ABI, functionName: "withdrawWinnings", args: [] });
      const receipt = await sendTransaction({ to: GRID_ADDR, data, chainId: CHAIN_ID, maxPriorityFeePerGas: TX_TIP, maxFeePerGas: TX_MAX_FEE }, { sponsor: GAS_SPONSOR });
      await publicClient.waitForTransactionReceipt({ hash: receipt.hash, pollingInterval: 800 });
      addFeed(`✓ Escrowed winnings claimed`);
      pollState();
    } catch (e) {
      setError(e.shortMessage || e.message || "Claim failed");
    }
    setClaiming(false);
  };

  const addFeed = (msg) => {
    setFeed((prev) => [{ msg, time: Date.now() }, ...prev].slice(0, 20));
  };

  // ─── Copy Wallet Address ───
  const copyAddress = () => {
    if (address) {
      navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // ─── Withdraw USDC ───
  const withdrawUSDC = async () => {
    if (!wallet || !withdrawAddr || !withdrawAmt || withdrawing) return;
    setWithdrawError("");
    setWithdrawSuccess("");
    // Validate address: must be 0x + 40 hex chars
    if (!/^0x[0-9a-fA-F]{40}$/.test(withdrawAddr.trim())) {
      setWithdrawError("Invalid address — must be a valid 0x address");
      return;
    }
    const amt = parseFloat(withdrawAmt);
    if (isNaN(amt) || amt <= 0) {
      setWithdrawError("Invalid amount");
      return;
    }
    setWithdrawing(true);
    try {
      // native USDC transfer (Arc's gas token)
      const receipt = await sendTransaction(
        { to: withdrawAddr.trim(), value: parseEther(withdrawAmt), chainId: CHAIN_ID, maxPriorityFeePerGas: TX_TIP, maxFeePerGas: TX_MAX_FEE },
        { sponsor: GAS_SPONSOR }
      );
      addFeed(`↗ Withdrawing $${withdrawAmt}...`);
      await publicClient.waitForTransactionReceipt({ hash: receipt.hash, pollingInterval: 800 });
      addFeed(`✓ Withdrawn $${withdrawAmt}`);
      setWithdrawSuccess(`✓ Sent $${withdrawAmt} · ${receipt.hash.slice(0,10)}...${receipt.hash.slice(-6)}`);
      setWithdrawAddr("");
      setWithdrawAmt("");
      pollState();
    } catch (e) {
      const msg = e.shortMessage || e.message || "Withdraw failed";
      setWithdrawError(msg.slice(0, 100));
      addFeed(`✗ Withdraw failed: ${msg.slice(0, 80)}`);
    }
    setWithdrawing(false);
  };

  // ─── Derived UI State ───
  // V5 round model — an ended round NEVER rolls forward on its own:
  //   live      — now < endTime: countdown + staking into `round`
  //   revealing — ended with stakes, unresolved: the keeper reveals it ~8-12s
  //               later while betting is already open in round+1
  //   idle      — ended and empty (or already resolved): the next round waits
  //               for its first stake, which starts a fresh 30s clock
  const roundState =
    round === 0 || roundEnd === 0 ? "init"
    : smoothTime > 0 ? "live"
    : (!resolved && (activePlayers > 0 || claimedCells.size > 0)) ? "revealing"
    : "idle";
  const isNextRoundView = roundState === "revealing" || roundState === "idle";
  const displayRound = isNextRoundView ? round + 1 : round;
  // While showing the not-yet-opened next round, present a clean slate — the
  // polled state still holds the previous round until the roll lands on-chain
  const viewPot = isNextRoundView ? "0" : potSize;
  const viewPlayers = isNextRoundView ? 0 : activePlayers;
  const viewCellCounts = isNextRoundView ? EMPTY_COUNTS : cellCounts;
  const viewCellTotals = isNextRoundView ? EMPTY_TOTALS : cellTotals;
  const viewMyStakes = isNextRoundView ? EMPTY_TOTALS : myStakes;
  const viewClaimedCells = isNextRoundView ? EMPTY_SET : claimedCells;

  const actualDuration = (roundEnd > 0 && roundStart > 0) ? (roundEnd - roundStart) : ROUND_DURATION;
  const timerProgress = actualDuration > 0 ? smoothTime / actualDuration : 0;
  const timerColor = roundState !== "live" ? "#3E8BFF" : smoothTime > 10 ? "#3E8BFF" : smoothTime > 5 ? "#6FB0FF" : "#FF6B5E";

  const getStatus = () => {
    if (roundState === "init") return "INITIALIZING...";
    if (roundState === "revealing") return `ROUND ${displayRound} — FIRST PLAY STARTS THE CLOCK`;
    if (roundState === "idle") return `ROUND ${displayRound} — FIRST PLAY STARTS THE 30s CLOCK`;
    if (!ready || !authenticated) return `ROUND ${round} — LOGIN TO PLAY`;
    return `ROUND ${round} ACTIVE`;
  };

  const getCellState = (idx) => {
    if (resolved && winningCell === idx) return "winner"; // keep the reveal glow until the next round opens
    if (viewMyStakes[idx] > 0n) return "yours";
    if (viewClaimedCells.has(idx)) return "claimed";
    return "empty";
  };

  const canClaim = (idx) => {
    // Live rounds take stakes at their own id; ended rounds are open too —
    // the next stake targets round+1 and starts the fresh clock
    return authenticated && roundState !== "init";
  };

  // Parsed stake input (wei). Invalid/empty -> 0n.
  const stakeWei = (() => {
    try {
      const v = parseEther(String(stakeAmount || "0"));
      return v > 0n ? v : 0n;
    } catch {
      return 0n;
    }
  })();
  const minStake = feeConfig.current.minStakeWei;

  /**
   * Expected USDC winnings if `idx` wins, MIRRORING GriddyV2.getExpectedPayout:
   *   pool  = totalStaked + add
   *   fee   = pool * feeBps / 10000            (floor)
   *   dist  = pool - fee                       (tip comes out of the fee)
   *   mine  = myStake[idx] + add
   *   cellT = cellTotal[idx] + add
   *   out   = dist * mine / cellT              (floor)
   * All BigInt, floor division — identical to the contract's mulDiv.
   */
  const payoutFor = (idx, addWei = stakeWei) => {
    if (idx == null || idx < 0) return null;
    const { feeBps } = feeConfig.current;
    const add = addWei ?? 0n;
    const pool = BigInt(viewPot || 0) + add;
    if (pool === 0n) return 0n;
    // mirrors GriddyV4: the resolver tip is paid OUT OF the fee, so players
    // receive exactly (1 - feeBps) of the pot
    const fee = (pool * feeBps) / 10000n;
    const dist = pool - fee;
    const mine = (viewMyStakes[idx] || 0n) + add;
    const cellT = (viewCellTotals[idx] || 0n) + add;
    if (cellT === 0n || mine === 0n) return 0n;
    return (dist * mine) / cellT;
  };

  /** Multiple of your stake you'd get back if this cell wins (e.g. 2.4x) */
  const multipleFor = (idx, addWei = stakeWei) => {
    const mine = (viewMyStakes[idx] || 0n) + (addWei ?? 0n);
    if (mine === 0n) return null;
    const out = payoutFor(idx, addWei);
    if (out == null) return null;
    return Number((out * 1000n) / mine) / 1000;
  };

  const myTotalStaked = viewMyStakes.reduce((a, b) => a + b, 0n);

  // ─── Display-only derivations (presentation) ───
  const tSecs = Math.max(0, Math.floor(smoothTime));
  const timerDisplay = `${String(Math.floor(tSecs / 60)).padStart(2, "0")}:${String(tSecs % 60).padStart(2, "0")}`;
  const cellsPicked = viewMyStakes.filter((v) => v > 0n).length;
  // The winner is drawn stake-weighted (target = vrf % totalStaked), so your
  // chance is the share of the pot sitting on the cells you occupy.
  const potWeiNow = BigInt(viewPot || 0);
  const myCellsTotal = viewCellTotals.reduce((a, t, i) => (viewMyStakes[i] > 0n ? a + t : a), 0n);
  const winChancePct =
    cellsPicked > 0 && potWeiNow > 0n ? Number((myCellsTotal * 1000n) / potWeiNow) / 10 : null;

  // ─── Shared panels (rendered in the side rails on desktop, inline on mobile) ───
  const renderFeed = () => (
    <div style={S.panel}>
      <div style={S.panelHead}>
        <span>LIVE FEED</span>
        {sseConnected && <span style={S.liveTag}>● LIVE</span>}
      </div>
      <div style={{ padding: "8px 14px" }}>
        <div style={S.feedBody} className="grid-user-history-scroll">
          {feed.length === 0 ? (
            <div style={S.feedEmpty}>waiting for round activity…</div>
          ) : (
            feed.map((f, i) => (
              <div key={`${f.time}-${i}`} style={S.feedItem}>
                <span style={S.feedTime}>{new Date(f.time).toLocaleTimeString([], { hour12: false })}</span>
                <span>{f.msg}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );

  const renderUserHistory = () => (
    <div style={S.tablePanel} className="grid-table-panel">
      <div style={S.tableHead}>
        <span style={S.tableTitle}>YOUR HISTORY</span>
        <span style={S.tableMeta}>
          {userHistoryLoading ? "SCANNING..." : `${userHistory.length} ROUNDS`}
        </span>
      </div>
      <div className="grid-hist-row" style={{ ...S.tableCols, gridTemplateColumns: "38px 56px 30px 52px 30px 1fr" }}>
        <span style={S.colLabel}>RES</span>
        <span style={S.colLabel}>ROUND</span>
        <span style={S.colLabel}>CELL</span>
        <span style={{ ...S.colLabel, textAlign: "right" }}>POT</span>
        <span style={{ ...S.colLabel, textAlign: "right" }}>PLYR</span>
        <span style={{ ...S.colLabel, textAlign: "right" }}>P&L</span>
      </div>
      <div className="grid-user-history-scroll" style={{ maxHeight: 240, overflowY: "auto" }}>
        {userHistory.map((h, i) => {
          const isWin = h.won;
          // all-BigInt (mixing BigInt with Number throws at render)
          const displayAmt = fmt(BigInt(h.amountWei || 0), 5);
          return (
            <div key={h.roundId} className="grid-hist-row" style={{
              display: "grid", gridTemplateColumns: "38px 56px 30px 52px 30px 1fr",
              padding: "7px 16px", gap: 4,
              borderBottom: "1px solid rgba(148,178,255,0.04)",
            }}>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: 1,
                padding: "2px 0", borderRadius: 999, textAlign: "center",
                background: isWin ? "rgba(62,139,255,0.14)" : "rgba(255,107,94,0.1)",
                color: isWin ? "#6FB0FF" : "#FF6B5E",
              }}>
                {isWin ? "WON" : "LOST"}
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 600, color: "#D7E3FF" }}>#{h.roundId}</span>
              <span style={{ fontSize: 11, color: "#8FA3C9" }}>{CELL_LABELS[h.cell] || "?"}</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#6FB0FF", fontWeight: 600, textAlign: "right" }}>
                {h.pot ? `$${fmt(h.pot, 5)}` : "—"}
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#8FA3C9", textAlign: "right" }}>
                {h.players || "—"}
              </span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
                color: isWin ? "#6FB0FF" : "#FF6B5E", textAlign: "right", whiteSpace: "nowrap",
              }}>
                {isWin ? "+$" : "-$"}{displayAmt}
              </span>
            </div>
          );
        })}
      </div>
      {userHistory.length > 0 && userHistoryOffset.current < userHistoryTotal.current && (
        <div style={S.tableFoot}>
          <button
            onClick={() => {
              setUserHistoryLoading(true);
              fetchUserHistory(userHistoryOffset.current, 10).then(results => {
                setUserHistory(prev => {
                  const ids = new Set(prev.map(h => h.roundId));
                  return [...prev, ...results.filter(r => !ids.has(r.roundId))];
                });
                userHistoryOffset.current += results.length;
                setUserHistoryLoading(false);
              });
            }}
            style={S.loadMoreBtn}
          >
            {userHistoryLoading ? "SCANNING..." : "LOAD MORE"}
          </button>
        </div>
      )}
    </div>
  );

  // Rail slot: the same YOUR HISTORY table, with its logged-out / empty states
  // framed so the panel keeps its shape while it fills the right column.
  const renderUserHistoryPanel = () => {
    if (authenticated && userHistory.length > 0) return renderUserHistory();
    return (
      <div style={S.tablePanel} className="grid-table-panel">
        <div style={S.tableHead}>
          <span style={S.tableTitle}>YOUR HISTORY</span>
          <span style={S.tableMeta}>
            {!authenticated ? "LOCKED" : userHistoryLoading ? "SCANNING..." : "0 ROUNDS"}
          </span>
        </div>
        <div style={S.histEmpty} className="grid-hist-empty">
          <span style={S.histEmptyMark}>{userHistoryLoading ? "⟐" : authenticated ? "◇" : "🛡"}</span>
          <span style={{ ...S.drawerEmpty, padding: "10px 4px 5px" }}>
            {!authenticated
              ? "LOG IN TO SEE YOUR ROUND HISTORY"
              : userHistoryLoading
                ? "⟐ SCANNING ROUNDS..."
                : "NO ROUNDS YET — STAKE A CELL TO START YOUR HISTORY"}
          </span>
          <span style={S.histEmptySub}>every round you play lands here — win or lose, straight from the chain</span>
        </div>
      </div>
    );
  };

  const renderRoundHistory = () => {
    const totalPages = Math.ceil(roundHistory.length / HISTORY_PAGE_SIZE) || 1;
    const pageStart = historyPage * HISTORY_PAGE_SIZE;
    const pageRows = roundHistory.slice(pageStart, pageStart + HISTORY_PAGE_SIZE);
    const hasOlder = roundHistory.length > 0 && (historyPage < totalPages - 1 || !historyFullyLoaded);
    const hasNewer = historyPage > 0;
    return (
      <div style={{ ...S.tablePanel, animation: "winnerBannerIn 0.5s ease-out" }} className="grid-table-panel">
        <div style={S.tableHead}>
          <span style={S.tableTitle}>ROUND HISTORY</span>
          <span style={S.tableMeta}>
            {historyLoading ? "SCANNING..." : `${roundHistory.length} ROUNDS${historyFullyLoaded ? "" : "+"} · PAGE ${historyPage + 1}`}
          </span>
        </div>
        <div style={{ ...S.tableCols, gridTemplateColumns: "56px 48px 52px 1fr 1fr" }}>
          <span style={S.colLabel}>ROUND</span>
          <span style={S.colLabel}>WINNER</span>
          <span style={S.colLabel}>POT</span>
          <span style={{ ...S.colLabel, textAlign: "right" }}>TRANSFER</span>
          <span style={{ ...S.colLabel, textAlign: "right" }}>DRAND</span>
        </div>
        <div>
          {pageRows.length === 0 && (
            <div style={{ padding: "20px 16px", textAlign: "center", color: "#55688F", fontSize: 11, letterSpacing: 1 }}>
              {historyLoading ? "⟐ SCANNING ROUNDS..." : "NO ROUNDS WITH PLAYERS FOUND"}
            </div>
          )}
          {pageRows.map((r, i) => {
            const globalIdx = pageStart + i;
            const isLatest = globalIdx === 0 && moneyFlow;
            return (
              <div key={r.roundId} style={{
                display: "grid", gridTemplateColumns: "56px 48px 52px 1fr 1fr",
                padding: "7px 16px", gap: 4,
                borderBottom: "1px solid rgba(148,178,255,0.04)",
                background: isLatest ? "rgba(62,139,255,0.08)" : "transparent",
                transition: "background 0.5s ease",
                animation: globalIdx === 0 ? "winnerBannerIn 0.4s ease-out" : "none",
              }}>
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 600,
                  color: isLatest ? "#6FB0FF" : "#D7E3FF",
                }}>#{r.roundId}</span>
                <span style={{
                  fontSize: 12, fontWeight: 700,
                  color: r.resolved === false ? "#FF6B5E" : "#6FB0FF", letterSpacing: 0.5,
                }}>
                  {r.resolved === false ? "⏳" : (CELL_LABELS[r.cell] || "?")} {globalIdx === 0 && r.resolved !== false ? "✦" : ""}
                </span>
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 600,
                  color: isLatest ? "#6FB0FF" : "#3E8BFF",
                  animation: isLatest ? "pulse 1s ease-in-out infinite" : "none",
                }}>${fmt(r.pot, 5)}</span>
                <span style={{ textAlign: "right" }}>
                  {r.txHash && EXPLORER ? (
                    <a
                      href={`${EXPLORER}/tx/${r.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 10, color: "#3E8BFF", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      {r.txHash.slice(0, 6)}…{r.txHash.slice(-4)} ↗
                    </a>
                  ) : r.txHash ? (
                    // No public explorer on this chain — show the hash itself
                    <span style={{ fontSize: 10, color: "#8FA3C9", fontFamily: "'JetBrains Mono', monospace" }}>
                      {r.txHash.slice(0, 6)}…{r.txHash.slice(-4)}
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, color: "#3A4A73" }}>—</span>
                  )}
                </span>
                <span style={{ textAlign: "right" }}>
                  {r.drandRound ? (
                    <a
                      href={`https://api.drand.sh/${DRAND_CHAIN_HASH}/public/${r.drandRound}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 10, color: "#3E8BFF", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      #{r.drandRound} ↗
                    </a>
                  ) : (
                    <span style={{ fontSize: 10, color: "#3A4A73" }}>—</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ ...S.tableFoot, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button
            onClick={() => setHistoryPage(p => Math.max(0, p - 1))}
            disabled={!hasNewer}
            style={{
              background: hasNewer ? "rgba(62,139,255,0.12)" : "transparent",
              border: hasNewer ? "1px solid rgba(62,139,255,0.3)" : "1px solid rgba(148,178,255,0.06)",
              color: hasNewer ? "#6FB0FF" : "#3A4A73",
              padding: "4px 14px", borderRadius: 999, fontSize: 10, fontWeight: 700,
              letterSpacing: 1.5, cursor: hasNewer ? "pointer" : "default",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >◀ NEWER</button>
          <span style={{ fontSize: 10, color: "#55688F", letterSpacing: 1 }}>
            {pageStart + 1}–{Math.min(pageStart + HISTORY_PAGE_SIZE, roundHistory.length)} of {roundHistory.length}{historyFullyLoaded ? "" : "+"}
          </span>
          <button
            onClick={() => {
              const nextPage = historyPage + 1;
              const nextStart = nextPage * HISTORY_PAGE_SIZE;
              // If we need more data, fetch it
              if (nextStart >= roundHistory.length - HISTORY_PAGE_SIZE && !historyFullyLoaded) {
                loadOlderHistory();
              }
              setHistoryPage(nextPage);
            }}
            disabled={!hasOlder || historyLoading}
            style={{
              background: hasOlder ? "rgba(62,139,255,0.12)" : "transparent",
              border: hasOlder ? "1px solid rgba(62,139,255,0.3)" : "1px solid rgba(148,178,255,0.06)",
              color: hasOlder ? "#6FB0FF" : "#3A4A73",
              padding: "4px 14px", borderRadius: 999, fontSize: 10, fontWeight: 700,
              letterSpacing: 1.5, cursor: hasOlder ? "pointer" : "default",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >{historyLoading ? "LOADING..." : "OLDER ▶"}</button>
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════
  return (
    <div style={S.root} className="grid-root">
      {/* ─── BACKDROP: top glow + dotted grid + corner ticks ─── */}
      <div style={S.bgLayer} aria-hidden="true">
        <span style={{ ...S.bgTick, top: 76, left: 22 }}>+</span>
        <span style={{ ...S.bgTick, top: 76, right: 22 }}>+</span>
      </div>
      {/* ─── HEADER ─── */}
      <header style={{...S.header, display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0 14px", gap:6}} className="grid-header">
        {/* Left — logo, clickable */}
        <div style={{...S.hLeft, cursor:"pointer", flexShrink:0}} onClick={()=>window.location.href="/"}>
          <GriddyMark size={28} />
          <span style={S.logo} className="grid-logo-text">griddy</span>
        </div>
        {/* Center — nav, hidden on mobile */}
        <nav className="grid-header-nav" style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
          <button onClick={()=>window.location.href="/home"} className="nav-btn-home" style={{background:"transparent",border:"1px solid transparent",fontFamily:"'JetBrains Mono',monospace",fontSize:10,fontWeight:700,color:"#55688F",cursor:"pointer",letterSpacing:2,padding:"6px 12px",borderRadius:999,transition:"color 0.2s"}}>HOME</button>
          <button className="nav-btn-play" style={{background:"rgba(62,139,255,0.08)",border:"1px solid rgba(62,139,255,0.25)",fontFamily:"'JetBrains Mono',monospace",fontSize:10,fontWeight:700,color:"#3E8BFF",cursor:"default",letterSpacing:2,padding:"6px 12px",borderRadius:999}}>PLAY</button>
        </nav>
        {/* Right — balance pill + wallet */}
        <div style={{...S.hRight, gap:8, justifyContent:"flex-end", flexShrink:0}}>
          {authenticated && (
            <span style={S.balPill} className="grid-header-stat">
              ${fmt(ethBalance)} <b style={{ color: "#6FB0FF" }}>USDC</b>
            </span>
          )}
          {!authenticated ? (
            <button style={S.loginBtn} onClick={login}>⚡ LOGIN</button>
          ) : (
            <div ref={walletDropdownRef} style={{ position: "relative" }} className="grid-header-wallet-btn">
              <button style={{
                ...S.walletPill,
                display: "flex", alignItems: "center", gap: 6,
              }} onClick={() => { setWalletDropdown(!walletDropdown); setWalletView("menu"); }}>
                {/* Desktop: just address */}
                <span className="wallet-addr-desktop">
                  {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "WALLET"}
                </span>
                {/* Mobile: balances + short address */}
                <span className="wallet-addr-mobile" style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "nowrap" }}>
                  <span style={{ fontSize: 10, color: "#6FB0FF", fontWeight: 700 }}>${fmt(ethBalance)}</span>
                  <span style={{ color: "#3A4A73", fontSize: 9 }}>·</span>
                  <span style={{ fontSize: 9 }}>{address ? `${address.slice(0, 4)}…${address.slice(-3)}` : "W"}</span>
                </span>
                <span style={{ fontSize: 10, opacity: 0.7 }}>≡</span>
              </button>
              {walletDropdown && walletView === "menu" && (
                <div className="grid-wallet-dropdown" style={{
                  position: "absolute", top: "calc(100% + 6px)", right: 0,
                  width: 280, background: "#0A1228",
                  border: "1px solid rgba(148,178,255,0.14)", borderRadius: 16,
                  overflow: "hidden", boxShadow: "0 12px 36px rgba(0,0,0,0.6)",
                  zIndex: 9999, animation: "dropIn 0.15s ease-out",
                }}>
                  <button onClick={() => { copyAddress(); setWalletDropdown(false); }} style={S.dropdownItem}>
                    <span style={S.dropdownIcon}>📋</span> {copied ? "Copied!" : "Copy Address"}
                  </button>
                  <div style={S.dropdownDivider} />
                  <button onClick={() => { exportWallet(); setWalletDropdown(false); }} style={S.dropdownItem}>
                    <span style={S.dropdownIcon}>🔑</span> Export Key
                  </button>
                  <div style={S.dropdownDivider} />
                  <button onClick={() => setWalletView("withdraw")} style={S.dropdownItem}>
                    <span style={S.dropdownIcon}>↗</span> Withdraw
                  </button>
                  <div style={S.dropdownDivider} />
                  <button onClick={() => { logout(); setWalletDropdown(false); }} style={{ ...S.dropdownItem, color: "#FF6B5E" }}>
                    <span style={S.dropdownIcon}>⏻</span> Logout
                  </button>
                  {/* User History inside dropdown */}
                  {userHistory.length > 0 && (
                    <div style={{ borderTop: "1px solid rgba(148,178,255,0.1)", padding: "10px 14px 4px" }}>
                      <div style={{ fontSize: 9, letterSpacing: 2, color: "#8FA3C9", fontWeight: 700, marginBottom: 8 }}>YOUR HISTORY</div>
                      <div style={{ maxHeight: 200, overflowY: "auto" }}>
                        {userHistory.map((h, i) => {
                  const isWin = h.won;
                          // all-BigInt (mixing BigInt with Number throws at render)
                          const displayAmt = fmt(BigInt(h.amountWei || 0), 5);
                          return (
                            <div key={h.roundId} style={{
                              display: "grid", gridTemplateColumns: "36px 58px 26px 1fr",
                              alignItems: "center", padding: "5px 0", gap: 6,
                              borderBottom: i < userHistory.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none",
                              fontSize: 11,
                            }}>
                              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1, padding: "2px 4px", borderRadius: 999, textAlign: "center", background: isWin ? "rgba(62,139,255,0.14)" : "rgba(255,107,94,0.1)", color: isWin ? "#6FB0FF" : "#FF6B5E" }}>
                                {isWin ? "WON" : "LOST"}
                              </span>
                              <span style={{ color: "#8FA3C9", fontSize: 10 }}>R#{h.roundId}</span>
                              <span style={{ color: "#55688F", fontSize: 10 }}>{CELL_LABELS[h.cell] || "?"}</span>
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600, color: isWin ? "#6FB0FF" : "#FF6B5E", textAlign: "right" }}>
                                {isWin ? "+$" : "-$"}{displayAmt}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {userHistoryOffset.current < userHistoryTotal.current && (
                        <button
                          onClick={() => {
                            setUserHistoryLoading(true);
                            fetchUserHistory(userHistoryOffset.current, 10).then(results => {
                              setUserHistory(prev => {
                                const ids = new Set(prev.map(h => h.roundId));
                                return [...prev, ...results.filter(r => !ids.has(r.roundId))];
                              });
                              userHistoryOffset.current += results.length;
                              setUserHistoryLoading(false);
                            });
                          }}
                          style={{ width: "100%", padding: "7px 0", marginTop: 6, background: "none", border: "1px solid rgba(148,178,255,0.15)", borderRadius: 999, color: "#6FB0FF", fontSize: 10, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, letterSpacing: 1, cursor: "pointer" }}
                        >
                          {userHistoryLoading ? "SCANNING..." : "LOAD MORE"}
                        </button>
                      )}
                    </div>
                  )}
                  {!authenticated && userHistory.length === 0 && userHistoryLoading && (
                    <div style={{ padding: "8px 14px", fontSize: 10, color: "#55688F" }}>Scanning rounds...</div>
                  )}
                </div>
              )}
              {walletDropdown && walletView === "withdraw" && (
                <div className="grid-wallet-dropdown" style={{
                  position: "absolute", top: "calc(100% + 6px)", right: 0,
                  width: 300, background: "#0A1228",
                  border: "1px solid rgba(148,178,255,0.14)", borderRadius: 16,
                  overflow: "hidden", boxShadow: "0 12px 36px rgba(0,0,0,0.6)",
                  zIndex: 9999, animation: "dropIn 0.15s ease-out",
                }}>
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "12px 14px", borderBottom: "1px solid rgba(148,178,255,0.1)",
                    background: "rgba(148,178,255,0.04)",
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#6FB0FF", letterSpacing: 1.5 }}>↗ WITHDRAW USDC</span>
                    <button onClick={() => { setWalletView("menu"); setWithdrawError(""); setWithdrawSuccess(""); }} style={{
                      fontSize: 10, color: "#8FA3C9", cursor: "pointer", background: "none",
                      border: "1px solid rgba(148,178,255,0.12)", padding: "4px 10px", borderRadius: 999,
                      fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5,
                    }}>◀ BACK</button>
                  </div>
                  <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "0 2px" }}>
                      <span style={{ color: "#55688F" }}>Available</span>
                      <span style={{ color: "#6FB0FF", fontWeight: 600, cursor: "pointer" }} onClick={() => setWithdrawAmt(maxWithdraw(ethBalance))}>${fmt(ethBalance, 6)} (MAX)</span>
                    </div>
                    <div style={{ fontSize: 9, color: "#55688F", padding: "0 2px", lineHeight: 1.4 }}>
                      MAX keeps ~$0.05 back for gas so the wallet is never stranded
                    </div>
                    <input
                      placeholder="Destination address (0x...)"
                      value={withdrawAddr}
                      onChange={(e) => { setWithdrawAddr(e.target.value); setWithdrawError(""); setWithdrawSuccess(""); }}
                      style={{ ...S.dropdownInput, borderColor: withdrawError ? "rgba(255,107,94,0.4)" : "rgba(148,178,255,0.15)" }}
                    />
                    <input
                      placeholder="Amount in USDC"
                      value={withdrawAmt}
                      onChange={(e) => { setWithdrawAmt(e.target.value); setWithdrawError(""); setWithdrawSuccess(""); }}
                      style={S.dropdownInput}
                    />
                    {withdrawError && (
                      <div style={{ fontSize: 10, color: "#FF6B5E", padding: "4px 2px", lineHeight: 1.4 }}>
                        ⚠ {withdrawError}
                      </div>
                    )}
                    {withdrawSuccess && (
                      <div style={{ fontSize: 10, color: "#6FB0FF", padding: "4px 2px", lineHeight: 1.4, fontWeight: 600 }}>
                        {withdrawSuccess}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      <button
                        style={{ ...S.claimBtn, flex: "1 1 0", width: "auto", minWidth: 0, fontSize: 11, padding: "10px", opacity: withdrawing ? 0.6 : 1 }}
                        onClick={withdrawUSDC}
                        disabled={withdrawing}
                      >
                        {withdrawing ? "SENDING..." : "SEND"}
                      </button>
                      <button
                        style={{ ...S.claimBtn, flex: "0 0 auto", width: "auto", fontSize: 11, padding: "10px 16px", border: "1px solid rgba(148,178,255,0.2)", color: "#8FA3C9", background: "none", boxShadow: "none" }}
                        onClick={() => { setWalletDropdown(false); setWalletView("menu"); setWithdrawAddr(""); setWithdrawAmt(""); setWithdrawError(""); setWithdrawSuccess(""); }}
                      >
                        CANCEL
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </header>

      {/* ─── MAIN ─── */}
      <div style={S.main} className="grid-main">
        <div style={S.stage} className="grid-stage">
        {/* Grid on the left, bet controls on the right (stacked ≤768) */}
        <div style={S.cols} className="grid-cols">

        {/* ─── GAME COLUMN ─── */}
        <div style={S.colLeft} className="grid-game-area">
          {/* Round tag + pot hero */}
          <div style={S.hero} className="grid-hero">
          <div style={S.roundTag}>ROUND {roundState === "init" ? "—" : displayRound}</div>
          <div style={S.potLabel} className="grid-pot-label">✦ TOTAL POT ✦</div>
          <div style={S.potHero} className="grid-pot-hero">
            ${fmt(viewPot)}<span style={S.potUnit} className="grid-pot-unit"> USDC</span>
          </div>
          {lastResult && (
            <div style={S.lastPill} className="grid-last-pill">
              ✦ R{lastResult.roundId} · {CELL_LABELS[lastResult.cell] || "?"} TOOK <span style={{ color: "#6FB0FF", fontWeight: 700 }}>${fmt(lastResult.pot)}</span>
            </div>
          )}
          {/* V5 reveal chip: the previous round resolves in the background
               while betting is already open here — flips to the winner */}
          {roundState === "revealing" && (
            <div style={S.revealChip} className="grid-reveal-chip">
              <span style={S.revealDot} />REVEALING ROUND {round} ✦
            </div>
          )}
          {roundState === "idle" && resolved && winningCell >= 0 && (
            <div style={{ ...S.revealChip, ...S.revealChipWin }} className="grid-reveal-chip">
              ✦ ROUND {round} WINNER — {CELL_LABELS[winningCell] || winningCell}
            </div>
          )}
          </div>

          {/* Countdown */}
          <div style={S.timerPanel} className="grid-timer-panel">
            <div style={S.timerLabel}>
              {roundState === "init" ? "INITIALIZING"
                : roundState === "revealing" ? `ROUND ${displayRound} — FIRST PLAY STARTS THE CLOCK`
                : roundState === "idle" ? "FIRST PLAY STARTS THE 30s CLOCK"
                : "PICK A SQUARE"}
            </div>
            <div style={{ ...S.timerBig, color: timerColor }} className="grid-timer-big">{isNextRoundView ? "READY" : timerDisplay}</div>
            <div style={S.timerBarBg} className="grid-timer-bar">
              <div style={{
                ...S.timerBarFill,
                width: `${timerProgress * 100}%`,
                backgroundColor: timerColor,
              }} />
            </div>
          </div>

          {/* Grid — width is capped against the leftover viewport height
               (--gsize) so the board never pushes the page past one screen */}
          <div style={S.gridWrap} className="grid-wrap">
          <div style={S.gridOuter} className="grid-outer-panel">
            {/* Grid flash on new round */}
            {gridFlash && (
              <div style={{
                position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                borderRadius: 22, zIndex: 15, pointerEvents: "none",
                animation: "gridResetFlash 0.6s ease-out forwards",
              }} />
            )}

            <div style={S.grid} className="grid-cells">
              {CELL_LABELS.map((label, idx) => {
                const state = getCellState(idx);
                const isSelected = selectedCell === idx;
                const isWinnerCell = resolved && winningCell === idx;
                const isMiss = resolved && winningCell >= 0 && !isWinnerCell && (state === "claimed" || state === "yours");
                const count = viewCellCounts[idx] || 0;
                return (
                  <button
                    key={idx}
                    style={{
                      ...S.cell,
                      ...(state === "claimed" ? S.cellClaimed : {}),
                      ...(state === "yours" ? S.cellYours : {}),
                      ...(hoveredCell === idx && !isSelected && state !== "winner" && state !== "yours" ? S.cellHover : {}),
                      ...(isSelected ? S.cellSelected : {}),
                      ...(state === "winner" ? S.cellWinner : {}),
                      ...(isMiss ? S.cellMiss : {}),
                      transition: "all 0.12s ease",
                      animationDelay: isWinnerCell ? "0s" : `${Math.floor(idx / GRID_SIZE) * 0.05}s`,
                    }}
                    onMouseEnter={() => setHoveredCell(idx)}
                    onMouseLeave={() => setHoveredCell(-1)}
                    onClick={() => {
                      if (!canClaim(idx)) return;
                      const now = Date.now();
                      const last = lastTapRef.current;
                      if (last.cell === idx && now - last.time < 400 && !claiming && stakeWei >= minStake) {
                        // Double-tap/click — stake the selected amount directly
                        stakeOnCell(idx, stakeWei);
                        lastTapRef.current = { cell: -1, time: 0 };
                      } else {
                        // First tap — select
                        setSelectedCell(idx);
                        lastTapRef.current = { cell: idx, time: now };
                      }
                    }}
                    onDoubleClick={() => { if (canClaim(idx) && !claiming && stakeWei >= minStake) stakeOnCell(idx, stakeWei); }}
                  >
                    <span style={S.cellLabel}>{label}</span>
                    {count > 0 && state !== "winner" && state !== "yours" && !isMiss && (
                      <span style={S.cellCount}>{count}</span>
                    )}
                    <span style={S.cellCenter}>
                      {state === "winner" ? (
                        <span style={{ fontSize: 26, animation: "winnerPop 0.6s ease-out" }}>✦</span>
                      ) : isMiss ? (
                        <span style={{ fontSize: 18, fontWeight: 700, color: "#43537A" }}>✕</span>
                      ) : state === "yours" ? (
                        <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                          <span style={S.cellYouTag}>${fmt(viewMyStakes[idx])}</span>
                          <span style={{ fontSize: 8, color: "#0A1E4A", fontWeight: 700 }}>of ${fmt(viewCellTotals[idx])}</span>
                        </span>
                      ) : count > 0 ? (
                        <span style={{ fontFamily: "'Baloo 2', sans-serif", fontSize: 13, fontWeight: 700, color: "#D7E3FF" }}>${fmt(viewCellTotals[idx])}</span>
                      ) : (
                        <span style={{
                          ...S.cellDot,
                          ...(isSelected ? { background: "#071230", boxShadow: "none" } :
                            hoveredCell === idx ? { background: "#3E8BFF", boxShadow: "0 0 8px rgba(62,139,255,0.8)" } : {}),
                        }} />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          </div>

          {/* Status */}
          <div style={S.statusBar} className="grid-status-bar">
            <span style={S.statusText}>{getStatus()}</span>
            <span className="grid-tap-hint" style={{ color: "#55688F", fontSize: 9.5, letterSpacing: 0.8, flexShrink: 0 }}>TAP TO SELECT · DOUBLE-TAP TO ENTER</span>
          </div>

        </div>

        {/* ─── BET COLUMN — right of the grid on desktop/tablet,
             stacked under it on mobile ─── */}
        <div style={S.colRight} className="grid-bet-col">

          {/* Stat row — real data only */}
          <div style={S.statRow} className="grid-stat-row">
            <div style={S.statCell}>
              <span style={S.statValueTop}>{winChancePct != null ? `${winChancePct}%` : "—"}</span>
              <span style={S.statLabel}>⚡ WIN CHANCE</span>
            </div>
            <div style={{ ...S.statCell, borderLeft: "1px solid rgba(148,178,255,0.08)", borderRight: "1px solid rgba(148,178,255,0.08)" }}>
              <span style={S.statValueTop}>{viewPlayers}</span>
              <span style={S.statLabel}>PLAYERS IN</span>
            </div>
            <div style={S.statCell}>
              <span style={S.statValueTop}>{myTotalStaked > 0n ? `$${fmt(myTotalStaked)}` : "—"}</span>
              <span style={S.statLabel}>YOU’RE IN</span>
            </div>
          </div>

          {/* Your history — above the entry controls on desktop, reordered
               below them on phones so the CTA stays the first thing you reach */}
          <div style={S.histSlot} className="grid-hist-slot">
            {renderUserHistoryPanel()}
          </div>

          {/* Bet panel — all viewports */}
          <div style={S.betPanel} className="grid-bet-panel">
            {(() => {
              const focus = selectedCell != null ? selectedCell : (hoveredCell >= 0 ? hoveredCell : null);
              const pay = focus != null ? payoutFor(focus) : null;
              const mult = focus != null ? multipleFor(focus) : null;
              const nOn = focus != null ? (viewCellCounts[focus] || 0) : 0;
              const cellPot = focus != null ? (viewCellTotals[focus] || 0n) : 0n;
              const belowMin = stakeWei < minStake;
              return (
                <>
                  <div style={S.betHead}>
                    <span style={{ fontFamily: "'Baloo 2', sans-serif", fontSize: 18, fontWeight: 800, color: "#EAF1FF", letterSpacing: 0.5 }}>
                      {focus != null ? `CELL ${CELL_LABELS[focus]}` : "PICK A SQUARE"}
                    </span>
                    {focus != null && (
                      <span style={{ fontSize: 10, color: "#8FA3C9", letterSpacing: 0.5, fontFamily: "'JetBrains Mono', monospace" }}>
                        ${fmt(cellPot)} · {nOn} STAKER{nOn === 1 ? "" : "S"}
                      </span>
                    )}
                  </div>

                  <StakePicker
                    value={stakeAmount}
                    onChange={setStakeAmount}
                    minStake={minStake}
                    stakeWei={stakeWei}
                  />

                  <div style={S.betRows} className="grid-bet-rows">
                    <div style={S.betRow}>
                      <span>You’re in for</span>
                      <b style={{ color: "#EAF1FF" }}>${stakeAmount || "0"}</b>
                    </div>
                    <div style={S.betRow}>
                      <span>Payout if it wins</span>
                      <b style={{ color: "#6FB0FF", fontFamily: "'Baloo 2', sans-serif" }}>
                        {pay != null ? `$${fmt(pay)}` : "—"}
                      </b>
                    </div>
                    {mult != null && focus != null && (
                      <div style={S.betRow}>
                        <span>Return multiple</span>
                        <b style={{ color: mult >= 1 ? "#6FB0FF" : "#FF6B5E", fontFamily: "'Baloo 2', sans-serif" }}>
                          {mult.toFixed(2)}×
                        </b>
                      </div>
                    )}
                    <div style={S.betNote} className="grid-bet-note">
                      pro-rata: your share of the winning cell × (pot − {(Number(feeConfig.current.feeBps) / 100).toFixed(0)}% fee). {(100 - Number(feeConfig.current.feeBps) / 100).toFixed(0)}% of every pot goes to players.
                    </div>
                  </div>

                  {error && (
                    <div style={S.errorBox} onClick={() => setError(null)}>
                      ⚠ {String(error).slice(0, 120)} — tap to dismiss
                    </div>
                  )}

                  {unclaimed > 0n && (
                    <button style={{ ...S.betCta, background: "linear-gradient(180deg,#8CC0FF,#5FA6FF)" }} onClick={claimEscrow}>
                      CLAIM ${fmt(unclaimed)} ESCROWED
                    </button>
                  )}

                  {!authenticated ? (
                    <button style={S.betCta} onClick={login}>LOGIN TO PLAY ◎</button>
                  ) : claiming ? (
                    <div style={S.claimingBar}><div style={S.claimingDot} />CONFIRMING TX...</div>
                  ) : roundState === "init" ? (
                    <div style={S.betLocked}>INITIALIZING…</div>
                  ) : selectedCell != null ? (
                    <button
                      style={{ ...S.betCta, opacity: belowMin ? 0.4 : 1, cursor: belowMin ? "default" : "pointer" }}
                      disabled={belowMin}
                      onClick={() => stakeOnCell(selectedCell, stakeWei)}
                    >
                      {belowMin ? `MIN $${fmt(minStake)}` : `PLAY $${stakeAmount} ON ${CELL_LABELS[selectedCell]} ◎`}
                    </button>
                  ) : (
                    <button style={{ ...S.betCta, opacity: 0.45, cursor: "default" }} disabled>PICK A SQUARE ◎</button>
                  )}
                  {myTotalStaked > 0n && (
                    <div style={{ fontSize: 9.5, color: "#55688F", textAlign: "center", fontFamily: "'Inter', sans-serif" }}>
                      you can play more squares or top up — no limit
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* Provably fair link */}
          <a href="/how-to-play" style={S.fairLink} className="grid-fair-link">🛡 PROVABLY FAIR ›</a>

          <div style={S.railHint} className="grid-rail-hint">RANDOMNESS BY DRAND — BEACON VERIFIED ON-CHAIN EVERY ROUND</div>
        </div>

        </div>
        </div>
      </div>

      {/* Debug: show poll errors visibly */}
      {round === 0 && (
        <div style={{
          width: "100%", maxWidth: 900, padding: "10px 16px", margin: "8px auto",
          background: "rgba(255,107,94,0.08)", border: "1px solid rgba(255,107,94,0.3)",
          borderRadius: 12, fontSize: 11, color: "#FF6B5E", fontFamily: "'JetBrains Mono', monospace",
        }}>
          <b>⚠ DEBUG:</b> Round = 0 (not loading). Polls: {pollCount.current}.
          {pollError.current && <span> Error: {pollError.current}</span>}
          {!pollError.current && <span> No error caught — poll may not have run yet. Check console.</span>}
          <br/>Chain: {CHAIN_ID} | RPC: {RPC_HOST} | Contract: {GRID_ADDR.slice(0,10)}...
        </div>
      )}

      {/* ─── FOOTER + PANEL DOCK ─── */}
      <footer style={S.footer}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }} className="grid-foot-brand">
          <GriddyMark size={18} />
          <span style={S.gridOnline}>GRIDDY ONLINE</span>
        </span>
        {/* Dock — opens the secondary panels on demand, keeping the play
             screen itself inside one viewport */}
        <div style={S.dock} className="grid-dock">
          {DRAWER_TABS.map((t) => {
            const on = openPanel === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setOpenPanel(on ? null : t.id)}
                style={{ ...S.dockBtn, ...(on ? S.dockBtnOn : {}) }}
              >
                {t.label}
                {t.id === "feed" && sseConnected && <span style={S.dockLiveDot} />}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 10, color: "#55688F", letterSpacing: 1.5 }} className="grid-foot-note">ON-CHAIN · ARC · RANDOMNESS BY DRAND</span>
      </footer>

      {/* ─── PANEL DRAWER: live feed / round history / your history ─── */}
      {openPanel && (
        <>
          <div style={S.drawerScrim} onClick={() => setOpenPanel(null)} />
          <div style={S.drawer} className="grid-drawer">
            <div style={S.drawerHead}>
              <div style={S.drawerTabs}>
                {DRAWER_TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setOpenPanel(t.id)}
                    style={{ ...S.drawerTab, ...(openPanel === t.id ? S.drawerTabOn : {}) }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button style={S.drawerClose} onClick={() => setOpenPanel(null)}>✕</button>
            </div>
            <div style={S.drawerBody} className="grid-user-history-scroll">
              {openPanel === "feed" && renderFeed()}
              {openPanel === "rounds" && renderRoundHistory()}
            </div>
          </div>
        </>
      )}

      {/* ─── CSS ─── */}
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { margin: 0; padding: 0; background: #060B1C; overflow-x: hidden; }
        @keyframes cellAppear { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
        @keyframes winnerGlow {
          0%, 100% { box-shadow: 0 0 12px rgba(62,139,255,0.45), inset 0 0 10px rgba(255,255,255,0.1); }
          50% { box-shadow: 0 0 30px rgba(62,139,255,0.85), inset 0 0 18px rgba(255,255,255,0.2); }
        }
        @keyframes slideIn { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes winnerPop {
          0% { transform: scale(0.3); opacity: 0; }
          50% { transform: scale(1.3); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes gridResetFlash {
          0% { background: rgba(62,139,255,0.22); }
          100% { background: transparent; }
        }
        @keyframes winnerBannerIn {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes scanGlow {
          0% { text-shadow: 0 0 4px rgba(62,139,255,0.8); }
          50% { text-shadow: 0 0 12px rgba(62,139,255,0.9), 0 0 24px rgba(62,139,255,0.3); }
          100% { text-shadow: 0 0 4px rgba(62,139,255,0.8); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes spinR { to { transform: rotate(-360deg); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes dropIn {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .nav-btn-home:hover { color: #3E8BFF !important; }
        .nav-btn-play { pointer-events: none; }
        /* One screen, no page scroll: the root is exactly the viewport and the
           board is capped against whatever height the chrome leaves over. */
        .grid-root {
          height: 100dvh !important;
          max-height: 100dvh !important;
          overflow: hidden !important;
          --gsize: clamp(220px, calc(100dvh - 356px), 660px);
        }
        .grid-outer-panel { width: min(100%, var(--gsize)) !important; }
        /* Right rail: the history table flexes into the leftover height and
           scrolls inside itself instead of pushing the page past one screen */
        .grid-hist-slot > .grid-table-panel {
          display: flex; flex-direction: column;
          height: 100%; min-height: 0;
        }
        .grid-hist-slot .grid-user-history-scroll {
          flex: 1 1 auto; min-height: 0;
          max-height: none !important;
        }
        .grid-hist-slot .grid-table-panel > div:first-child,
        .grid-hist-slot .grid-table-panel > div:nth-child(2) { flex-shrink: 0; }
        .grid-wallet-dropdown { max-height: calc(100dvh - 88px) !important; overflow-y: auto !important; }
        .wallet-addr-mobile { display: none !important; }
        .wallet-addr-desktop { display: inline !important; }
        .grid-table-panel { min-width: 0; }
        .grid-user-history-scroll::-webkit-scrollbar,
        .grid-main::-webkit-scrollbar { width: 4px; }
        .grid-user-history-scroll::-webkit-scrollbar-track,
        .grid-main::-webkit-scrollbar-track { background: rgba(148,178,255,0.04); }
        .grid-user-history-scroll::-webkit-scrollbar-thumb,
        .grid-main::-webkit-scrollbar-thumb { background: rgba(62,139,255,0.3); border-radius: 2px; }

        /* ── TABLET 769–1199: same two-column play area, tighter gap ── */
        @media (max-width: 1199px) {
          .grid-main { padding: 0 16px !important; }
          .grid-cols { gap: 16px !important; }
          .grid-rail-hint { display: none !important; }
        }

        @media (max-width: 640px) {
          .grid-tap-hint { display: none !important; }
          .grid-header-nav { display: none !important; }
          .grid-header-stat { display: none !important; }
          .wallet-addr-desktop { display: none !important; }
          .wallet-addr-mobile { display: flex !important; }
          .grid-logo-text { font-size: 17px !important; }
          .grid-header-wallet-btn button { font-size: 9px !important; padding: 6px 10px !important; letter-spacing: 0.5px !important; }
          .grid-dock { gap: 4px !important; }
          .grid-dock button { font-size: 8px !important; padding: 5px 7px !important; letter-spacing: 0.4px !important; }
          .grid-foot-brand { min-width: 0 !important; gap: 6px !important; }
          .grid-foot-brand span { font-size: 8px !important; letter-spacing: 0.5px !important; white-space: nowrap !important; }
          footer { padding: 7px 10px !important; }
          .grid-tap-hint { display: none !important; }
        }

        /* ── MOBILE ≤768: single column — bet controls stack under the grid ── */
        @media (max-width: 768px) {
          /* Board is width-led on phones so every key stays a ≥44px tap target;
             the main column scrolls when the stack can't fit one screen. */
          .grid-root { --gsize: clamp(320px, calc(100dvh - 396px), 560px); }
          /* Entry controls first, history after — the CTA stays reachable */
          .grid-hist-slot { order: 9 !important; flex: 0 0 auto !important; }
          .grid-hist-slot > .grid-table-panel { height: auto !important; }
          .grid-hist-slot .grid-user-history-scroll { max-height: 240px !important; }
          .grid-header { position: sticky !important; top: 0 !important; height: 54px !important; }
          .grid-main { padding: 0 12px !important; }
          .grid-stage { padding: 6px 0 6px !important; }
          .grid-cols { grid-template-columns: minmax(0, 1fr) !important; gap: 8px !important; }
          .grid-bet-col { max-width: 100% !important; }
          .grid-wallet-dropdown { right: 0 !important; left: auto !important; max-width: calc(100vw - 16px) !important; }
          .grid-game-area {
            width: 100% !important;
            max-width: 100% !important;
            gap: 6px !important;
            justify-content: flex-start !important;
          }
          .grid-header-wallet-btn { font-size: 10px !important; }
          .grid-pot-label { margin: 3px 0 0 !important; }
          .grid-pot-hero { font-size: clamp(28px, 9.5vw, 38px) !important; }
          .grid-pot-unit { font-size: 14px !important; }
          .grid-last-pill { margin-top: 5px !important; padding: 3px 10px !important; }
          .grid-timer-panel {
            padding: 7px 14px 8px !important;
            flex-direction: row !important;
            flex-wrap: wrap !important;
            justify-content: space-between !important;
            align-items: center !important;
            gap: 5px !important;
            border-radius: 16px !important;
          }
          .grid-timer-big { font-size: 22px !important; line-height: 1 !important; }
          .grid-timer-bar { width: 100% !important; }
          .grid-outer-panel { padding: 9px !important; border-radius: 18px !important; }
          .grid-cells { gap: 7px !important; }
          .grid-status-bar { padding: 2px !important; }
          .grid-stat-row { padding: 7px 0 !important; border-radius: 14px !important; }
          /* Bet controls compress on mobile so the board keeps its size —
             every control stays, just tighter */
          .grid-bet-panel { padding: 10px !important; gap: 6px !important; border-radius: 16px !important; }
          .grid-bet-panel > button { padding: 11px 14px !important; }
          .grid-bet-panel input { padding: 7px 42px 7px 12px !important; font-size: 15px !important; }
          .grid-bet-rows { gap: 3px !important; }
          .grid-bet-note { font-size: 9px !important; line-height: 1.35 !important; }
          .grid-bet-col { gap: 6px !important; }
          .grid-drawer { width: calc(100vw - 16px) !important; bottom: 8px !important; max-height: 76dvh !important; }
          .grid-foot-note { display: none !important; }
          /* Touch targets: every interactive element clears 40px on phones */
          .stake-chip { min-height: 42px !important; font-size: 12px !important; }
          .grid-table-panel button { min-height: 40px; }
          .grid-dock button { min-height: 40px !important; }
          .grid-fair-link { min-height: 40px; }
          .grid-header button { min-height: 40px; }
          .grid-drawer button { min-height: 40px; }
        }

        /* ── SHORT VIEWPORTS: shave the hero before the board ── */
        @media (max-height: 780px) and (min-width: 769px) {
          .grid-pot-hero { font-size: 38px !important; }
          .grid-pot-unit { font-size: 17px !important; }
          .grid-timer-big { font-size: 26px !important; }
        }

        /* ── NARROW ≤480: keep tables inside the viewport, no page x-scroll ── */
        @media (max-width: 480px) {
          .grid-table-panel span, .grid-table-panel a {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          /* narrow phones: give POT and P&L elastic columns so the dollar
             figures print in full instead of ellipsising */
          .grid-hist-row {
            grid-template-columns: 32px 44px 26px minmax(0,0.92fr) 26px minmax(0,1.08fr) !important;
            padding-left: 10px !important;
            padding-right: 10px !important;
            gap: 2px !important;
          }
          .grid-hist-row > span { letter-spacing: 0.5px !important; }
          /* the empty-state copy is prose, not a table cell — let it wrap */
          .grid-hist-empty span {
            overflow: visible !important;
            text-overflow: clip !important;
            white-space: normal !important;
          }
        }

      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════

function StakePicker({ value, onChange, minStake, stakeWei }) {
  const belowMin = stakeWei > 0n && stakeWei < minStake;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", gap: 5 }}>
        {STAKE_CHIPS.map((c) => {
          const active = String(value) === c;
          return (
            <button
              key={c}
              className="stake-chip"
              onClick={() => onChange(c)}
              style={{
                flex: 1, padding: "7px 2px", borderRadius: 999, cursor: "pointer",
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
                background: active ? "rgba(62,139,255,0.22)" : "rgba(148,178,255,0.06)",
                border: active ? "1px solid #3E8BFF" : "1px solid rgba(148,178,255,0.12)",
                color: active ? "#EAF1FF" : "#8FA3C9",
              }}
            >
              {c === "1000" ? "1K" : c}
            </button>
          );
        })}
      </div>
      <div style={{ position: "relative" }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
          inputMode="decimal"
          placeholder="custom amount"
          style={{
            width: "100%", padding: "10px 44px 10px 14px", borderRadius: 12,
            background: "rgba(0,0,0,0.35)",
            border: `1px solid ${belowMin ? "rgba(255,107,94,0.5)" : "rgba(148,178,255,0.15)"}`,
            color: "#EAF1FF", fontFamily: "'Baloo 2', sans-serif", fontSize: 16,
            fontWeight: 700, outline: "none",
          }}
        />
        <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: "#55688F", pointerEvents: "none", fontFamily: "'JetBrains Mono', monospace" }}>USDC</span>
      </div>
      {belowMin && (
        <div style={{ fontSize: 9.5, color: "#FF6B5E" }}>minimum stake is ${Number(minStake) / 1e18}</div>
      )}
    </div>
  );
}

function GriddyMark({ size = 30 }) {
  const s = 17, g = 4.5, o = 4;
  const tiles = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const accent = r === 1 && c === 1;
    tiles.push(<rect key={r + "-" + c} x={o + c * (s + g)} y={o + r * (s + g)} width={s} height={s} rx={4.5} fill={accent ? "#3E8BFF" : "#EAF1FF"} opacity={accent ? 1 : 0.92} />);
  }
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>
      <rect x={o + 1 * (s + g) - 3} y={o + 1 * (s + g) - 3} width={s + 6} height={s + 6} rx={6} fill="rgba(62,139,255,0.45)" filter="blur(4px)" />
      {tiles}
      <text x={o + 1 * (s + g) + s / 2} y={o + 1 * (s + g) + s - 4} textAnchor="middle" fontFamily="'Baloo 2',sans-serif" fontWeight="800" fontSize="14" fill="#071230">G</text>
    </svg>
  );
}

function Panel({ title, live, children }) {
  return (
    <div style={S.panel}>
      <div style={S.panelHead}>
        <span>{title}</span>
        {live && <span style={S.liveTag}>● LIVE</span>}
      </div>
      <div style={{ padding: "8px 14px" }}>{children}</div>
    </div>
  );
}

function Row({ label, value, hl }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <span style={{ ...S.rowValue, ...(hl ? { color: "#3E8BFF" } : {}) }}>{value}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════
const S = {
  root: {
    fontFamily: "'JetBrains Mono', monospace",
    background: "#060B1C",
    color: "#C4D3F2", minHeight: "100vh",
    display: "flex", flexDirection: "column",
    position: "relative",
  },
  // ── Backdrop: top glow + faint dotted grid + corner ticks ──
  bgLayer: {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: "none", zIndex: 0,
    background:
      "radial-gradient(ellipse at 50% -10%, rgba(62,139,255,0.13), transparent 60%), " +
      "radial-gradient(rgba(148,178,255,0.05) 1px, transparent 1.5px)",
    backgroundSize: "auto, 26px 26px",
  },
  bgTick: {
    position: "absolute", fontSize: 14, color: "rgba(148,178,255,0.2)",
    fontFamily: "'JetBrains Mono', monospace",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "0 20px", height: 64, borderBottom: "1px solid rgba(148,178,255,0.08)",
    background: "rgba(6,11,28,0.92)", zIndex: 10, position: "relative",
    flexWrap: "nowrap", gap: 8, flexShrink: 0,
  },
  hLeft: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  hRight: { display: "flex", alignItems: "center", gap: 10, flexShrink: 0, minWidth: 0 },
  logo: { fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 21, color: "#F4F7FF", letterSpacing: 0.5 },
  balPill: {
    display: "inline-flex", alignItems: "center", gap: 4,
    fontSize: 11, color: "#C4D3F2", letterSpacing: 0.5,
    fontFamily: "'JetBrains Mono', monospace", fontWeight: 600,
    background: "rgba(148,178,255,0.06)", border: "1px solid rgba(148,178,255,0.12)",
    borderRadius: 999, padding: "6px 12px",
  },
  loginBtn: {
    fontFamily: "'Baloo 2', sans-serif", fontSize: 12, fontWeight: 700,
    padding: "8px 16px", borderRadius: 999,
    border: "none",
    background: "linear-gradient(180deg,#5FA6FF,#2E7BFF)",
    color: "#071230", cursor: "pointer", letterSpacing: 1,
    boxShadow: "0 4px 16px rgba(62,139,255,0.35)",
  },
  walletPill: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
    padding: "7px 12px", borderRadius: 999,
    border: "1px solid rgba(148,178,255,0.14)",
    background: "rgba(148,178,255,0.06)",
    color: "#C4D3F2", cursor: "pointer", letterSpacing: 0.5,
  },
  main: { display: "flex", flex: 1, position: "relative", zIndex: 5, width: "100%", padding: "0 24px", minHeight: 0, alignItems: "stretch", justifyContent: "center", overflowY: "auto", overflowX: "hidden" },
  // ── One-screen stage: grid column left, bet column right ──
  stage: { width: "100%", maxWidth: 1120, display: "flex", flexDirection: "column", minHeight: 0, padding: "8px 0 8px" },
  cols: {
    flex: 1, minHeight: 0, display: "grid",
    // left column tracks the board width so the timer/stat rails line up with it
    gridTemplateColumns: "minmax(0, min(100%, var(--gsize))) clamp(318px, 30%, 384px)",
    gap: 24, alignItems: "stretch", justifyContent: "center",
  },
  colLeft: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 0 },
  colRight: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: 9, minWidth: 0, minHeight: 0 },
  // YOUR HISTORY takes whatever height the bet card leaves over and scrolls
  // internally — the right rail then reaches the bottom of the stage
  histSlot: { width: "100%", flex: "1 1 auto", minHeight: 118, display: "flex", flexDirection: "column" },
  // grow into spare height, but never shrink under the board — a squeezed
  // wrapper would overlap the timer/stat rows instead of scrolling
  gridWrap: { width: "100%", flex: "1 0 auto", display: "flex", alignItems: "center", justifyContent: "center" },
  hero: { display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 },
  roundTag: { fontSize: 10, letterSpacing: 3, color: "#55688F", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  potLabel: { fontSize: 10, letterSpacing: 3, color: "#8FA3C9", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", margin: "2px 0 0" },
  potHero: {
    fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 38, lineHeight: 1.1,
    color: "#5FA6FF", textShadow: "0 0 28px rgba(62,139,255,0.45)", whiteSpace: "nowrap",
  },
  potUnit: { fontSize: 20, fontWeight: 700, color: "#8FA3C9", textShadow: "none" },
  lastPill: {
    display: "inline-flex", alignItems: "center", gap: 5,
    fontSize: 9.5, letterSpacing: 1, color: "#8FA3C9",
    fontFamily: "'JetBrains Mono', monospace", fontWeight: 600,
    background: "rgba(148,178,255,0.06)", border: "1px solid rgba(148,178,255,0.12)",
    borderRadius: 999, padding: "4px 12px", marginTop: 3,
  },
  revealChip: {
    display: "inline-flex", alignItems: "center", gap: 6,
    fontSize: 9.5, letterSpacing: 1.5, fontWeight: 700,
    fontFamily: "'JetBrains Mono', monospace", color: "#6FB0FF",
    background: "rgba(62,139,255,0.10)", border: "1px solid rgba(62,139,255,0.35)",
    borderRadius: 999, padding: "4px 12px", marginTop: 3,
    animation: "pulse 1.4s ease-in-out infinite",
  },
  revealChipWin: {
    color: "#EAF1FF",
    background: "rgba(62,139,255,0.18)", border: "1px solid rgba(62,139,255,0.55)",
    boxShadow: "0 0 14px rgba(62,139,255,0.35)",
    animation: "winnerBannerIn 0.5s ease-out",
  },
  revealDot: { width: 6, height: 6, borderRadius: "50%", background: "#3E8BFF", flexShrink: 0, animation: "pulse 1s ease-in-out infinite" },
  timerPanel: {
    width: "100%", flexShrink: 0,
    background: "#0A1228", border: "1px solid rgba(148,178,255,0.08)",
    borderRadius: 18, padding: "5px 16px 6px",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
  },
  timerLabel: { fontSize: 9, letterSpacing: 3, color: "#55688F", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  timerBig: { fontFamily: "'Baloo 2', sans-serif", fontSize: 27, fontWeight: 800, lineHeight: 1.1, transition: "color 0.5s ease" },
  timerBarBg: { width: "100%", height: 4, borderRadius: 3, background: "rgba(148,178,255,0.08)", overflow: "hidden" },
  timerBarFill: { height: "100%", borderRadius: 3, transition: "background-color 0.4s ease" },

  // ── Keycap grid ──
  gridOuter: {
    position: "relative", width: "100%",
    background: "#0A1228", border: "1px solid rgba(148,178,255,0.08)",
    borderRadius: 22, padding: 10,
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, width: "100%" },
  cell: {
    fontFamily: "'JetBrains Mono', monospace", position: "relative",
    aspectRatio: "1", borderRadius: "26%",
    cursor: "pointer", display: "flex",
    alignItems: "center", justifyContent: "center",
    fontSize: 11, fontWeight: 600,
    animation: "cellAppear 0.4s ease both",
    touchAction: "manipulation",
    background: "linear-gradient(145deg,#141F3D,#0C152E)",
    border: "1px solid rgba(150,180,255,0.10)",
    boxShadow: "0 5px 12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
    color: "#C4D3F2",
  },
  cellDot: {
    width: 4, height: 4, borderRadius: "50%",
    background: "rgba(165,190,240,0.4)", display: "inline-block",
  },
  cellHover: {
    border: "1px solid rgba(62,139,255,0.7)",
    boxShadow: "0 5px 14px rgba(0,0,0,0.45), 0 0 10px rgba(62,139,255,0.25), inset 0 1px 0 rgba(255,255,255,0.08)",
    transform: "translateY(-2px)",
  },
  cellCount: {
    position: "absolute", top: 6, right: 6,
    fontSize: 9, fontWeight: 700, lineHeight: 1,
    padding: "3px 6px", borderRadius: 999,
    background: "rgba(62,139,255,0.25)", color: "#EAF1FF",
  },
  cellCenter: { display: "flex", alignItems: "center", justifyContent: "center" },
  cellYouTag: {
    fontFamily: "'Baloo 2', sans-serif", fontSize: 10, fontWeight: 800,
    letterSpacing: 0.5, color: "#EAF1FF", background: "rgba(7,18,48,0.85)",
    padding: "3px 8px", borderRadius: 999,
  },
  cellClaimed: {
    background: "linear-gradient(145deg,#1A2850,#101B3A)",
    border: "1px solid rgba(150,180,255,0.28)",
  },
  cellYours: {
    background: "linear-gradient(160deg,#5FA6FF,#2E7BFF)",
    border: "1px solid rgba(255,255,255,0.25)",
    color: "#071230",
    boxShadow: "0 5px 14px rgba(0,0,0,0.4), 0 0 14px rgba(62,139,255,0.4)",
  },
  cellWinner: {
    background: "linear-gradient(160deg,#6FB0FF,#2E7BFF)",
    border: "1px solid rgba(255,255,255,0.35)",
    color: "#071230",
    transform: "scale(1.06)",
    boxShadow: "0 0 24px rgba(62,139,255,0.65)",
    animation: "winnerGlow 1.2s ease-in-out infinite",
    zIndex: 2,
  },
  cellSelected: {
    background: "linear-gradient(160deg,#5FA6FF,#2E7BFF)",
    border: "1px solid rgba(255,255,255,0.3)",
    color: "#071230",
    transform: "scale(1.04)",
    boxShadow: "0 0 18px rgba(62,139,255,0.55)",
    zIndex: 2,
  },
  cellMiss: {
    background: "linear-gradient(145deg,#0E1730,#0A1226)",
    border: "1px solid rgba(150,180,255,0.06)",
    boxShadow: "none",
    opacity: 0.8,
  },
  cellScanSweep: {
    background: "linear-gradient(160deg,#5FA6FF,#2E7BFF)",
    border: "1px solid rgba(255,255,255,0.3)",
    color: "#071230",
    transform: "scale(1.05)",
    boxShadow: "0 0 18px rgba(62,139,255,0.55)",
    zIndex: 2,
  },
  cellLabel: { position: "absolute", top: 7, left: 9, fontSize: 8, letterSpacing: 1, opacity: 0.45 },
  statusBar: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, width: "100%", padding: "2px 4px", fontSize: 10, letterSpacing: 1.5, color: "#55688F", flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden" },
  // the round line is the one that truncates — the same words are spelled out
  // in full in the timer panel directly above it
  statusText: { fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },

  // ── 3-cell stat row ──
  statRow: {
    width: "100%", display: "grid", gridTemplateColumns: "repeat(3, 1fr)",
    background: "#0A1228", border: "1px solid rgba(148,178,255,0.08)",
    borderRadius: 16, padding: "7px 0", flexShrink: 0,
  },
  statCell: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 0, padding: "0 6px" },
  statValueTop: { fontFamily: "'Baloo 2', sans-serif", fontSize: 16, fontWeight: 700, color: "#EAF1FF", lineHeight: 1.15, whiteSpace: "nowrap" },
  statLabel: { fontSize: 8.5, letterSpacing: 1.5, color: "#55688F", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" },

  // ── Bet panel ──
  betPanel: {
    width: "100%", display: "flex", flexDirection: "column", gap: 10,
    background: "#0A1228", border: "1px solid rgba(148,178,255,0.08)",
    borderRadius: 20, padding: 14, flexShrink: 0,
  },
  betHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  betRows: { display: "flex", flexDirection: "column", gap: 6 },
  betRow: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "#8FA3C9", fontFamily: "'Inter', sans-serif" },
  betNote: { fontSize: 9.5, color: "#55688F", lineHeight: 1.5, fontFamily: "'Inter', sans-serif" },
  betCta: {
    fontFamily: "'Baloo 2', sans-serif", fontSize: 15, fontWeight: 700,
    padding: "13px 16px", borderRadius: 999, border: "none",
    background: "linear-gradient(180deg,#5FA6FF,#2E7BFF)",
    color: "#071230", cursor: "pointer", letterSpacing: 1, width: "100%",
    boxShadow: "0 8px 24px rgba(62,139,255,0.35)",
  },
  betLocked: {
    padding: "13px 16px", textAlign: "center", borderRadius: 999,
    border: "1px solid rgba(62,139,255,0.35)", color: "#6FB0FF",
    fontSize: 12, fontWeight: 700, letterSpacing: 2,
  },
  claimingBar: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "14px 20px", borderRadius: 999, border: "1px solid rgba(62,139,255,0.3)", background: "rgba(62,139,255,0.08)", color: "#6FB0FF", fontSize: 12, fontWeight: 600, letterSpacing: 1 },
  claimingDot: { width: 8, height: 8, borderRadius: "50%", background: "#3E8BFF", animation: "pulse 1s ease-in-out infinite" },
  errorBox: { padding: "10px 14px", borderRadius: 12, border: "1px solid rgba(255,107,94,0.3)", background: "rgba(255,107,94,0.08)", color: "#FF6B5E", fontSize: 11, cursor: "pointer", lineHeight: 1.4 },
  fairLink: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6, flexShrink: 0,
    fontSize: 10, letterSpacing: 2, fontWeight: 700,
    color: "#8FA3C9", textDecoration: "none",
    fontFamily: "'JetBrains Mono', monospace",
  },

  // ── Panels + tables (side rails / mobile blocks) ──
  panel: { border: "1px solid rgba(148,178,255,0.08)", borderRadius: 20, background: "#0A1228", overflow: "hidden" },
  panelHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "#8FA3C9", borderBottom: "1px solid rgba(148,178,255,0.06)" },
  liveTag: { color: "#3E8BFF", fontSize: 10, letterSpacing: 1, animation: "scanGlow 2s ease-in-out infinite" },
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 12 },
  rowLabel: { color: "#8FA3C9", letterSpacing: 0.5 },
  rowValue: { fontWeight: 600, color: "#EAF1FF", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 },
  tablePanel: {
    width: "100%", borderRadius: 20,
    border: "1px solid rgba(148,178,255,0.08)",
    background: "#0A1228", overflow: "hidden",
  },
  tableHead: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 16px",
    borderBottom: "1px solid rgba(148,178,255,0.08)",
    background: "rgba(148,178,255,0.03)",
  },
  tableTitle: { fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "#8FA3C9", fontFamily: "'JetBrains Mono', monospace" },
  tableMeta: { fontSize: 9, color: "#55688F", letterSpacing: 1 },
  tableCols: {
    display: "grid", padding: "8px 16px 4px", gap: 4,
    borderBottom: "1px solid rgba(148,178,255,0.05)",
  },
  colLabel: { fontSize: 9, color: "#55688F", letterSpacing: 1.5, fontWeight: 700 },
  tableFoot: {
    padding: "8px 16px", textAlign: "center",
    borderTop: "1px solid rgba(148,178,255,0.08)",
    background: "rgba(148,178,255,0.02)",
  },
  loadMoreBtn: {
    width: "100%", padding: "6px 0",
    background: "none", border: "1px solid rgba(148,178,255,0.15)",
    borderRadius: 999, color: "#6FB0FF", fontSize: 10,
    fontFamily: "'JetBrains Mono', monospace", fontWeight: 600,
    letterSpacing: 1, cursor: "pointer",
  },
  railHint: { fontSize: 9, color: "#55688F", letterSpacing: 1, lineHeight: 1.7, textAlign: "center", padding: "0 8px" },

  // ── Feed ──
  feedBody: { maxHeight: 220, overflowY: "auto" },
  feedEmpty: { color: "#3A4A73", fontSize: 12, fontStyle: "italic", padding: "12px 0", fontFamily: "'Inter', sans-serif" },
  feedItem: { fontSize: 10.5, padding: "4px 0", borderBottom: "1px solid rgba(148,178,255,0.04)", display: "flex", gap: 8, animation: "slideIn 0.3s ease" },
  feedTime: { color: "#3A4A73", fontSize: 9.5, flexShrink: 0 },

  // ── Misc ──
  claimBtn: {
    fontFamily: "'Baloo 2', sans-serif", fontSize: 12, fontWeight: 700,
    padding: "14px 20px", borderRadius: 999,
    border: "none",
    background: "linear-gradient(180deg,#5FA6FF,#2E7BFF)",
    color: "#071230", cursor: "pointer", letterSpacing: 1,
    transition: "all 0.2s", textAlign: "center", width: "100%",
    boxShadow: "0 6px 18px rgba(62,139,255,0.3)",
  },
  footer: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 16px", borderTop: "1px solid rgba(148,178,255,0.08)", background: "rgba(6,11,28,0.95)", zIndex: 10, position: "relative", gap: 8, flexWrap: "nowrap", flexShrink: 0 },
  gridOnline: { fontSize: 11, fontWeight: 700, color: "#3E8BFF", letterSpacing: 2, animation: "scanGlow 3s ease-in-out infinite", fontFamily: "'JetBrains Mono', monospace" },

  // ── Panel dock + drawer (live feed / round history / your history) ──
  dock: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0, minWidth: 0 },
  dockBtn: {
    display: "inline-flex", alignItems: "center", gap: 5,
    fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, fontWeight: 700,
    letterSpacing: 1.2, color: "#8FA3C9", cursor: "pointer",
    background: "rgba(148,178,255,0.06)", border: "1px solid rgba(148,178,255,0.12)",
    borderRadius: 999, padding: "6px 12px", whiteSpace: "nowrap",
  },
  dockBtnOn: {
    color: "#EAF1FF", background: "rgba(62,139,255,0.18)",
    border: "1px solid rgba(62,139,255,0.5)",
  },
  dockLiveDot: {
    width: 5, height: 5, borderRadius: "50%", background: "#3E8BFF",
    boxShadow: "0 0 6px rgba(62,139,255,0.9)", animation: "pulse 1.6s ease-in-out infinite",
  },
  drawerScrim: {
    position: "fixed", inset: 0, zIndex: 190,
    background: "rgba(6,11,28,0.62)", backdropFilter: "blur(2px)",
  },
  drawer: {
    // centered with auto margins, not a transform — the entry animation would
    // otherwise clobber translateX and throw the panel off-screen
    position: "fixed", zIndex: 200, left: 0, right: 0, bottom: 12,
    margin: "0 auto",
    width: "min(760px, calc(100vw - 28px))",
    maxHeight: "min(72dvh, 560px)",
    display: "flex", flexDirection: "column",
    background: "#0A1228", border: "1px solid rgba(148,178,255,0.16)",
    borderRadius: 20, overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0,0,0,0.65)",
  },
  drawerHead: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    padding: "9px 10px 9px 10px", borderBottom: "1px solid rgba(148,178,255,0.1)",
    background: "rgba(148,178,255,0.04)", flexShrink: 0,
  },
  drawerTabs: { display: "flex", alignItems: "center", gap: 5, minWidth: 0, overflowX: "auto" },
  drawerTab: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, fontWeight: 700,
    letterSpacing: 1.2, color: "#8FA3C9", cursor: "pointer", whiteSpace: "nowrap",
    background: "transparent", border: "1px solid rgba(148,178,255,0.12)",
    borderRadius: 999, padding: "6px 12px",
  },
  drawerTabOn: {
    color: "#EAF1FF", background: "rgba(62,139,255,0.18)",
    border: "1px solid rgba(62,139,255,0.5)",
  },
  drawerClose: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#8FA3C9",
    cursor: "pointer", background: "none", border: "1px solid rgba(148,178,255,0.12)",
    borderRadius: 999, padding: "4px 11px", flexShrink: 0,
  },
  drawerBody: { padding: 12, overflowY: "auto", minHeight: 0 },
  drawerEmpty: {
    padding: "26px 16px", textAlign: "center", color: "#55688F",
    fontSize: 10.5, letterSpacing: 1.5, fontFamily: "'JetBrains Mono', monospace",
  },
  histEmpty: {
    flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 2, padding: "18px 18px 22px",
  },
  histEmptyMark: {
    fontSize: 20, color: "#2B3A63", lineHeight: 1,
    opacity: 0.9, filter: "grayscale(0.4)",
  },
  histEmptySub: {
    fontSize: 9.5, color: "#3A4A73", lineHeight: 1.5, textAlign: "center",
    fontFamily: "'Inter', sans-serif", letterSpacing: 0, maxWidth: 230,
  },
  dropdownItem: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "12px 14px", fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, color: "#C4D3F2", cursor: "pointer",
    border: "none", background: "none", width: "100%",
    textAlign: "left", letterSpacing: 0.5,
    WebkitTapHighlightColor: "transparent",
  },
  dropdownIcon: { fontSize: 14, width: 20, textAlign: "center" },
  dropdownDivider: { height: 1, background: "rgba(148,178,255,0.08)" },
  dropdownInput: {
    width: "100%", padding: "10px 12px", fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    background: "rgba(0,0,0,0.4)", border: "1px solid rgba(148,178,255,0.15)",
    borderRadius: 10, color: "#C4D3F2", outline: "none", letterSpacing: 0.3,
  },
};
