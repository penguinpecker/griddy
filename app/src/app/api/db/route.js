import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only mirror of the two public tables the board needs.
 *
 * This exists because the client cannot be relied on to hold a Supabase key.
 * Vercel returns "[SENSITIVE]" for every NEXT_PUBLIC_* variable on `env pull`,
 * so a locally-prebuilt bundle can silently inline an EMPTY anon key — which is
 * exactly what shipped: the round history fell through to walking the chain in
 * 9k-block chunks (~45 sequential RPC round-trips, ~60s) and player avatars
 * never loaded at all. Reading here with the server-side service key removes
 * the whole class of failure: nothing secret reaches the browser, and there is
 * no public key left to go missing.
 *
 * Both queries are fixed server-side — the table, the columns and the row cap
 * are not caller-controlled, so this cannot be turned into an arbitrary query.
 * Only columns that are already public on the chain or self-published by the
 * player are selected.
 */
const URL_ = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const KEY = process.env.SUPABASE_SERVICE_KEY || "";

// 0X as well as 0x: callers may pass EIP-55 checksummed or upper-cased
// addresses, and silently dropping those looks like "this player has no
// profile" rather than a bug. Values are lower-cased before they reach the
// query, so the stored lower-case column still matches.
const ADDR = /^0[xX][0-9a-fA-F]{40}$/;

async function sb(path) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) ? rows : null;
}

export async function GET(req) {
  if (!URL_ || !KEY) {
    return NextResponse.json({ error: "db not configured" }, { status: 503 });
  }
  const t = req.nextUrl.searchParams.get("t");

  if (t === "rounds") {
    const rows = await sb(
      "griddy_rounds?select=round_id,winning_cell,total_staked_wei,total_stakers,drand_round,resolve_tx_hash&order=round_id.desc&limit=100"
    );
    if (!rows) return NextResponse.json({ error: "upstream" }, { status: 502 });
    return NextResponse.json(
      { rounds: rows },
      // a resolved round never changes, so a few seconds of edge cache costs
      // nothing and absorbs a burst of players opening the board at once
      { headers: { "cache-control": "public, s-maxage=5, stale-while-revalidate=30" } }
    );
  }

  if (t === "players") {
    const raw = (req.nextUrl.searchParams.get("addrs") || "").split(",");
    const addrs = raw.filter((a) => ADDR.test(a)).slice(0, 60).map((a) => a.toLowerCase());
    if (addrs.length === 0) return NextResponse.json({ players: [] });
    const rows = await sb(
      `griddy_players?select=address,twitter_username,pfp_url&address=in.(${addrs.join(",")})`
    );
    if (!rows) return NextResponse.json({ error: "upstream" }, { status: 502 });
    return NextResponse.json(
      { players: rows },
      { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } }
    );
  }

  if (t === "leaderboard") {
    // ── XP: recomputed from the on-chain mirror on every request ──
    // Nothing is stored, so the ledger cannot drift from the chain and there
    // is no XP table to tamper with: replaying the same stakes always yields
    // the same scores. Rules (documented on /leaderboard too):
    //   ENTER    +25 XP  per round entered — showing up
    //   VOLUME  +100 XP  per $1 staked — farming this costs the 10% fee,
    //                    which is what keeps "XP for volume" honest
    //   OUTCOME +150 XP  per $1 actually paid out
    //   WIN     +100 XP  flat per round won — keeps min-stake wins visible
    //   STREAK   +50 XP  per consecutive win after the first, capped at +250
    const [stakes, players] = await Promise.all([
      sb("griddy_stakes?select=round_id,player_address,amount_wei,is_winner,payout_wei&order=round_id.asc&limit=10000"),
      sb("griddy_players?select=address,twitter_username,pfp_url"),
    ]);
    if (!stakes || !players) return NextResponse.json({ error: "upstream" }, { status: 502 });

    // The treasury/keeper wallet's smoke-test rounds are ours, not a player's.
    const HOUSE = new Set(["0x52c59bc217fd0c0b2157f1b2da1a12635e19da4c"]);
    const profile = new Map(players.map((p) => [String(p.address).toLowerCase(), p]));

    const agg = new Map();
    for (const s of stakes) {
      const a = String(s.player_address).toLowerCase();
      if (HOUSE.has(a)) continue;
      let p = agg.get(a);
      if (!p) { p = { rounds: new Map(), stakedWei: 0n, wonWei: 0n }; agg.set(a, p); }
      p.stakedWei += BigInt(s.amount_wei || "0");
      if (s.payout_wei) p.wonWei += BigInt(s.payout_wei);
      const r = p.rounds.get(s.round_id) || { won: false };
      if (s.is_winner) r.won = true;
      p.rounds.set(s.round_id, r);
    }

    const usd = (wei) => Number(wei) / 1e18;
    const rows = [];
    for (const [a, p] of agg) {
      const entered = [...p.rounds.keys()].sort((x, y) => x - y);
      let wins = 0, streak = 0, best = 0, streakXp = 0;
      for (const id of entered) {
        if (p.rounds.get(id).won) {
          wins++; streak++;
          if (streak > best) best = streak;
          if (streak > 1) streakXp += Math.min(50 * (streak - 1), 250);
        } else streak = 0;
      }
      const enterXp = 25 * entered.length;
      const volumeXp = Math.floor(100 * usd(p.stakedWei));
      const outcomeXp = Math.floor(150 * usd(p.wonWei));
      const winXp = 100 * wins;
      const prof = profile.get(a) || {};
      rows.push({
        address: a,
        twitter_username: prof.twitter_username || null,
        pfp_url: prof.pfp_url || null,
        xp: enterXp + volumeXp + outcomeXp + winXp + streakXp,
        breakdown: { enter: enterXp, volume: volumeXp, outcome: outcomeXp, win: winXp, streak: streakXp },
        rounds: entered.length,
        wins,
        best_streak: best,
        staked_usd: +usd(p.stakedWei).toFixed(4),
        won_usd: +usd(p.wonWei).toFixed(4),
      });
    }
    rows.sort((a, b) => b.xp - a.xp);
    return NextResponse.json(
      { leaderboard: rows.slice(0, 100), generated_at: new Date().toISOString() },
      { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } }
    );
  }

  return NextResponse.json({ error: "unknown t" }, { status: 400 });
}
