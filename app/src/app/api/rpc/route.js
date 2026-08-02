// Same-origin JSON-RPC proxy.
//
// The browser cannot talk to Arc's RPC directly: the upstream endpoint sends
// no Access-Control-Allow-Origin header, so every read is blocked by CORS and
// the game never loads. Forwarding server-side also keeps the upstream key off
// the client and lets one endpoint be swapped without a rebuild.
//
// Set ARC_RPC_URL (server-only, NOT NEXT_PUBLIC_) to a private endpoint.
export const dynamic = "force-dynamic";

const UPSTREAM =
  process.env.ARC_RPC_URL || "https://rpc.labsapis.com/mainnet/arc";
// Some Arc gateways only answer requests carrying a specific Origin. Set
// ARC_RPC_ORIGIN when the upstream requires one; unset it for endpoints
// (e.g. a private provider key) that don't care.
const UPSTREAM_ORIGIN = process.env.ARC_RPC_ORIGIN || "";

export async function POST(request) {
  const body = await request.text();
  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(UPSTREAM_ORIGIN ? { origin: UPSTREAM_ORIGIN } : {}),
      },
      body,
      cache: "no-store",
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `proxy: ${e.message}` } }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }
}
