"use client";
import { useEffect, useState } from "react";

// ═══════════════════════════════════════════════════════════════
// HOW TO PLAY
// ═══════════════════════════════════════════════════════════════

const GRID_SIZE = 5;
const CELL_LABELS = [];
for (let r = 0; r < GRID_SIZE; r++)
  for (let c = 0; c < GRID_SIZE; c++)
    CELL_LABELS.push(`${String.fromCharCode(65 + r)}${c + 1}`);

// Base logo pattern
const DARK_CELLS = new Set([0,1,2,3,4, 5,9, 10,14, 15,19, 20,21,22,23,24]);
const OPENING_CELLS = new Set([11,12,13]);
const getCellZone = (idx) => {
  if (DARK_CELLS.has(idx)) return "dark";
  if (OPENING_CELLS.has(idx)) return "opening";
  return "light";
};

// Demo states for the example grid
const DEMO_CLAIMED = new Set([1, 8, 12]);
const DEMO_YOURS = 9; // B5
const DEMO_WINNER = 12; // C3

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
      <text x={o + 1 * (s + g) + s / 2} y={o + 1 * (s + g) + s - 4} textAnchor="middle" fontFamily="'Baloo 2',sans-serif" fontWeight="800" fontSize="14" fill="#071230">G</text>
    </svg>
  );
}

