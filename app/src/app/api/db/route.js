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

  return NextResponse.json({ error: "unknown t" }, { status: 400 });
}
