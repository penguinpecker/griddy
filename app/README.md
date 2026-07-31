# Griddy — frontend

Next.js app for Griddy, the drand-powered 5×5 grid game on **Arc Testnet** (5042002).

- `/` — landing page
- `/play` — the game (`src/components/TheGrid.js`): viem reads against Arc Testnet, Privy wallets, SSE live feed from the keeper, Supabase round history
- `/how-to-play` — rules

Setup: copy `.env.example` → `.env.local` and fill in the Privy app id and the Griddy contract address from your own deployment (see `contracts/`). Stakes are native USDC — Arc's gas token — from $0.0001 per new position. Randomness links in the history table point at the drand evmnet API.

```bash
npm install
npm run dev
```