export default function HowToPlay() {
  const [scanLine, setScanLine] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setScanLine(p => (p + 0.4) % 110), 40);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={S.root}>
      {/* Scan line */}
      <div style={{
        ...S.scanOverlay,
        background: `linear-gradient(180deg,
          transparent ${scanLine - 2}%,
          rgba(62,139,255,0.04) ${scanLine - 1}%,
          rgba(62,139,255,0.08) ${scanLine}%,
          rgba(62,139,255,0.04) ${scanLine + 1}%,
          transparent ${scanLine + 2}%)`,
      }} />
      <div style={S.dotGrid} />

      {/* Header */}
      <header className="htp-header" style={S.header}>
        <div style={S.hLeft}>
          <GriddyMark size={30} />
          <span style={S.logo}>griddy</span>
          <span style={S.badge}>HOW TO PLAY</span>
        </div>
        <div style={S.hRight}>
          <a href="/" style={S.backBtn}>← BACK TO GRID</a>
        </div>
      </header>

      {/* Content */}
      <div className="htp-content" style={S.content}>
        {/* Hero */}
        <div style={S.hero}>
          <div style={S.heroTag}>STAKE A SQUARE. TAKE THE POT. ✦</div>
          <h1 className="htp-hero-title" style={S.heroTitle}>How to play</h1>
          <p style={S.heroDesc}>
            Stake a cell with USDC. When the round closes, a drand randomness beacon
            determines the winning cell. If you staked on it, you receive your share of the prize.
          </p>
        </div>

        {/* Steps */}
        <div style={S.steps}>
          <Step num="01" title="SIGN IN & FUND">
            Sign in with your <Hl>X account</Hl> to get started. You'll need <Hl>USDC on Arc</Hl> to
            play. Stake from <Hl>$0.10</Hl> on any cell.
          </Step>

          <Step num="02" title="STAKE YOUR CELL">
            Choose any cell on the <Hl>5×5 grid</Hl> and enter your stake. You can stake on multiple
            cells, and multiple players can stake on the same cell.
          </Step>

          <Step num="03" title="ROUND RESOLVES">
            When the round closes, <Hl>drand</Hl> provides the randomness used to determine the
            winning cell. The game contract <Hl>verifies the randomness on-chain</Hl> before
            finalizing the result.
          </Step>

          <Step num="04" title="WINNERS GET PAID">
            If you staked on the winning cell, you receive a share of the prize
            <span style={{ color: "#6FB0FF", fontWeight: 600 }}> proportional to your stake</span> on
            that cell. Payouts are automatic.
          </Step>

          <Step num="05" title="NEXT ROUND">
            After the result is revealed and payouts settle, the grid resets for the next round.
          </Step>
        </div>

        {/* Demo Grid */}
        <div style={S.demoSection}>
          <div style={S.demoLabel}>EXAMPLE ROUND</div>
          <div style={S.demoGridWrap}>
            <div style={S.cornerTL} /><div style={S.cornerTR} />
            <div style={S.cornerBL} /><div style={S.cornerBR} />
            <div className="htp-demo-grid" style={S.demoGrid}>
              {CELL_LABELS.map((label, idx) => {
                const zone = getCellZone(idx);
                const isWinner = idx === DEMO_WINNER;
                const isYours = idx === DEMO_YOURS;
                const isClaimed = DEMO_CLAIMED.has(idx);

                let zoneStyle = zone === "dark" ? S.dcDark
                  : zone === "opening" ? S.dcOpening : S.dcLight;

                let stateStyle = {};
                if (isWinner) stateStyle = S.dcWinner;
                else if (isYours) stateStyle = S.dcYours;
                else if (isClaimed) stateStyle = S.dcPicked;

                return (
                  <div key={idx} style={{
                    ...S.demoCell, ...zoneStyle, ...stateStyle,
                    animationDelay: `${idx * 0.02}s`,
                  }}>
                    <span style={{ fontSize: 14, lineHeight: 1 }}>
                      {isWinner ? "✦" : isYours ? "◈" : isClaimed ? "◈" : "·"}
                    </span>
                    <span style={{ fontSize: 8, letterSpacing: 1, fontFamily: "'JetBrains Mono', monospace" }}>{label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Legend */}
          <div style={S.legend}>
            <LegendItem color="linear-gradient(145deg,#141F3D,#0C152E)" border="rgba(150,180,255,0.10)" label="Empty" />
            <LegendItem color="rgba(62,139,255,0.22)" border="rgba(62,139,255,0.45)" label="Claimed" />
            <LegendItem color="linear-gradient(180deg,#5FA6FF,#2E7BFF)" border="rgba(111,176,255,0.8)" label="Your Stake" glow />
            <LegendItem color="linear-gradient(180deg,#6FB0FF,#3E8BFF)" border="rgba(111,176,255,0.9)" label="Winner" glow />
          </div>
        </div>

        {/* Info Cards */}
        <div className="htp-info-grid" style={S.infoGrid}>
          <InfoCard icon="⬡" title="PROVABLY FAIR">
            Every round uses <Hl>drand randomness</Hl> verified <Hl>on-chain</Hl> by the game
            contract. The winning cell is determined using distributed randomness that cannot be
            changed after betting closes.
          </InfoCard>
          <InfoCard icon="◈" title="ON-CHAIN SETTLEMENT">
            Stakes, payouts, and round results are settled on <Hl>Arc</Hl> and can be verified on
            the Arc explorer.
          </InfoCard>
          <InfoCard icon="●" title="PRO-RATA PAYOUTS">
            <Hl>90% of the pot</Hl> goes to players on the winning cell. If multiple players staked
            on it, the prize is split proportionally based on each player's stake. Put in 25% of the
            stake on the winning cell and receive 25% of the prize.
          </InfoCard>
          <InfoCard icon="↗" title="AUTOMATIC PAYOUTS">
            When a round resolves, winners receive their USDC automatically. No manual claim is
            required.
          </InfoCard>
        </div>

        {/* CTA */}
        <div style={S.ctaSection}>
          <a href="/" style={S.ctaBtn}>STAKE A SQUARE ◎</a>
          <div style={S.ctaSub}>
            ON-CHAIN · ARC · RANDOMNESS BY DRAND
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="htp-footer" style={S.footer}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <GriddyMark size={16} />
          <span style={S.footerOnline}>GRIDDY ONLINE</span>
        </span>
        <span style={{ fontSize: 11, color: "#55688F", letterSpacing: 1, fontFamily: "'JetBrains Mono', monospace" }}>ON-CHAIN · ARC · RANDOMNESS BY DRAND</span>
      </footer>

      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { margin: 0; padding: 0; background: #060B1C; overflow-x: hidden; }
        @keyframes cellAppear { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
        @keyframes glowBlue {
          0%, 100% { box-shadow: 0 0 8px rgba(62,139,255,0.3), 0 5px 12px rgba(0,0,0,0.45); }
          50% { box-shadow: 0 0 20px rgba(62,139,255,0.55), 0 5px 12px rgba(0,0,0,0.45); }
        }
        @keyframes winnerGlow {
          0%, 100% { box-shadow: 0 0 12px rgba(62,139,255,0.35), 0 5px 12px rgba(0,0,0,0.45); }
          50% { box-shadow: 0 0 28px rgba(62,139,255,0.7), 0 5px 12px rgba(0,0,0,0.45); }
        }
        @keyframes scanGlow {
          0% { text-shadow: 0 0 4px rgba(62,139,255,0.55); }
          50% { text-shadow: 0 0 12px rgba(62,139,255,0.55), 0 0 24px rgba(62,139,255,0.27); }
          100% { text-shadow: 0 0 4px rgba(62,139,255,0.55); }
        }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @media (max-width: 640px) {
          .htp-info-grid { grid-template-columns: minmax(0, 1fr) !important; }
          .htp-special-cards { flex-direction: column !important; }
          .htp-demo-grid { width: min(280px, 100%) !important; }
          .htp-hero-title { font-size: 28px !important; }
          .htp-header { padding: 12px 14px !important; }
          .htp-footer { padding: 10px 14px !important; }
          .htp-content { padding: 32px 14px 48px !important; }
          .htp-step { padding: 16px 14px !important; gap: 14px !important; }
        }
      `}</style>
    </div>
  );
}

// ── Sub-components ──
function Step({ num, title, children }) {
  return (
    <div className="htp-step" style={S.step}>
      <div style={S.stepNum}>{num}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.stepTitle}>{title}</div>
        <div style={S.stepDesc}>{children}</div>
      </div>
    </div>
  );
}

function Hl({ children }) {
  return <span style={{ color: "#6FB0FF", fontWeight: 600 }}>{children}</span>;
}

function InfoCard({ icon, title, children }) {
  return (
    <div style={S.infoCard}>
      <div style={{ fontSize: 22, marginBottom: 10, color: "#3E8BFF" }}>{icon}</div>
      <div style={S.infoCardTitle}>{title}</div>
      <div style={S.infoCardText}>{children}</div>
    </div>
  );
}

function LegendItem({ color, border, label, glow }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#8FA3C9", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1 }}>
      <div style={{
        width: 12, height: 12, borderRadius: 3,
        background: color, border: `1px solid ${border}`,
        boxShadow: glow ? "0 0 6px rgba(62,139,255,0.55)" : "0 2px 4px rgba(0,0,0,0.45)",
      }} />
      {label}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════
const S = {
  root: {
    fontFamily: "'Inter', sans-serif",
    background: "radial-gradient(ellipse at 50% -10%, rgba(62,139,255,0.13), transparent 60%), #060B1C",
    color: "#EAF1FF", minHeight: "100vh",
    display: "flex", flexDirection: "column", position: "relative",
  },
  scanOverlay: {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: "none", zIndex: 2, transition: "background 0.04s linear",
  },
  dotGrid: {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: "none", zIndex: 1,
    background: "radial-gradient(rgba(148,178,255,0.05) 1px, transparent 1px)",
    backgroundSize: "26px 26px",
  },

  // Header
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "12px 20px", borderBottom: "1px solid rgba(148,178,255,0.08)",
    background: "rgba(6,11,28,0.95)", zIndex: 10, position: "relative",
    flexWrap: "wrap", gap: 8,
  },
  hLeft: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 },
  hRight: { display: "flex", alignItems: "center", gap: 16 },
  dot: { width: 10, height: 10, borderRadius: 3, background: "#3E8BFF", boxShadow: "0 0 12px rgba(62,139,255,0.55)" },
  logo: { fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 20, color: "#F4F7FF", letterSpacing: 0.5 },
  badge: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9, padding: "3px 9px", borderRadius: 999,
    background: "rgba(148,178,255,0.06)", color: "#8FA3C9",
    letterSpacing: 2, fontWeight: 700, border: "1px solid rgba(148,178,255,0.12)",
  },
  backBtn: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
    padding: "8px 18px", borderRadius: 999,
    border: "1px solid rgba(148,178,255,0.12)",
    background: "rgba(148,178,255,0.06)",
    color: "#8FA3C9", cursor: "pointer", letterSpacing: 2, textDecoration: "none",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    minHeight: 40, whiteSpace: "nowrap",
  },

  // Content
  content: {
    flex: 1, width: "100%", maxWidth: 780, margin: "0 auto",
    padding: "40px 28px 60px", position: "relative", zIndex: 5,
  },

  // Hero
  hero: { textAlign: "center", marginBottom: 48 },
  heroTag: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10, letterSpacing: 3, color: "#3E8BFF", marginBottom: 14, fontWeight: 700,
  },
  heroTitle: {
    fontFamily: "'Baloo 2', sans-serif", fontSize: 40, fontWeight: 800,
    letterSpacing: 0.5, marginBottom: 14, color: "#F4F7FF", lineHeight: 1.15,
  },
  heroDesc: {
    fontSize: 14, color: "#8FA3C9", lineHeight: 1.7,
    maxWidth: 560, margin: "0 auto",
  },

  // Steps
  steps: { display: "flex", flexDirection: "column", gap: 20 },
  step: {
    display: "flex", gap: 20, alignItems: "flex-start",
    padding: 22, border: "1px solid rgba(148,178,255,0.08)",
    borderRadius: 20, background: "#0A1228",
  },
  stepNum: {
    flexShrink: 0, width: 46, height: 46,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'Baloo 2', sans-serif", fontSize: 18, fontWeight: 800,
    color: "#6FB0FF", border: "1px solid rgba(150,180,255,0.10)",
    borderRadius: "26%", background: "linear-gradient(145deg, #141F3D, #0C152E)",
    boxShadow: "0 5px 12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
  },
  stepTitle: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700,
    color: "#EAF1FF", letterSpacing: 2, marginBottom: 8,
  },
  stepDesc: { fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#8FA3C9", lineHeight: 1.7 },

  // Demo Grid
  demoSection: { marginTop: 48, textAlign: "center" },
  demoLabel: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
    letterSpacing: 3, color: "#55688F", marginBottom: 16,
  },
  demoGridWrap: { display: "inline-block", position: "relative", padding: 14, maxWidth: "100%" },
  demoGrid: { display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 7, width: "min(310px, 100%)" },
  demoCell: {
    aspectRatio: "1", borderRadius: "26%",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: 2, fontSize: 9, fontWeight: 600, animation: "cellAppear 0.4s ease both",
    boxShadow: "0 5px 12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
  },
  cornerTL: { position: "absolute", top: 0, left: 0, width: 18, height: 18, borderLeft: "2px solid rgba(62,139,255,0.35)", borderTop: "2px solid rgba(62,139,255,0.35)" },
  cornerTR: { position: "absolute", top: 0, right: 0, width: 18, height: 18, borderRight: "2px solid rgba(62,139,255,0.35)", borderTop: "2px solid rgba(62,139,255,0.35)" },
  cornerBL: { position: "absolute", bottom: 0, left: 0, width: 18, height: 18, borderLeft: "2px solid rgba(62,139,255,0.35)", borderBottom: "2px solid rgba(62,139,255,0.35)" },
  cornerBR: { position: "absolute", bottom: 0, right: 0, width: 18, height: 18, borderRight: "2px solid rgba(62,139,255,0.35)", borderBottom: "2px solid rgba(62,139,255,0.35)" },

  // Cell zones — keycap tiles with subtle depth variation
  dcDark: {
    background: "linear-gradient(145deg, #141F3D, #0C152E)",
    border: "1px solid rgba(150,180,255,0.10)", color: "rgba(165,190,240,0.4)",
  },
  dcLight: {
    background: "linear-gradient(145deg, #182548, #0E1834)",
    border: "1px solid rgba(150,180,255,0.14)", color: "rgba(165,190,240,0.5)",
  },
  dcOpening: {
    background: "linear-gradient(145deg, #1C2B52, #101B3A)",
    border: "1px solid rgba(150,180,255,0.18)", color: "rgba(180,205,250,0.55)",
  },
  dcPicked: {
    background: "rgba(62,139,255,0.22)",
    border: "1px solid rgba(62,139,255,0.45)", color: "#6FB0FF",
  },
  dcYours: {
    background: "linear-gradient(180deg, #5FA6FF, #2E7BFF)",
    border: "1px solid rgba(111,176,255,0.8)", color: "#071230",
    animation: "glowBlue 2s ease-in-out infinite",
  },
  dcWinner: {
    background: "linear-gradient(180deg, #6FB0FF, #3E8BFF)",
    border: "1px solid rgba(111,176,255,0.9)",
    color: "#071230", animation: "winnerGlow 1.5s ease-in-out infinite",
  },

  legend: { display: "flex", justifyContent: "center", gap: 20, marginTop: 16, flexWrap: "wrap" },

  // Info Cards
  infoGrid: {
    display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16, marginTop: 48,
  },
  infoCard: {
    border: "1px solid rgba(148,178,255,0.08)", borderRadius: 20,
    background: "#0A1228", padding: 20,
  },
  infoCardTitle: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
    letterSpacing: 2, color: "#EAF1FF", marginBottom: 8,
  },
  infoCardText: { fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#8FA3C9", lineHeight: 1.6 },

  // Specials
  specialsSection: { marginTop: 48 },
  specialsTitle: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700,
    letterSpacing: 2, color: "#EAF1FF", marginBottom: 20, textAlign: "center",
  },
  specialCards: { display: "flex", gap: 16 },
  specialMotherlode: {
    flex: 1, borderRadius: 20, padding: 20, textAlign: "center",
    border: "1px solid rgba(111,176,255,0.2)",
    background: "linear-gradient(145deg, rgba(62,139,255,0.06), rgba(62,139,255,0.02))",
  },
  specialBonus: {
    flex: 1, borderRadius: 20, padding: 20, textAlign: "center",
    border: "1px solid rgba(62,139,255,0.2)",
    background: "linear-gradient(145deg, rgba(62,139,255,0.06), rgba(62,139,255,0.02))",
  },
  specialName: { fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700, letterSpacing: 2, marginBottom: 6 },
  specialDesc: { fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#8FA3C9", lineHeight: 1.6 },

  // CTA
  ctaSection: { marginTop: 56, textAlign: "center" },
  ctaBtn: {
    fontFamily: "'Baloo 2', sans-serif", fontSize: 16, fontWeight: 700,
    padding: "16px 48px", borderRadius: 999, border: "none", cursor: "pointer",
    letterSpacing: 1, background: "linear-gradient(180deg, #5FA6FF, #2E7BFF)",
    color: "#071230", boxShadow: "0 8px 24px rgba(62,139,255,0.35)",
    textTransform: "uppercase", textDecoration: "none", display: "inline-block",
    maxWidth: "min(480px, 100%)",
  },
  ctaSub: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10, color: "#55688F", marginTop: 14, letterSpacing: 2,
  },

  // Footer
  footer: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "10px 20px", borderTop: "1px solid rgba(148,178,255,0.08)",
    background: "rgba(6,11,28,0.95)", zIndex: 10, position: "relative",
    flexWrap: "wrap", gap: 8,
  },
  footerDot: {
    display: "inline-block", width: 6, height: 6, borderRadius: "50%",
    background: "#3E8BFF", boxShadow: "0 0 8px rgba(62,139,255,0.55)",
  },
  footerOnline: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12, fontWeight: 700, color: "#6FB0FF", letterSpacing: 2,
    animation: "scanGlow 3s ease-in-out infinite",
  },
};
