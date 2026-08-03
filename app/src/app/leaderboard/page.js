"use client";
import { useEffect, useRef, useState } from "react";

// ═══════════════════════════════════════════════════════════════
// LEADERBOARD — live XP standings, recomputed from the on-chain
// mirror server-side (see /api/db?t=leaderboard for the rules).
// ═══════════════════════════════════════════════════════════════

const MONO = "'JetBrains Mono', monospace";
const BALOO = "'Baloo 2', sans-serif";

const RULES = [
  ["ENTER", "+25 XP", "each round you enter"],
  ["VOLUME", "+100 XP", "per $1 staked"],
  ["OUTCOME", "+150 XP", "per $1 won"],
  ["WIN", "+100 XP", "each round you win"],
  ["STREAK", "+50 XP", "per consecutive win after the first (max +250)"],
];

const avatarHue = (addr) => {
  let h = 0;
  for (const c of String(addr)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

function GriddyMark({ size = 30 }) {
  const s = 17, g = 4.5, o = 4;
  const tiles = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const accent = r === 1 && c === 1;
    tiles.push(<rect key={r + "-" + c} x={o + c * (s + g)} y={o + r * (s + g)} width={s} height={s} rx={4.5} fill={accent ? "#3E8BFF" : "#EAF1FF"} opacity={accent ? 1 : 0.92} />);
  }
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>
      <rect x={o + 1 * (s + g) - 3} y={o + 1 * (s + g) - 3} width={s + 6} height={s + 6} rx={6} fill="rgba(62,139,255,0.45)" filter="blur(4px)" />
      {tiles}
      <text x={o + 1 * (s + g) + s / 2} y={o + 1 * (s + g) + s - 4} textAnchor="middle" fontFamily={BALOO} fontWeight="800" fontSize="14" fill="#071230">G</text>
    </svg>
  );
}

function Pfp({ row, size = 34 }) {
  // coloured initial underneath, photo on top — a missing or 404ing avatar
  // degrades to the initial with no extra state
  const initial = String(row.twitter_username || row.address.slice(2)).slice(0, 1).toUpperCase();
  return (
    <span style={{
      position: "relative", width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: `hsl(${avatarHue(row.address)} 45% 38%)`, display: "inline-flex",
      alignItems: "center", justifyContent: "center", overflow: "hidden",
      border: "1px solid rgba(148,178,255,0.25)",
      fontFamily: BALOO, fontWeight: 800, fontSize: size * 0.45, color: "#EAF1FF",
    }}>
      {initial}
      {row.pfp_url && (
        <img src={row.pfp_url} alt="" referrerPolicy="no-referrer"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
      )}
    </span>
  );
}

