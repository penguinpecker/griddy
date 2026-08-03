# Griddy

**A provably fair grid game on Arc.**
Stake USDC on a 5×5 grid. A distributed randomness beacon — verified on-chain —
draws the winning cell. Winners split the pot in proportion to what they staked.

**[▶ Play](https://griddy-two.vercel.app)** ·
[Leaderboard](https://griddy-two.vercel.app/leaderboard) ·
[How to play](https://griddy-two.vercel.app/how-to-play) ·
[drand](https://drand.love)

---

## Contents

- [The game](#the-game)
- [Why the randomness can't be gamed](#why-the-randomness-cant-be-gamed)
- [Round lifecycle](#round-lifecycle)
- [XP & leaderboard](#xp--leaderboard)
- [Deployment](#deployment)
- [Parameters](#parameters)
- [Safety](#safety)
- [Architecture](#architecture)
- [Running it](#running-it)

---

## The game

Griddy runs on **Arc** — Circle's chain, where the native gas token is USDC —
so stakes are plain `msg.value`, with no token approvals. (Arc quirk: the
native balance is 18-decimal; a 6-decimal ERC-20 view exists at
`0x3600…0000` sharing the same balance, but Griddy only touches the native side.)

You stake any amount of USDC — from $0.10 per new position — on any cells you
like, and so can everyone else, including on the same cells. When the round
closes, one cell is drawn and everyone on it splits the prize.

Two rules define the whole game:

1. **A cell wins with probability equal to its share of the pot.** Put in a
   quarter of the round's USDC and you have a one-in-four chance.
2. **The prize splits by stake.** Hold 25% of the winning cell, take 25% of
   the prize.

Together these mean every dollar has the same expected value wherever it
sits — no cell is secretly a better bet, and seeding dust across the board
cannot shade anyone else's odds.

```
prize    = pot − 10% fee         (the resolver tip is paid FROM the fee)
your cut = prize × (your stake on the winning cell ÷ that cell's total)
```

Winners are paid **automatically in the resolution transaction**. No claim
step, no reward token — the pot is the whole game.

## Why the randomness can't be gamed

Griddy uses [**drand**](https://drand.love) — a randomness beacon produced
every 3 seconds by the League of Entropy, a distributed group of independent
operators. No single participant can predict or withhold a beacon.

The important part is the timing. When a round opens, the contract pins the
*number* of a beacon that **does not exist yet** — one published only after
betting closes. While you're staking, the answer hasn't been created.

When that beacon appears, **anyone** may submit it. The contract verifies its
BLS signature itself, on-chain, against drand's public key. Each beacon round
has exactly one valid signature, so the submitter has no influence: they
cannot grind alternatives, cannot pick a favourable one, and cannot censor
it, because anyone else can submit the identical bytes and take the tip.

## Round lifecycle

- **Resolution starts the next round.** The moment a round's winner is drawn
  and paid, the next round opens *in that same transaction* — a full 60
  seconds begins right as the result is shown.
- **The time grid is the fallback.** Rounds are also anchored to a fixed
  clock grid, so if nothing resolves — an empty round, or a resolver that's
  slow or gone — the next stake simply opens a round on the grid. No single
  actor can halt the game by declining to resolve.
- **Empty rounds are free.** A round nobody entered writes nothing on-chain,
  needs no transaction, and just rolls over.
- **Reveal latency is ~4 s measured** from round close to resolved-and-paid
  on-chain.

## XP & leaderboard

Every wallet earns XP, recomputed **live from on-chain stakes and payouts**
on every request — nothing is stored, so the standings can never drift from
the chain and there is no score table to tamper with.

| Action | XP |
|:--|:--|
| Enter a round | +25 |
| Volume | +100 per $1 staked |
| Outcome | +150 per $1 won |
| Win a round | +100 |
| Win streak | +50 per consecutive win after the first (max +250 per round) |

Volume XP is farm-resistant by construction: buying it costs the 10% fee.
The treasury/keeper wallet is excluded as house. Standings, with each
player's X profile, live at
[/leaderboard](https://griddy-two.vercel.app/leaderboard).

## Deployment

Live on **Arc mainnet** (chainId 5042). Arc mainnet is pre-launch and has no
public block explorer or public RPC — verify state directly over RPC with a
provider account, or with `contracts/scripts/verify-payouts.ts`.

| Contract | Address |
| --- | --- |
| Griddy (UUPS proxy) | `0xfa29a5a324149a60086B3aeD20cBF42Bd761d5A1` |
| GriddyV10 implementation | `0xfeE406b2F4b29Fa72e3a679b777B5bb100b2B59B` |
| DrandBeaconV2 (UUPS proxy) | `0xC5c53BB4A93bCe76b99c726FFA1173Be31f14d8d` |

Also on **Arc testnet** (chainId 5042002 ·
[arcscan](https://testnet.arcscan.app)): game proxy
`0x04E0867F6c9aFe9efD99DBD0E9C521E5Bf5Db62c`, beacon proxy
`0x93C3B6362D82a9f6495517F0E6Ffa63594596453`.

Every contract sits behind a UUPS proxy; addresses and upgrade history are
recorded in `contracts/deployments/`. Game parameters are owner-tunable, so
the chain is the authority on their current values — the table below matches
it as of this writing, and `scripts/verify-payouts.ts` always audits against
what's live. Arc's BN254 precompiles were probe-verified against
a real drand beacon before deploy (`scripts/probe-arc-precompiles.ts`);
complete rounds are played end-to-end by `scripts/smoke-arc.ts`; and
`scripts/verify-payouts.ts` audits live rounds from chain data alone —
pot == sum of stake events, prize == 90% exactly, pro-rata payouts, and a
contract balance that covers every liability to the wei.

## Parameters

| | Value | |
|:---|:---|:---|
| Round length | 60 s | owner-tunable 10 s – 1 h; the next round starts at resolution, grid fallback otherwise |
| Beacon gap | 4 s | delay before the pinned beacon exists; floor 3 s |
| Reveal latency | ~4 s measured | round close → resolved on-chain (`scripts/measure-resolution.ts`) |
| Minimum stake | $0.10 | per *new* position; top-ups can be any size |
| Maximum stake | none | capital buys share, not better odds |
| Protocol fee | 10% | capped at 20%; players always receive exactly the rest |
| Resolver tip | $0.00003 | paid from the fee; capped at $0.001 |
| Stakers per cell | 100 | bounds the auto-pay loop; top-ups are free |

## Safety

The contract has been through repeated adversarial review, including
multi-lens audits before each mainnet upgrade. What's in place:

- **Solvency is an invariant.** The contract balance always covers every
  pending round's stakes (tracked across concurrent rounds), outstanding
  refunds, escrowed winnings and unclaimed fees. Rounding dust is banked
  into fees so no wei is ever untracked — auditable any time with
  `scripts/verify-payouts.ts`.
- **The owner cannot touch player money.** `sweepSurplus` can only remove
  funds owed to nobody. `renounceOwnership` is disabled — one accidental
  call would strand fees and destroy every recovery path.
- **Payment can't be blocked.** Winner transfers are gas-capped; a receiver
  that rejects the transfer gets its winnings escrowed for pull-based
  withdrawal, so one hostile contract can't stall resolution. Opening the
  next round can likewise never revert a payout: if its beacon invariant
  can't be met it declines, and the grid fallback takes over.
- **The clock belongs to no one.** Round boundaries derive from resolution
  or the fixed grid — no player action starts, resets or extends a round.
- **Liveness has two backstops.** If drand misses a beacon, the owner may
  re-pin the round to a later one after 6 hours — deliberately owner-gated,
  because a permissionless re-pin would let a loser re-roll a published
  result. If the beacon never arrives, anyone can void the round after 30
  days (plus a 3-day grace) and every player reclaims exactly what they
  staked.

## Architecture

```
contracts/
  src/
    Griddy.sol → GriddyV10.sol    the game, one UUPS lineage (V10 current:
                                  resolution opens the next round; fixed
                                  time grid as fallback and deadline)
    drand/DrandBeaconV2.sol       on-chain BLS verification (UUPS proxy)
    drand/BLS.sol                 BN254 pairing helpers (kevincharm/bls-bn254, MIT)
  test/                           adversarial suites using real drand signatures
  scripts/                        deploy, upgrade, audit and smoke-test scripts
services/keeper/                  fetches beacons, resolves rounds, serves the
                                  live SSE feed, mirrors history to Postgres
app/                              Next.js frontend
  src/app/api/rpc                 same-origin JSON-RPC proxy (Arc sends no CORS)
  src/app/api/db                  server-side reads of the history mirror —
                                  the browser holds no database credential
  src/app/api/profile             publishes the caller's own X profile, identity
                                  taken from the verified Privy token only
  src/app/leaderboard             live XP standings
```

The browser never holds a database key and never talks to the chain
directly — both go through same-origin API routes. History reads are one
database query (chain replay remains the fallback and source of truth).

## Running it

**Tests** — these verify real drand beacon signatures on a local EVM, so they
prove the cryptography, not a mock:

```bash
cd contracts && npm install && npx hardhat test
```

**Deploy** (runs post-deploy assertions and fails loudly rather than leave a
half-wired game). `arc-mainnet` is chainId 5042; `arc-testnet` is 5042002:

```bash
PRIVATE_KEY=0x… npx hardhat run scripts/deploy-griddy-arc.ts --network arc-mainnet
```

**Keeper** — resolves rounds, serves the live feed, mirrors history. It holds
no special power: resolution is permissionless, so anyone can run one.

```bash
cd services/keeper && npm install
PRIVATE_KEY=0x… GRIDDY_ADDRESS=0xfa29a5a324149a60086B3aeD20cBF42Bd761d5A1 CHAIN_ID=5042 \
  RPC_URL=<your Arc RPC endpoint> npm start
```

**Frontend**:

```bash
cd app && npm install && cp .env.example .env.local   # then fill it in
npm run dev
```

---

<p align="center">
  <sub>Verifiable randomness, pro-rata payouts, and dollars you probably shouldn't be gambling.</sub>
</p>
