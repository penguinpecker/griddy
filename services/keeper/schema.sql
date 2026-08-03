-- Griddy (Robinhood Chain 4663) history mirror.
-- Supabase schema for the optional round-history mirror.
-- Separate from the legacy gz_* tables (old Base/USDC game).
-- All amounts are wei strings (18 dec); the frontend divides by 1e18.

create table if not exists griddy_rounds (
  round_id           bigint primary key,
  winning_cell       smallint,
  total_staked_wei   text not null default '0',
  total_stakers      integer not null default 0,
  winner_total_wei   text,
  distributable_wei  text,
  drand_round        bigint,
  resolve_tx_hash    text,
  resolved_at        timestamptz default now()
);

create table if not exists griddy_stakes (
  round_id       bigint not null,
  player_address text   not null,
  cell           smallint not null,
  amount_wei     text   not null default '0',   -- player's running total on this cell
  is_winner      boolean not null default false,
  payout_wei     text,                          -- exact on-chain pro-rata payout
  pick_tx_hash   text,
  created_at     timestamptz default now(),
  primary key (round_id, player_address, cell)
);

-- Public profile card for a wallet: the grid draws each staker's avatar on the
-- square they entered, and Privy only ever exposes profile data for the user
-- who is signed in. So every player publishes their OWN row once per login
-- (app/src/app/api/profile/route.js, service key, identity taken from the
-- verified Privy token — never from the request body) and the board reads the
-- avatars back through /api/db, which asks only for the addresses currently on
-- the board rather than handing out the whole map.
create table if not exists griddy_players (
  address          text primary key,             -- lowercase 0x address
  twitter_username text,
  pfp_url          text,
  updated_at       timestamptz not null default now()
);

create index if not exists griddy_stakes_player_idx on griddy_stakes (player_address, round_id desc);
create index if not exists griddy_rounds_resolved_idx on griddy_rounds (round_id desc);

alter table griddy_rounds enable row level security;
alter table griddy_stakes enable row level security;
alter table griddy_players enable row level security;

-- NO public read. Nothing in the browser holds a database key any more: the
-- board reads both tables through app/src/app/api/db/route.js, server side,
-- with the service role. RLS is left ON with zero SELECT policies, which
-- denies every non-service role, and the table-level grant is revoked too so
-- a policy added by accident later still cannot expose these.
--
-- This is deliberate, not leftover tightening. A Supabase publishable key is
-- meant to be handed to browsers, so it is NOT a secret and cannot be the
-- control — the row rules are. griddy_rounds and griddy_stakes only mirror
-- what is already public on chain, but griddy_players maps a wallet to an X
-- handle, which is NOT on chain: with a public read policy anyone holding the
-- publishable key (shared across every app in this project) could dump the
-- whole wallet -> handle list in one request. The API route only ever answers
-- for explicitly named addresses, capped at 60, so it cannot be enumerated.
drop policy if exists "griddy_rounds public read" on griddy_rounds;
drop policy if exists "griddy_stakes public read" on griddy_stakes;
drop policy if exists "griddy_players public read" on griddy_players;
revoke select on griddy_rounds  from anon, authenticated;
revoke select on griddy_stakes  from anon, authenticated;
revoke select on griddy_players from anon, authenticated;