export default function Leaderboard() {
  const [rows, setRows] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await fetch("/api/db?t=leaderboard", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (!dead && Array.isArray(j.leaderboard)) {
          setRows(j.leaderboard);
          setUpdatedAt(new Date());
        }
      } catch {}
    };
    load();
    timer.current = setInterval(load, 15000); // live: re-pulls every 15s
    return () => { dead = true; clearInterval(timer.current); };
  }, []);

  return (
    <div style={S.root}>
      <div style={S.dotGrid} />

      <header className="lb-header" style={S.header}>
        <div style={S.hLeft}>
          <GriddyMark size={30} />
          <span style={S.logo}>griddy</span>
          <span style={S.badge}>LEADERBOARD</span>
        </div>
        <nav style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <a href="/home" style={S.navBtn}>HOME</a>
          <a href="/" style={S.navBtn}>PLAY</a>
          <span style={{ ...S.navBtn, background: "rgba(62,139,255,0.08)", border: "1px solid rgba(62,139,255,0.25)", color: "#3E8BFF", cursor: "default" }}>LEADERBOARD</span>
        </nav>
      </header>

      <div className="lb-content" style={S.content}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <div style={S.heroTag}>EVERY STAKE COUNTS ✦</div>
          <h1 style={S.heroTitle}>Leaderboard</h1>
          <div style={S.liveLine}>
            <span style={S.liveDot} />LIVE — RECOMPUTED FROM THE CHAIN MIRROR
            {updatedAt && <span style={{ color: "#55688F" }}> · updated {updatedAt.toLocaleTimeString([], { hour12: false })}</span>}
          </div>
        </div>

        <div style={S.tableCard}>
          <div className="lb-row lb-head" style={{ ...S.row, ...S.rowHead }}>
            <span style={S.cRank}>#</span>
            <span style={S.cPlayer}>PLAYER</span>
            <span style={S.cXp}>XP</span>
            <span style={S.cNum} className="lb-wide">STAKED</span>
            <span style={S.cNum} className="lb-wide">WON</span>
            <span style={S.cNum}>W/R</span>
            <span style={S.cNum} className="lb-wide">STREAK</span>
          </div>

          {rows == null ? (
            <div style={S.empty}>⟐ LOADING STANDINGS…</div>
          ) : rows.length === 0 ? (
            <div style={S.empty}>no players yet — the first stake starts the board</div>
          ) : (
            rows.map((r, i) => (
              <div key={r.address} className="lb-row" style={{
                ...S.row,
                background: i % 2 ? "rgba(148,178,255,0.025)" : "transparent",
                ...(i < 3 ? { background: "rgba(62,139,255,0.06)" } : {}),
              }}>
                <span style={{ ...S.cRank, color: i === 0 ? "#FFD764" : i === 1 ? "#C9D6EF" : i === 2 ? "#E2A986" : "#55688F", fontWeight: 800 }}>
                  {i + 1}
                </span>
                <span style={S.cPlayer}>
                  <Pfp row={r} />
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.twitter_username
                      ? <a href={`https://x.com/${r.twitter_username}`} target="_blank" rel="noreferrer" style={S.handle}>@{r.twitter_username}</a>
                      : <span style={{ color: "#8FA3C9", fontFamily: MONO, fontSize: 12 }}>{r.address.slice(0, 6)}…{r.address.slice(-4)}</span>}
                  </span>
                </span>
                <span style={S.cXp} title={`enter ${r.breakdown.enter} · volume ${r.breakdown.volume} · outcome ${r.breakdown.outcome} · win ${r.breakdown.win} · streak ${r.breakdown.streak}`}>
                  {r.xp.toLocaleString()} <b style={{ fontSize: 10, color: "#55688F" }}>XP</b>
                </span>
                <span style={S.cNum} className="lb-wide">${r.staked_usd}</span>
                <span style={{ ...S.cNum, color: "#6FB0FF" }} className="lb-wide">${r.won_usd}</span>
                <span style={S.cNum}>{r.wins}/{r.rounds}</span>
                <span style={S.cNum} className="lb-wide">{r.best_streak > 1 ? `×${r.best_streak}` : "—"}</span>
              </div>
            ))
          )}
        </div>

        {/* How XP is earned — same numbers the server uses */}
        <div style={S.rulesCard}>
          <div style={S.rulesTitle}>HOW XP IS EARNED</div>
          <div style={S.rulesGrid}>
            {RULES.map(([k, v, d]) => (
              <div key={k} style={S.rule}>
                <span style={S.ruleK}>{k}</span>
                <span style={S.ruleV}>{v}</span>
                <span style={S.ruleD}>{d}</span>
              </div>
            ))}
          </div>
          <div style={S.rulesFoot}>
            recomputed live from on-chain stakes and payouts — no points are stored, so the board can never drift from the chain
          </div>
        </div>
      </div>

      <footer style={S.footer}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <GriddyMark size={16} />
          <span style={S.footerOnline}>GRIDDY ONLINE</span>
        </span>
        <span style={{ fontSize: 11, color: "#55688F", letterSpacing: 1, fontFamily: MONO }}>ON-CHAIN · ARC · RANDOMNESS BY DRAND</span>
      </footer>

      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { margin: 0; background: #060B1C; overflow-x: hidden; }
        @keyframes scanGlow {
          0% { text-shadow: 0 0 4px rgba(62,139,255,0.55); }
          50% { text-shadow: 0 0 12px rgba(62,139,255,0.55), 0 0 24px rgba(62,139,255,0.27); }
          100% { text-shadow: 0 0 4px rgba(62,139,255,0.55); }
        }
        @keyframes livePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        a:hover { color: #6FB0FF !important; }
        @media (max-width: 640px) {
          .lb-wide { display: none !important; }
          .lb-content { padding: 24px 12px 40px !important; }
          .lb-header { padding: 12px 14px !important; }
        }
      `}</style>
    </div>
  );
}

const S = {
  root: {
    fontFamily: "'Inter', sans-serif",
    background: "radial-gradient(ellipse at 50% -10%, rgba(62,139,255,0.13), transparent 60%), #060B1C",
    color: "#EAF1FF", minHeight: "100vh", display: "flex", flexDirection: "column", position: "relative",
  },
  dotGrid: {
    position: "fixed", inset: 0, pointerEvents: "none", zIndex: 1,
    background: "radial-gradient(rgba(148,178,255,0.05) 1px, transparent 1px)", backgroundSize: "26px 26px",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "12px 20px", borderBottom: "1px solid rgba(148,178,255,0.08)",
    background: "rgba(6,11,28,0.95)", zIndex: 10, position: "relative", flexWrap: "wrap", gap: 8,
  },
  hLeft: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  logo: { fontFamily: BALOO, fontWeight: 800, fontSize: 20, color: "#F4F7FF", letterSpacing: 0.5 },
  badge: {
    fontFamily: MONO, fontSize: 9, padding: "3px 9px", borderRadius: 999,
    background: "rgba(148,178,255,0.06)", color: "#8FA3C9", letterSpacing: 2, fontWeight: 700,
    border: "1px solid rgba(148,178,255,0.12)",
  },
  navBtn: {
    fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "#55688F",
    padding: "6px 12px", borderRadius: 999, textDecoration: "none", border: "1px solid transparent",
    transition: "color 0.2s",
  },
  content: { flex: 1, width: "100%", maxWidth: 860, margin: "0 auto", padding: "36px 24px 56px", position: "relative", zIndex: 5 },
  heroTag: { fontFamily: MONO, fontSize: 10, letterSpacing: 3, color: "#3E8BFF", marginBottom: 12, fontWeight: 700 },
  heroTitle: { fontFamily: BALOO, fontSize: 38, fontWeight: 800, color: "#F4F7FF", lineHeight: 1.1, marginBottom: 10 },
  liveLine: {
    display: "inline-flex", alignItems: "center", gap: 7, fontFamily: MONO, fontSize: 9.5,
    letterSpacing: 1.5, color: "#8FA3C9", fontWeight: 700,
  },
  liveDot: {
    width: 7, height: 7, borderRadius: "50%", background: "#3E8BFF",
    boxShadow: "0 0 8px rgba(62,139,255,0.7)", animation: "livePulse 1.6s ease-in-out infinite",
  },
  tableCard: {
    border: "1px solid rgba(148,178,255,0.08)", borderRadius: 20, background: "#0A1228",
    overflow: "hidden", marginBottom: 22,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "36px minmax(0,1fr) 120px 84px 84px 56px 70px",
    alignItems: "center", gap: 8, padding: "10px 16px",
    borderBottom: "1px solid rgba(148,178,255,0.05)",
  },
  rowHead: {
    fontFamily: MONO, fontSize: 9, letterSpacing: 2, color: "#55688F", fontWeight: 700,
    background: "rgba(148,178,255,0.03)", padding: "12px 16px",
  },
  cRank: { fontFamily: BALOO, fontSize: 15, textAlign: "center" },
  cPlayer: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  handle: { color: "#EAF1FF", fontWeight: 600, fontSize: 13.5, textDecoration: "none" },
  cXp: { fontFamily: BALOO, fontWeight: 800, fontSize: 17, color: "#5FA6FF", textAlign: "right", cursor: "default" },
  cNum: { fontFamily: MONO, fontSize: 11, color: "#8FA3C9", textAlign: "right" },
  empty: { padding: "36px 20px", textAlign: "center", fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: "#55688F" },
  rulesCard: { border: "1px solid rgba(148,178,255,0.08)", borderRadius: 20, background: "#0A1228", padding: "18px 20px" },
  rulesTitle: { fontFamily: MONO, fontSize: 10, letterSpacing: 2.5, color: "#8FA3C9", fontWeight: 700, marginBottom: 14 },
  rulesGrid: { display: "flex", flexDirection: "column", gap: 8 },
  rule: { display: "grid", gridTemplateColumns: "76px 84px minmax(0,1fr)", gap: 10, alignItems: "baseline" },
  ruleK: { fontFamily: MONO, fontSize: 10, letterSpacing: 1.5, color: "#EAF1FF", fontWeight: 700 },
  ruleV: { fontFamily: BALOO, fontSize: 14, fontWeight: 800, color: "#5FA6FF" },
  ruleD: { fontSize: 12, color: "#8FA3C9" },
  rulesFoot: { marginTop: 14, fontSize: 10.5, color: "#55688F", lineHeight: 1.5 },
  footer: {
    display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px",
    borderTop: "1px solid rgba(148,178,255,0.08)", background: "rgba(6,11,28,0.95)",
    zIndex: 10, position: "relative", flexWrap: "wrap", gap: 8,
  },
  footerOnline: { fontFamily: MONO, fontSize: 12, fontWeight: 700, color: "#6FB0FF", letterSpacing: 2, animation: "scanGlow 3s ease-in-out infinite" },
};
