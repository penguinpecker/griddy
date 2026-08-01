import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "dotenv/config";

// No fallback key: an unset/!malformed key yields NO signer, so a tx fails
// loudly instead of being signed by a well-known throwaway.
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const acct = (v?: string) => (v && KEY_RE.test(v) ? [v] : []);
const TESTNET_KEY = process.env.PRIVATE_KEY;
// Mainnet uses MAINNET_PRIVATE_KEY when set, else the same key as testnet
const MAINNET_KEY = process.env.MAINNET_PRIVATE_KEY || process.env.PRIVATE_KEY;
const ROBINHOOD_RPC = process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com";
const ROBINHOOD_TESTNET_RPC = process.env.ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com";
const ARC_TESTNET_RPC = process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";
// Arc mainnet (chainId 5042). The public "alch-demo" key is rate-limited and
// shared — set ARC_MAINNET_RPC to your own endpoint before any real deploy.
const ARC_MAINNET_RPC = process.env.ARC_MAINNET_RPC || "https://arc-mainnet.g.alchemy.com/v2/alch-demo";

const config: HardhatUserConfig = {
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  solidity: {
    version: "0.8.28",
    settings: {
      viaIR: true,
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    robinhood: {
      url: ROBINHOOD_RPC,
      accounts: acct(MAINNET_KEY),
      chainId: 4663,
    },
    "robinhood-testnet": {
      url: ROBINHOOD_TESTNET_RPC,
      accounts: acct(TESTNET_KEY),
      chainId: 46630,
    },
    // Arc testnet (Circle) — native gas token is USDC (18-dec native repr.)
    "arc-testnet": {
      url: ARC_TESTNET_RPC,
      accounts: acct(TESTNET_KEY),
      chainId: 5042002,
    },
    // Arc MAINNET — real money. Uses MAINNET_PRIVATE_KEY when set.
    "arc-mainnet": {
      url: ARC_MAINNET_RPC,
      accounts: acct(MAINNET_KEY),
      chainId: 5042,
    },
    hardhat: {
      chainId: 31337,
      // Just after drand evmnet genesis (2024-09-28T10:57:55Z) so tests can
      // warp forward onto real historical beacon rounds.
      initialDate: "2024-09-28T12:00:00Z",
      accounts: { count: 120 },
    },
  },
  sourcify: {
    enabled: true,
    apiUrl: "https://sourcify.dev/server",
    browserUrl: "https://repo.sourcify.dev",
  },
  etherscan: {
    apiKey: {
      robinhood: process.env.EXPLORER_API_KEY || "blockscout",
      "robinhood-testnet": process.env.EXPLORER_API_KEY || "blockscout",
    },
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
      {
        network: "robinhood-testnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com",
        },
      },
    ],
  },
};

export default config;
