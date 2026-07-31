# Griddy

**A provably fair grid game on Arc Testnet.**
Stake USDC on a 5×5 grid. A distributed randomness beacon picks the winning
cell. Winners split the pot in proportion to what they staked.

Griddy runs on Arc — Circle's chain, where the **native gas token is USDC** —
so the game stakes it directly via `msg.value`, with no token approvals. (Arc
quirk: the native balance is 18-decimal; a 6-decimal ERC-20 view exists at
`0x3600000000000000000000000000000000000000` sharing the same balance, but
Griddy only ever touches the native side.)

---

## How it works

Every **30 seconds** a round opens. You stake any amount of USDC — from
$0.0001 upward — on any cells you like. When the round closes, one cell wins
and everyone on it splits the pot.

Two rules define the whole game:

1. **A cell wins with probability equal to its share of the pot.** Put in a
   quarter of the round's USDC and you have a one-in-four chance.
2. **The prize splits by stake.** Hold 25% of the winning cell, take 25% of
   the prize.

Together these mean every wei has the same expected value wherever you put
it — there is no cell that is secretly a better bet, and no way to seed dust
across the board to shade someone else's odds. The house takes 5%, and the
tip that pays whoever submits the randomness comes out of that fee — never
out of the prize.

```
prize    = pot − 5% fee          (the resolver tip is paid from the fee)
your cut = prize × (your stake on the winning cell ÷ that cell's total)
```

Winners are paid **automatically** in the resolution transaction. There is no
claim step and no reward token — the pot is the whole game.

## Why the randomness can't be gamed

Griddy uses [**drand**](https://drand.love) — a randomness beacon produced
every 3 seconds by the League of Entropy, a distributed group of independent
operators. No single participant can predict or withhold a beacon.

The important part is the timing. When a round opens, the contract writes down
the *number* of a beacon that **does not exist yet** and will only be
published about 10 seconds after betting closes. So while you're placing
stakes, the answer is not merely secret — it hasn't been created.

When that beacon appears, **anyone** can submit it. The contract verifies its
BLS signature itself, on-chain, against drand's public key. Each beacon round
has exactly one valid signature, so whoever submits it has no influence
whatsoever: they cannot grind alternatives, cannot choose a favourable one,
and cannot censor it, because anybody else can submit the identical bytes and
collect the tip.

## Deployment

Live on **Arc Testnet** (chainId 5042002 · RPC `https://rpc.testnet.arc.network`):

| Contract | Address |
| --- | --- |
| GriddyV4 (UUPS proxy) | [`0x04E0867F6c9aFe9efD99DBD0E9C521E5Bf5Db62c`](https://explorer.testnet.arc.network/address/0x04E0867F6c9aFe9efD99DBD0E9C521E5Bf5Db62c) |
| GriddyV4 implementation | `0xC5c53BB4A93bCe76b99c726FFA1173Be31f14d8d` |
| DrandBeacon | [`0x73d7D306F5AE49a60c70C8Cf0331F1DA65E6cD2A`](https://explorer.testnet.arc.network/address/0x73d7D306F5AE49a60c70C8Cf0331F1DA65E6cD2A) |

Full record in `contracts/deployments/griddy-arc-testnet.json`. Arc's
precompiles were probe-verified against a real drand beacon before deploy
(`contracts/scripts/probe-arc-precompiles.ts`), and a complete round —
uneven stakes, on-chain BLS verification, exact 95% pro-rata auto-payout —
was played end-to-end with `contracts/scripts/smoke-arc.ts`.

## Parameters

| | Value | |
|:---|:---|:---|
| Round length | 30 s | owner-tunable, 10 s – 1 h |
| Beacon gap | 10 s | safety margin before the beacon exists; floor 8 s |
| Minimum stake | $0.0001 | per *new* position; top-ups can be any size |
| Maximum stake | none | capital buys share, not better odds |
| Protocol fee | 5% | capped at 20% |
| Resolver tip | $0.00003 | paid from the fee; capped at $0.001 |
| Stakers per cell | 100 | bounds the auto-pay loop; top-ups are free |

## Safety

The contract has been through adversarial review passes. Highlights of
what's in place:

- **Solvency is an invariant.** Contract balance always covers the live
  round's stakes, outstanding refunds, escrowed winnings and unclaimed fees.
  Rounding dust is banked into fees so no wei is ever untracked.
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
    GriddyV2.sol → GriddyV4.sol   the game (UUPS-upgradeable; V4 is current)
    drand/DrandBeacon.sol         on-chain BLS verification of drand beacons
    drand/BLS.sol                 BN254 pairing helpers (kevincharm/bls-bn254, MIT)
  test/                           tests using real drand signatures as fixtures
  scripts/                        deploy, upgrade, verification and smoke-test scripts
services/keeper/                  fetches beacons, resolves rounds, serves the live feed
app/                              Next.js frontend
```

## Running it

**Tests** — these verify real drand beacon signatures on a local EVM, so they
prove the cryptography, not a mock:

```bash
cd contracts && npm install && npx hardhat test
```

**Deploy** (Arc testnet; a mainnet target requires an explicit confirmation
flag and runs post-deploy assertions before it will report success):

```bash
PRIVATE_KEY=0x… npx hardhat run scripts/deploy-griddy-v2.ts --network arc-testnet
```

**Keeper** — resolves rounds and serves the live event feed. It holds no
special power: resolution is permissionless, so anyone can run one, and the
tip makes it self-funding.

```bash
cd services/keeper && npm install
PRIVATE_KEY=0x… GRIDDY_ADDRESS=0x… CHAIN_ID=5042002 \
  RPC_URL=https://rpc.testnet.arc.network npm start
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
