// Single source of truth for chain + contract config.
// Defaults = Arc testnet (Circle); override via NEXT_PUBLIC_* env to point at
// another chain.
import { defineChain } from "viem";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 5042002);

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.testnet.arc.network";

export const EXPLORER =
  process.env.NEXT_PUBLIC_EXPLORER || "https://testnet.arcscan.app";

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
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Arc Explorer", url: EXPLORER } },
});
