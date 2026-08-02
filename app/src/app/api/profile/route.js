// Profile sync — the ONLY writer of griddy_players.
//
// The board draws every staker's avatar, but Privy hands the browser profile
// data for the SIGNED-IN user alone. So each player publishes their own row
// once per login and the grid reads the whole address -> avatar map back with
// the anon key (see schema.sql).
//
// SECURITY — identity comes from Privy's signed tokens, never from the caller:
//   * the request BODY is never read, so there is no address field to forge;
//   * the access token is verified against Privy's JWKS (ES256) before any
//     claim in it is believed — issuer, audience and expiry all checked;
//   * the wallet + Twitter profile are taken from the identity token (whose
//     signature is verified the same way, and whose subject must match the
//     access token's) or, failing that, from Privy's server API keyed by the
//     verified DID.
// A caller can therefore only ever write the row for the wallet Privy says is
// theirs. Anything unverified is a 401, never a write.
//
// Env (server-only — none of these may be NEXT_PUBLIC_):
//   SUPABASE_SERVICE_KEY  service-role key, the write credential (required)
//   SUPABASE_URL          falls back to NEXT_PUBLIC_SUPABASE_URL (not secret)
//   PRIVY_APP_SECRET      optional; only needed if the Privy app does not
//                         issue identity tokens
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
const PRIVY_ISSUER = "privy.io";
const JWKS_URL = `https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}/jwks.json`;
const JWKS_TTL_MS = 10 * 60 * 1000;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const b64u = (s) =>
  Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const b64uJson = (s) => JSON.parse(b64u(s).toString("utf8"));

let jwksCache = { at: 0, keys: null };
async function privyJwks() {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const r = await fetch(JWKS_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  const { keys } = await r.json();
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("empty jwks");
  jwksCache = { at: now, keys };
  return keys;
}

/**
 * Verify a Privy ES256 JWT with WebCrypto (no extra dependency) and return its
 * claims. Nothing but a good signature over the exact header.payload bytes,
 * from a key Privy publishes for THIS app, gets past here.
 */
async function verifyPrivyJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts;
  let header;
  try {
    header = b64uJson(h);
  } catch {
    throw new Error("malformed token");
  }
  if (header.alg !== "ES256") throw new Error("unexpected alg");
  const keys = await privyJwks();
  const jwk = keys.find((k) => k.kid === header.kid) || (header.kid ? null : keys[0]);
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64u(s),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!ok) throw new Error("bad signature");

  const claims = b64uJson(p);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== PRIVY_ISSUER) throw new Error("bad issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(PRIVY_APP_ID)) throw new Error("bad audience");
  if (!claims.exp || claims.exp <= now) throw new Error("expired");
  if (claims.nbf && claims.nbf > now + 60) throw new Error("not yet valid");
  if (!claims.sub) throw new Error("no subject");
  return claims;
}

// The game plays from the Privy embedded wallet — same pick as the client.
const pickWallet = (accounts) => {
  const wallets = accounts.filter(
    (a) =>
      a?.type === "wallet" &&
      ADDR_RE.test(a.address || "") &&
      (a.chain_type ?? a.chainType ?? "ethereum") === "ethereum"
  );
  const embedded = wallets.find(
    (w) =>
      (w.wallet_client_type ?? w.walletClientType ?? w.wallet_client ?? w.walletClient) ===
      "privy"
  );
  return (embedded || wallets[0])?.address || null;
};

const pickTwitter = (accounts) => {
  const t = accounts.find((a) => a?.type === "twitter_oauth") || null;
  if (!t) return { username: null, pfp: null };
  const pfp = t.profile_picture_url ?? t.profilePictureUrl ?? null;
  return {
    username: t.username ?? t.name ?? null,
    // same upgrade the client applies: _normal is a 48px thumbnail
    pfp: pfp ? String(pfp).replace("_normal", "_400x400") : null,
  };
};

/** Linked accounts straight out of the identity token, once verified. */
async function accountsFromIdentityToken(idToken, sub) {
  const claims = await verifyPrivyJwt(idToken);
  if (claims.sub !== sub) throw new Error("subject mismatch");
  let accounts = claims.linked_accounts;
  if (typeof accounts === "string") accounts = JSON.parse(accounts);
  if (!Array.isArray(accounts)) throw new Error("no linked accounts");
  return accounts;
}

/** Fallback when the app issues no identity token: ask Privy about the DID. */
async function accountsFromPrivyApi(did) {
  const secret = process.env.PRIVY_APP_SECRET || "";
  if (!secret) return null;
  const r = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(did)}`, {
    headers: {
      "privy-app-id": PRIVY_APP_ID,
      authorization: `Basic ${Buffer.from(`${PRIVY_APP_ID}:${secret}`).toString("base64")}`,
    },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`privy users api ${r.status}`);
  const u = await r.json();
  return Array.isArray(u.linked_accounts) ? u.linked_accounts : [];
}

export async function POST(request) {
  if (!PRIVY_APP_ID) return json(500, { error: "privy app id not configured" });

  // Authenticate first: an anonymous caller learns nothing about how the
  // deployment is configured.
  const auth = request.headers.get("authorization") || "";
  const accessToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!accessToken) return json(401, { error: "missing access token" });

  let claims;
  try {
    claims = await verifyPrivyJwt(accessToken);
  } catch (e) {
    return json(401, { error: `invalid access token: ${e.message}` });
  }

  const SUPABASE = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
  if (!SUPABASE || !SERVICE_KEY) return json(501, { error: "profile store not configured" });

  const idToken = request.headers.get("privy-id-token") || "";
  let accounts = null;
  if (idToken) {
    try {
      accounts = await accountsFromIdentityToken(idToken, claims.sub);
    } catch (e) {
      return json(401, { error: `invalid identity token: ${e.message}` });
    }
  }
  if (!accounts) {
    try {
      accounts = await accountsFromPrivyApi(claims.sub);
    } catch (e) {
      return json(502, { error: `privy lookup failed: ${e.message}` });
    }
  }
  if (!accounts) {
    return json(501, {
      error: "no identity source — enable Privy identity tokens or set PRIVY_APP_SECRET",
    });
  }

  const address = pickWallet(accounts);
  if (!address) return json(422, { error: "no ethereum wallet on this account" });
  const { username, pfp } = pickTwitter(accounts);

  const row = {
    address: address.toLowerCase(),
    twitter_username: username,
    pfp_url: pfp,
    updated_at: new Date().toISOString(),
  };

  const up = await fetch(`${SUPABASE}/rest/v1/griddy_players?on_conflict=address`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
    cache: "no-store",
  }).catch(() => null);
  if (!up || !up.ok) return json(502, { error: `profile upsert failed (${up ? up.status : "network"})` });

  return json(200, row);
}
