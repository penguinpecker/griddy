# Griddy

**A provably fair grid game on Arc.**
Stake USDC on a 5×5 grid. A distributed randomness beacon picks the winning
cell. Winners split the pot in proportion to what they staked.

**[▶ Play](https://griddy-two.vercel.app)** · [drand](https://drand.love)

Griddy runs on Arc — Circle's chain, where the **native gas token is USDC** —
so the game stakes it directly via `msg.value`, with no token approvals. (Arc
quirk: the native balance is 18-decimal; a 6-decimal ERC-20 view exists at
`0x3600000000000000000000000000000000000000` sharing the same balance, but
Griddy only ever touches the native side.)

---

## How it works

Rounds are **continuous**: the moment one 60-second betting window closes,
the next round is open — the first stake starts its clock. You stake any
amount of USDC — from $0.0001 upward — on any cells you like. When a round
closes, one cell wins, everyone on it splits the pot, and the reveal lands
on-chain **~4 seconds later** while betting carries on in the next round.
Rounds nobody entered simply expire; they never cost anyone a transaction.

Two rules define the whole game:

1. **A cell wins with probability equal to its share of the pot.** Put in a
   quarter of the round's USDC and you have a one-in-four chance.
2. **The prize splits by stake.** Hold 25% of the winning cell, take 25% of
   the prize.

Together these mean every wei has the same expected value wherever you put
it — there is no cell that is secretly a better bet, and no way to seed dust
across the board to shade someone else's odds. The house takes 10%, and the
tip that pays whoever submits the randomness comes out of that fee — never
out of the prize.

```
prize    = pot − 10% fee         (the resolver tip is paid from the fee)
your cut = prize × (your stake on the winning cell ÷ that cell's total)
```

Winners are paid **automatically** in the resolution transaction. There is no
claim step and no reward token — the pot is the whole game.

## Why the randomness can't be gamed

Griddy uses [**drand**](https://drand.love) — a randomness beacon produced
every 3 seconds by the League of Entropy, a distributed group of independent
operators. No single participant can predict or withhold a beacon.

The important part is the timing. When a round opens, the contract writes down
the *number* of a beacon that **does not exist yet** and is published only
a few seconds after betting closes. So while you're placing
stakes, the answer is not merely secret — it hasn't been created.

When that beacon appears, **anyone** can submit it. The contract verifies its
BLS signature itself, on-chain, against drand's public key. Each beacon round
has exactly one valid signature, so whoever submits it has no influence
whatsoever: they cannot grind alternatives, cannot choose a favourable one,
and cannot censor it, because anybody else can submit the identical bytes and
collect the tip.

## Deployment

Live on **Arc mainnet** (chainId 5042 · RPC `https://5042.rpc.thirdweb.com`).
Arc mainnet is still pre-launch, so it has no public block explorer yet —
verify state directly over RPC, or with `scripts/verify-payouts.ts`.

| Contract | Address |
| --- | --- |
| GriddyV5 (UUPS proxy) | `0xfa29a5a324149a60086B3aeD20cBF42Bd761d5A1` |
| GriddyV5 implementation | `0x04E0867F6c9aFe9efD99DBD0E9C521E5Bf5Db62c` |
| DrandBeaconV2 (UUPS proxy) | `0xC5c53BB4A93bCe76b99c726FFA1173Be31f14d8d` |

Also on **Arc Testnet** (chainId 5042002 · explorer
[arcscan](https://testnet.arcscan.app)): game proxy
`0x04E0867F6c9aFe9efD99DBD0E9C521E5Bf5Db62c`, beacon proxy
`0x93C3B6362D82a9f6495517F0E6Ffa63594596453`.

Every contract deploys behind an upgradeable proxy. Full record in
`contracts/deployments/griddy-arc-mainnet.json`. Arc's precompiles were
probe-verified against a real drand beacon before deploy
(`contracts/scripts/probe-arc-precompiles.ts`); complete rounds — uneven
stakes, on-chain BLS verification, exact 90% pro-rata auto-payout — are
played end-to-end with `contracts/scripts/smoke-arc.ts`, and
`contracts/scripts/verify-payouts.ts` audits live rounds from chain data
alone (pot == sum of stake events, prize == 90% exactly, pro-rata payouts,
contract balance covers every liability to the wei).

## Parameters

| | Value | |
|:---|:---|:---|
| Round length | 60 s | windows sit on a fixed time grid, so the clock runs with zero players; owner-tunable, 10 s – 1 h |
| Beacon gap | 4 s | delay before the pinned beacon exists; floor 3 s |
| Reveal latency | ~4 s measured | round end → resolved on-chain (`scripts/measure-resolution.ts`) |
| Minimum stake | $0.0001 | per *new* position; top-ups can be any size |
| Maximum stake | none | capital buys share, not better odds |
| Protocol fee | 10% | capped at 20% |
| Resolver tip | $0.00003 | paid from the fee; capped at $0.001 |
| Stakers per cell | 100 | bounds the auto-pay loop; top-ups are free |

## Safety

The contract has been through adversarial review passes. Highlights of
what's in place:

- **Solvency is an invariant.** Contract balance always covers every pending
  round's stakes (tracked across concurrent rounds by
  `totalUnresolvedStakes`), outstanding refunds, escrowed winnings and
  unclaimed fees. Rounding dust is banked into fees so no wei is ever
  untracked — auditable any time with `scripts/verify-payouts.ts`.
- **The owner cannot touch player money.** `sweepSurplus` can only remove
  funds owed to nobody. `renounceOwnership` is disabled, since one accidental
  call would strand fees and destroy every recovery path.
- **Payment can't be blocked.** Winner transfers are gas-capped; a contract
  that rejects the transfer gets its winnings escrowed and can pull them
  later, so one hostile receiver can't stall resolution.
- **Liveness has two backstops.** If drand misses a beacon, the owner may
  re-pin the round to a later one after 6 hours — deliberately owner-gated,
  because a permissionless re-pin would let a loser re-roll a published
  result. If the beacon never arrives, anyone can void the round after 30
  days (plus a 3-day grace) and every player reclaims exactly what they
  staked.

## Repository layout

```
contracts/
  src/
    GriddyV2.sol → GriddyV5.sol   the game (UUPS-upgradeable; V5 is current:
                                  continuous rounds, decoupled resolution)
    drand/DrandBeaconV2.sol       on-chain BLS verification (UUPS proxy)
    drand/BLS.sol                 BN254 pairing helpers (kevincharm/bls-bn254, MIT)
  test/                           adversarial suites using real drand signatures
  scripts/                        deploy, upgrade, audit and smoke-test scripts
services/keeper/                  fetches beacons, resolves rounds, serves the live feed
app/                              Next.js frontend
```

## Running it

**Tests** — these verify real drand beacon signatures on a local EVM, so they
prove the cryptography, not a mock:

```bash
cd contracts && npm install && npx hardhat test
```

**Deploy** (runs post-deploy assertions and fails loudly rather than leave a
half-wired game). `arc-mainnet` is chainId 5042; use `arc-testnet` for 5042002:

```bash
PRIVATE_KEY=0x… npx hardhat run scripts/deploy-griddy-arc.ts --network arc-mainnet
```

**Keeper** — resolves rounds and serves the live event feed. It holds no
special power: resolution is permissionless, so anyone can run one, and the
tip makes it self-funding.

```bash
cd services/keeper && npm install
PRIVATE_KEY=0x… GRIDDY_ADDRESS=0xfa29a5a324149a60086B3aeD20cBF42Bd761d5A1 CHAIN_ID=5042 \
  RPC_URL=https://arc-mainnet.g.alchemy.com/v2/<your-key> npm start
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
