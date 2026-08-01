// Single source of truth for chain + contract config.
// Defaults = Arc MAINNET (Circle, chainId 5042); override via NEXT_PUBLIC_*
// env to point at testnet (5042002 / rpc.testnet.arc.network /
// testnet.arcscan.app).
import { defineChain } from "viem";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 5042);

// Default to our own same-origin proxy (app/api/rpc): Arc's upstream RPC
// sends no CORS headers, so the browser cannot call it directly. A relative
// path is resolved against the current origin in the browser and against
// localhost during prerender.
const RAW_RPC = process.env.NEXT_PUBLIC_RPC_URL || "/api/rpc";
export const RPC_URL =
  RAW_RPC.startsWith("/") && typeof window !== "undefined"
    ? window.location.origin + RAW_RPC
    : RAW_RPC.startsWith("/")
      ? "http://localhost:3000" + RAW_RPC
      : RAW_RPC;

// Arc mainnet has no public block explorer yet (the network is still in its
// private pre-launch phase). Empty = the UI renders tx hashes as plain text.
export const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER || "";

export const GRID_ADDR =
  process.env.NEXT_PUBLIC_GRIDDY_ADDR || "0x0000000000000000000000000000000000000000";

export const ALCHEMY_RPC = process.env.NEXT_PUBLIC_ALCHEMY_RPC || "";
export const GAS_SPONSOR = process.env.NEXT_PUBLIC_GAS_SPONSOR === "true";
export const SSE_URL = process.env.NEXT_PUBLIC_SSE_URL || "";
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
export const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON || "";

export const DRAND_CHAIN_HASH =
  "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";

// Arc's native gas token IS USDC: the chain-native balance (18 decimals) and
// the 6-decimal ERC-20 view at 0x3600...0000 share the same underlying funds.
// The game stakes the native token, so all on-chain amounts are 18-decimal USDC.
export const gameChain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 5042002 ? "Arc Testnet" : "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  ...(EXPLORER
    ? { blockExplorers: { default: { name: "Arc Explorer", url: EXPLORER } } }
    : {}),
});
