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
-- whole address -> avatar map back with the anon key.
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

-- Public read (site uses the publishable key); writes require the service
-- role, held only by the keeper. Verified: anon SELECT 200, anon INSERT 401.
drop policy if exists "griddy_rounds public read" on griddy_rounds;
create policy "griddy_rounds public read" on griddy_rounds for select using (true);
drop policy if exists "griddy_stakes public read" on griddy_stakes;
create policy "griddy_stakes public read" on griddy_stakes for select using (true);
-- Avatars are public by design; the route holds the only write credential.
drop policy if exists "griddy_players public read" on griddy_players;
create policy "griddy_players public read" on griddy_players for select using (true);
