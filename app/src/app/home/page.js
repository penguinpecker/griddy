"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const DARK = new Set([0,1,2,3,4,5,9,10,14,15,19,20,21,22,23,24]);
const OPEN = new Set([11,12,13]);
const LBL = [];
for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) LBL.push(String.fromCharCode(65+r)+(c+1));
const CLAIMED = [7,9,12,13];

const BALOO = "'Baloo 2',sans-serif";
const MONO = "'JetBrains Mono',monospace";
const INTER = "Inter,sans-serif";
const ACCENT = "#3E8BFF";
const ACCENT_LIGHT = "#6FB0FF";
const INK = "#071230";
const TXT = "#EAF1FF";
const MUTED = "#8FA3C9";
const FAINT = "#55688F";
const CARD = { background:"#0A1228", border:"1px solid rgba(148,178,255,0.08)", borderRadius:22 };
const CTA = { width:"100%", fontFamily:BALOO, fontSize:15, fontWeight:700, padding:"13px 20px", borderRadius:999, border:"none", background:"linear-gradient(180deg,#5FA6FF,#2E7BFF)", color:INK, cursor:"pointer", letterSpacing:1, boxShadow:"0 8px 24px rgba(62,139,255,0.35)" };

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

function tileVisual(state) {
  const base = {
    aspectRatio:"1", borderRadius:"26%",
    background:"linear-gradient(145deg,#141F3D,#0C152E)",
    border:"1px solid rgba(150,180,255,0.10)",
    boxShadow:"0 5px 12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
    display:"flex", alignItems:"center", justifyContent:"center",
  };
  if (state === "hover") return { box:{...base, border:"1px solid rgba(62,139,255,0.75)"}, dot:ACCENT };
  if (state === "selected") return { box:{...base, background:"linear-gradient(145deg,#5FA6FF,#2E7BFF)", border:"1px solid rgba(180,210,255,0.45)", boxShadow:"0 5px 12px rgba(0,0,0,0.45), 0 0 18px rgba(62,139,255,0.55), inset 0 1px 0 rgba(255,255,255,0.28)"}, dot:INK };
  if (state === "miss") return { box:{...base, background:"linear-gradient(145deg,#0D1630,#091124)", border:"1px solid rgba(150,180,255,0.05)"}, glyph:"✕", glyphColor:"#43537A" };
  if (state === "win") return { box:{...base, background:"linear-gradient(145deg,#5FA6FF,#2E7BFF)", border:"1px solid rgba(190,220,255,0.6)", boxShadow:"0 5px 14px rgba(0,0,0,0.45), 0 0 26px rgba(62,139,255,0.8), inset 0 1px 0 rgba(255,255,255,0.3)"}, glyph:"✦", glyphColor:INK };
  return { box:base, dot:"rgba(165,190,240,0.4)" };
}

function Keycap({ state = "empty", style, glyphSize = 16 }) {
  const v = tileVisual(state);
  return (
    <div className={state === "empty" ? "kc-empty" : undefined} style={{...v.box, ...style}}>
      {v.glyph
        ? <span style={{fontSize:glyphSize, fontWeight:700, color:v.glyphColor, lineHeight:1, fontFamily:BALOO}}>{v.glyph}</span>
        : <span className="kc-dot" style={{width:4, height:4, borderRadius:"50%", background:v.dot, transition:"background 0.15s"}}/>}
    </div>
  );
}

function MechCard({ title, children }) {
  return (
    <div style={{...CARD, borderRadius:18, padding:22, display:"flex", flexDirection:"column", gap:10}}>
      <div style={{fontFamily:MONO, fontSize:11, fontWeight:700, letterSpacing:3, color:TXT}}>{title}</div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{height:1, background:"linear-gradient(90deg,transparent,rgba(148,178,255,0.14),transparent)"}}/>;
}

export default function HomePage() {
  const router = useRouter();
  const [scanY, setScanY] = useState(0);
  const [winner, setWinner] = useState(-1);
  const [zkStep, setZkStep] = useState(2);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeSuccess, setCodeSuccess] = useState(false);
  const [showCursor, setShowCursor] = useState(true);
  const winIdx = useRef(0);
  const zkIdx = useRef(2);

  useEffect(() => {
    const s1 = setInterval(() => setScanY(p => (p + 1) % 100), 40);
    const s2 = setInterval(() => { winIdx.current = (winIdx.current + 1) % CLAIMED.length; setWinner(CLAIMED[winIdx.current]); }, 1800);
    const s3 = setInterval(() => { zkIdx.current = (zkIdx.current + 1) % 6; setZkStep(zkIdx.current); }, 1000);
    return () => { clearInterval(s1); clearInterval(s2); clearInterval(s3); };
  }, []);

  function formatCode(val) {
    let v = val.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
    if (v.length > 4) v = v.slice(0, 4) + "-" + v.slice(4);
    setCode(v); setCodeError("");
  }

  function redeemCode() {
    if (!code || code.length < 9) { setCodeError("Enter a valid code in XXXX-XXXX format"); return; }
    setCodeLoading(true);
    setTimeout(() => { setCodeLoading(false); setCodeSuccess(true); }, 1200);
  }

  const ZK_STEPS = [
    "Round ends — block timestamp ≥ endTime",
    "drand network emits the pinned beacon",
    "Anyone fetches the public BLS signature",
    "resolveRound() verifies it on Arc",
    "Winners auto-paid in same transaction",
    "Beacon auditable forever — drand archive",
  ];

  const scanBg = `linear-gradient(180deg,transparent ${scanY-6}%,rgba(62,139,255,0.04) ${scanY-2}%,rgba(62,139,255,0.09) ${scanY}%,rgba(62,139,255,0.04) ${scanY+2}%,transparent ${scanY+6}%)`;

  const FEATURES = [
    { t:"FAST ROUNDS", d:"60s games. In. Place. Win.", icon:(
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.7" strokeLinejoin="round"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/></svg>
    )},
    { t:"VERIFIED FAIR", d:"Provably fair. Always on-chain.", icon:(
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/><path d="M9 11.5l2 2 4-4"/></svg>
    )},
    { t:"BUILT FOR CRYPTO", d:"Place USDC. Win onchain.", icon:(
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><path d="M12 2c3 2 4.5 5.5 4.5 9L12 15.5 7.5 11c0-3.5 1.5-7 4.5-9z"/><circle cx="12" cy="8.5" r="1.6"/><path d="M8 13l-2.5 5.5L10 16M16 13l2.5 5.5L14 16"/></svg>
    )},
  ];

  return (
    <div style={{fontFamily:INTER, background:"radial-gradient(ellipse at 50% -10%,rgba(62,139,255,0.13),transparent 60%),#060B1C", minHeight:"100vh", color:MUTED, position:"relative"}}>
      <div style={{position:"fixed", inset:0, pointerEvents:"none", zIndex:1, backgroundImage:"radial-gradient(rgba(148,178,255,0.05) 1px,transparent 1px)", backgroundSize:"26px 26px"}}/>

      {/* Header */}
      <header className="sec-pad" style={{display:"grid", gridTemplateColumns:"1fr auto 1fr", alignItems:"center", padding:"0 24px", height:58, borderBottom:"1px solid rgba(148,178,255,0.08)", background:"rgba(6,11,28,0.92)", backdropFilter:"blur(12px)", zIndex:100, position:"sticky", top:0}}>
        <div style={{display:"flex", alignItems:"center", gap:9, cursor:"pointer", padding:"10px 0", margin:"-10px 0", minWidth:0}} onClick={()=>router.push("/")}>
          <GriddyMark size={26}/>
          <span style={{fontFamily:BALOO, fontWeight:800, fontSize:19, color:"#F4F7FF", letterSpacing:0.5}}>griddy</span>
          <div style={{width:6, height:6, borderRadius:"50%", background:ACCENT, boxShadow:"0 0 6px rgba(62,139,255,0.8)", animation:"pulse 2s ease-in-out infinite", marginLeft:2, flexShrink:0}}/>
        </div>
        <nav style={{display:"flex", alignItems:"center", gap:4}}>
          <button onClick={()=>router.push("/home")} className="nav-btn-home" style={{background:"transparent", border:"none", fontFamily:MONO, fontSize:10, fontWeight:700, color:FAINT, cursor:"pointer", letterSpacing:2, padding:"14px 16px", borderRadius:999, transition:"color 0.2s"}}>HOME</button>
          <button onClick={()=>router.push("/play")} className="nav-btn-play-hp" style={{background:"transparent", border:"none", fontFamily:MONO, fontSize:10, fontWeight:700, color:ACCENT, cursor:"pointer", letterSpacing:2, padding:"14px 16px", borderRadius:999, animation:"navGlow 3s ease-in-out infinite", transition:"color 0.2s"}}>PLAY</button>
          <button onClick={()=>router.push("/leaderboard")} className="nav-btn-home" style={{background:"transparent", border:"none", fontFamily:MONO, fontSize:10, fontWeight:700, color:FAINT, cursor:"pointer", letterSpacing:2, padding:"14px 16px", borderRadius:999, transition:"color 0.2s"}}>LEADERBOARD</button>
        </nav>
        <div/>
      </header>

      {/* ── HERO ── */}
      <section className="sec-pad" style={{position:"relative", zIndex:5, padding:"56px 20px 44px", maxWidth:1080, margin:"0 auto"}}>
        <span style={{position:"absolute", top:16, left:20, fontFamily:MONO, fontSize:18, color:"rgba(148,178,255,0.22)"}}>+</span>
        <span style={{position:"absolute", top:16, right:20, fontFamily:MONO, fontSize:18, color:"rgba(148,178,255,0.22)"}}>+</span>

        <div style={{marginBottom:40, textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center"}}>
          <div style={{fontFamily:MONO, fontSize:10, letterSpacing:2, fontWeight:600, color:MUTED, background:"rgba(148,178,255,0.06)", border:"1px solid rgba(148,178,255,0.12)", borderRadius:999, padding:"6px 14px", marginBottom:26}}>⬡ CRYPTO-NATIVE · ON ARC</div>
          <div style={{display:"flex", alignItems:"center", justifyContent:"center", gap:"clamp(12px,3vw,22px)", flexWrap:"wrap", marginBottom:14}}>
            <GriddyMark size={72}/>
            <span style={{fontFamily:BALOO, fontWeight:800, fontSize:"clamp(56px,11vw,96px)", color:"#F4F7FF", letterSpacing:0.5, lineHeight:1}}>griddy</span>
          </div>
          <div className="hero-tag" style={{fontFamily:MONO, fontSize:"clamp(11px,2.7vw,14px)", letterSpacing:4, fontWeight:600, color:ACCENT, marginBottom:18, textAlign:"center"}}>STAKE A SQUARE. TAKE THE POT. ✦</div>
          <div style={{fontSize:13.5, color:MUTED, lineHeight:1.8, marginBottom:22, maxWidth:560}}>
            Stake a cell on the 5×5 grid. A drand randomness beacon — verified on-chain — selects the winner from occupied cells only. Winners share the pot — or keep everything if they staked alone.
          </div>
          <div style={{display:"flex", gap:8, flexWrap:"wrap", justifyContent:"center"}}>
            {["PLACE ANY AMOUNT OF USDC","60S ROUNDS","DRAND BEACON EVERY ROUND","AUTO-PAY ON RESOLVE"].map(c=>(
              <div key={c} style={{fontFamily:MONO, fontSize:9, letterSpacing:1.5, padding:"5px 12px", borderRadius:999, background:"rgba(148,178,255,0.06)", border:"1px solid rgba(148,178,255,0.12)", color:MUTED}}>{c}</div>
            ))}
          </div>
        </div>

        <div className="hero-cols">
          {/* Demo grid panel */}
          <div style={{...CARD, padding:18, position:"relative", overflow:"hidden", display:"flex", flexDirection:"column", gap:14}}>
            <div style={{position:"absolute", inset:0, pointerEvents:"none", transition:"background 0.04s linear", background:scanBg}}/>
            <div style={{display:"flex", gap:14, alignItems:"stretch"}}>
              <div style={{display:"flex", flexDirection:"column", alignItems:"center", gap:8, paddingTop:6, paddingBottom:6}}>
                <div style={{flex:1, width:0, borderLeft:"1px dashed rgba(148,178,255,0.2)"}}/>
                <span style={{writingMode:"vertical-rl", transform:"rotate(180deg)", fontFamily:MONO, fontSize:9, letterSpacing:2, color:FAINT}}>5×5 GRID</span>
                <div style={{flex:1, width:0, borderLeft:"1px dashed rgba(148,178,255,0.2)"}}/>
              </div>
              <div style={{display:"grid", gridTemplateColumns:"repeat(5,minmax(0,1fr))", gap:8, flex:1, minWidth:0}}>
                {LBL.map((lbl, i) => {
                  const isWin = i === winner;
                  const isClaimed = CLAIMED.includes(i) && !isWin;
                  const state = isWin ? "win" : isClaimed ? "selected" : "empty";
                  const v = tileVisual(state);
                  return (
                    <div key={lbl} className={state === "empty" ? "kc-empty" : undefined}
                      style={{...v.box, animation:isWin?"winPulse 1.5s ease-in-out infinite":"cellAppear 0.4s ease both", animationDelay:isWin?"0s":`${Math.floor(i/5)*0.06}s`}}>
                      {v.glyph
                        ? <span style={{fontFamily:BALOO, fontSize:"clamp(13px,3vw,19px)", fontWeight:700, color:v.glyphColor, lineHeight:1}}>{v.glyph}</span>
                        : <span className="kc-dot" style={{width:4, height:4, borderRadius:"50%", background:v.dot, transition:"background 0.15s"}}/>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{display:"flex", gap:18, justifyContent:"center", flexWrap:"wrap", position:"relative"}}>
              {[["ROUND","#1"],["POT","$4.00",ACCENT],["PLAYERS","4"]].map(([l,v,vc])=>(
                <div key={l} style={{fontFamily:MONO, fontSize:9, letterSpacing:1.5, color:FAINT, display:"flex", alignItems:"baseline", gap:6}}>{l} <b style={{fontFamily:BALOO, fontSize:14, fontWeight:700, color:vc||TXT, letterSpacing:0}}>{v}</b></div>
              ))}
            </div>
            <button onClick={()=>router.push("/play")} className="cta-pill" style={{...CTA, position:"relative"}}>STAKE A SQUARE ◎</button>
            <div style={{fontFamily:MONO, fontSize:9, letterSpacing:2, color:FAINT, textAlign:"center", position:"relative"}}>SIMULATION · ARC · DRAND SECURED</div>
          </div>

          {/* Features + code redeem */}
          <div style={{display:"flex", flexDirection:"column", gap:20}}>
            <div style={{...CARD, padding:"8px 20px"}}>
              {FEATURES.map(({t,d,icon}, i)=>(
                <div key={t} style={{display:"flex", alignItems:"center", gap:14, padding:"14px 0", borderTop:i?"1px solid rgba(148,178,255,0.07)":"none"}}>
                  <div style={{width:40, height:40, borderRadius:12, background:"linear-gradient(145deg,#141F3D,#0C152E)", border:"1px solid rgba(150,180,255,0.10)", boxShadow:"inset 0 1px 0 rgba(255,255,255,0.06)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0}}>{icon}</div>
                  <div>
                    <div style={{fontFamily:MONO, fontSize:11, fontWeight:700, letterSpacing:2, color:TXT, marginBottom:3}}>{t}</div>
                    <div style={{fontSize:12, color:MUTED}}>{d}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{...CARD, overflow:"hidden"}}>
              {!codeSuccess ? (
                <>
                  <div style={{padding:"13px 20px", borderBottom:"1px solid rgba(148,178,255,0.07)", background:"rgba(148,178,255,0.03)", display:"flex", justifyContent:"space-between", alignItems:"center", gap:10}}>
                    <span style={{fontFamily:MONO, fontSize:11, fontWeight:700, letterSpacing:2, color:TXT}}>GOT A CODE?</span>
                    <span style={{fontSize:11, color:FAINT}}>Redeem for free rounds</span>
                  </div>
                  <div style={{padding:"16px 20px 20px", display:"flex", flexDirection:"column", gap:10}}>
                    <div style={{position:"relative"}}>
                      <input type="text" value={code} placeholder="XXXX-XXXX" maxLength={9} autoComplete="off" spellCheck={false}
                        onChange={e=>formatCode(e.target.value)}
                        onFocus={()=>setShowCursor(false)}
                        onBlur={()=>{if(!code)setShowCursor(true);}}
                        onKeyDown={e=>e.key==="Enter"&&redeemCode()}
                        style={{width:"100%", background:"rgba(6,11,28,0.7)", border:`1px solid ${codeError?"rgba(255,107,94,0.55)":"rgba(148,178,255,0.14)"}`, borderRadius:14, padding:"12px", fontFamily:BALOO, fontSize:22, fontWeight:700, color:TXT, textAlign:"center", letterSpacing:6, outline:"none", display:"block", caretColor:ACCENT}}/>
                      {showCursor&&!code&&(
                        <div style={{position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", width:2, height:22, background:ACCENT, animation:"caretBlink 1s step-end infinite", pointerEvents:"none"}}/>
                      )}
                    </div>
                    {codeError&&<div style={{fontSize:11, color:"#FF6B5E", textAlign:"center"}}>{codeError}</div>}
                    <button onClick={redeemCode} disabled={codeLoading} className="cta-pill" style={{...CTA, opacity:codeLoading?0.7:1}}>
                      {codeLoading?"VERIFYING...":"REDEEM CODE"}
                    </button>
                    <div style={{display:"flex", alignItems:"center", gap:10}}>
                      <div style={{flex:1, height:1, background:"rgba(148,178,255,0.08)"}}/>
                      <span style={{fontFamily:MONO, fontSize:9, color:FAINT, letterSpacing:2}}>OR</span>
                      <div style={{flex:1, height:1, background:"rgba(148,178,255,0.08)"}}/>
                    </div>
                    <button onClick={()=>router.push("/play")} className="ghost-pill" style={{width:"100%", fontFamily:MONO, fontSize:10, fontWeight:600, padding:"14px 16px", borderRadius:999, border:"1px solid rgba(148,178,255,0.12)", background:"rgba(148,178,255,0.06)", color:MUTED, cursor:"pointer", letterSpacing:1.5, transition:"border-color 0.2s,color 0.2s"}}>PLACE WITH USDC →</button>
                  </div>
                </>
              ) : (
                <div style={{padding:"26px 20px", display:"flex", flexDirection:"column", alignItems:"center", gap:12, textAlign:"center"}}>
                  <div style={{width:48, height:48, borderRadius:"50%", background:"rgba(62,139,255,0.1)", border:"2px solid rgba(62,139,255,0.45)", display:"flex", alignItems:"center", justifyContent:"center"}}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round"><path d="M5 13l4 4L19 7"/></svg>
                  </div>
                  <div style={{fontFamily:MONO, fontSize:12, fontWeight:700, letterSpacing:3, color:TXT}}>CODE ACTIVATED</div>
                  <div style={{display:"flex", alignItems:"center", gap:14, background:"rgba(62,139,255,0.08)", border:"1px solid rgba(62,139,255,0.22)", borderRadius:16, padding:"12px 22px"}}>
                    <span style={{fontFamily:BALOO, fontSize:40, fontWeight:800, color:ACCENT, lineHeight:1}}>2</span>
                    <span style={{fontFamily:MONO, fontSize:10, color:MUTED, letterSpacing:1, lineHeight:1.6, textAlign:"left"}}>FREE<br/>ROUNDS<br/>CREDITED</span>
                  </div>
                  <button onClick={()=>router.push("/play")} className="cta-pill" style={CTA}>STAKE A SQUARE ◎</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── TILE STATES + WINNER REVEAL ── */}
      <section className="sec-pad" style={{position:"relative", zIndex:5, padding:"12px 20px 56px", maxWidth:1080, margin:"0 auto"}}>
        <div className="states-band">
          <div className="state-card" style={{...CARD, padding:"20px 22px", display:"flex", flexDirection:"column", gap:18}}>
            <div style={{fontFamily:MONO, fontSize:10, fontWeight:700, letterSpacing:3, color:MUTED}}>TILE STATES</div>
            <div className="tile-states-grid" style={{display:"grid", gridTemplateColumns:"repeat(5,minmax(0,1fr))", gap:12, alignItems:"end"}}>
              {[["EMPTY","empty"],["HOVER","hover"],["SELECTED","selected"],["MISS","miss"],["WIN","win"]].map(([label,state])=>(
                <div key={label} style={{display:"flex", flexDirection:"column", alignItems:"center", gap:10, minWidth:0}}>
                  <Keycap state={state} style={{width:"100%", maxWidth:64}} glyphSize={18}/>
                  <span className="tile-lbl" style={{fontFamily:MONO, fontSize:8.5, letterSpacing:1.5, color:FAINT, textAlign:"center"}}>{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="state-card" style={{...CARD, padding:"20px 22px", display:"flex", flexDirection:"column", gap:18}}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:10}}>
              <span style={{fontFamily:MONO, fontSize:10, fontWeight:700, letterSpacing:3, color:MUTED}}>WINNER REVEAL</span>
              <span style={{fontFamily:MONO, fontSize:8.5, letterSpacing:1.5, color:FAINT, border:"1px solid rgba(148,178,255,0.12)", borderRadius:999, padding:"3px 9px"}}>SIMULATION</span>
            </div>
            <div style={{display:"flex", alignItems:"center", gap:22, flexWrap:"wrap", justifyContent:"center"}}>
              <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6, width:"min(164px,44vw)", flexShrink:0}}>
                {Array.from({length:16}).map((_,i)=>(
                  <Keycap key={i} state={i===5?"win":"miss"} glyphSize={i===5?15:11} style={i===5?{animation:"winPulse 1.5s ease-in-out infinite"}:undefined}/>
                ))}
              </div>
              <div style={{display:"flex", flexDirection:"column", gap:6, minWidth:150, textAlign:"center", flex:1}}>
                <div style={{fontFamily:MONO, fontSize:12, fontWeight:700, letterSpacing:3, color:TXT}}>YOU WON!</div>
                <div style={{fontFamily:BALOO, fontSize:34, fontWeight:800, color:ACCENT, lineHeight:1.1, textShadow:"0 0 24px rgba(62,139,255,0.4)"}}>$3.60</div>
                <div style={{fontSize:11.5, color:MUTED, lineHeight:1.6}}>Congrats — you hit the square. Winners are auto-paid on resolve.</div>
                <div style={{fontFamily:MONO, fontSize:8.5, letterSpacing:1.5, color:FAINT}}>PRIZE = 90% OF POT</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Divider/>

      {/* ── HOW IT WORKS ── */}
      <section id="how-section" className="sec-pad" style={{position:"relative", zIndex:5, padding:"60px 20px", maxWidth:1080, margin:"0 auto"}}>
        <div style={{textAlign:"center", marginBottom:40}}>
          <div style={{fontFamily:MONO, fontSize:10, letterSpacing:3, color:ACCENT, fontWeight:700, marginBottom:10}}>HOW IT WORKS</div>
          <div style={{fontFamily:BALOO, fontSize:28, fontWeight:700, color:TXT}}>Four Steps to Win</div>
        </div>
        <div className="steps-grid">
          {[
            {n:"01",icon:"🔐",t:"LOGIN",d:"Sign in with email, Google, or wallet. Privy creates an embedded wallet instantly — no seed phrase needed."},
            {n:"02",icon:"⬡",t:"STAKE A CELL",d:"Place any amount of USDC (min $0.10) on any squares. Multiple players can stake the same square — the prize splits pro-rata to what each put in."},
            {n:"03",icon:"🎲",t:"DRAND BEACON",d:"When the 60s round ends, the drand beacon pinned at round start is emitted. Its BLS signature is verified on-chain and draws the winner from occupied cells only."},
            {n:"04",icon:"💰",t:"GET PAID",d:"Winners are paid automatically during resolution. No claim step — USDC goes straight to your wallet, pro-rata to what you put on the winning square."},
          ].map(({n,icon,t,d})=>(
            <div key={n} style={{...CARD, borderRadius:18, padding:22, display:"flex", flexDirection:"column", gap:10}}>
              <span style={{fontFamily:MONO, fontSize:9, fontWeight:700, color:ACCENT_LIGHT, background:"rgba(62,139,255,0.1)", border:"1px solid rgba(62,139,255,0.18)", borderRadius:999, padding:"3px 9px", display:"inline-block", letterSpacing:1.5, alignSelf:"flex-start"}}>{n}</span>
              <div style={{fontSize:20}}>{icon}</div>
              <div style={{fontFamily:MONO, fontSize:11, fontWeight:700, color:TXT, letterSpacing:2}}>{t}</div>
              <div style={{fontSize:12, color:MUTED, lineHeight:1.7}}>{d}</div>
            </div>
          ))}
        </div>
      </section>

      <Divider/>

      {/* ── MECHANICS ── */}
      <section className="sec-pad" style={{position:"relative", zIndex:5, padding:"60px 20px", maxWidth:1080, margin:"0 auto"}}>
        <div style={{textAlign:"center", marginBottom:40}}>
          <div style={{fontFamily:MONO, fontSize:10, letterSpacing:3, color:ACCENT, fontWeight:700, marginBottom:10}}>GAME MECHANICS</div>
          <div style={{fontFamily:BALOO, fontSize:28, fontWeight:700, color:TXT}}>Know the Rules</div>
        </div>
        <div className="two-col-grid">
          <MechCard title="PAYOUT MATH">
            <p style={{fontSize:12, color:MUTED, lineHeight:1.75, margin:0}}>Every stake goes into the pot. A 10% protocol fee is deducted — that is the only cut — and the remaining 90% goes to stakers on the winning cell, split pro-rata to how much each staked. The resolver tip is paid out of the fee, never on top of it.</p>
            <div style={{background:"rgba(6,11,28,0.7)", border:"1px solid rgba(148,178,255,0.1)", borderRadius:12, padding:"12px 14px", fontFamily:MONO, fontSize:11, color:FAINT, lineHeight:1.9}}>
              pool = <b style={{color:ACCENT_LIGHT}}>sum of all stakes</b><br/>
              fee = pool × <b style={{color:ACCENT_LIGHT}}>10%</b><br/>
              prize = pool − fee  <b style={{color:ACCENT_LIGHT}}>(= 90% of pot)</b><br/>
              your cut = prize × <b style={{color:ACCENT_LIGHT}}>your stake ÷ cell total</b>
            </div>
          </MechCard>
          <MechCard title="STRATEGY">
            <p style={{fontSize:12, color:MUTED, lineHeight:1.75, margin:0}}>A cell wins with probability equal to its share of the pot, and the prize splits by stake — so every dollar has the same expected value. Bet big for a bigger share, or spread across cells.</p>
            <div style={{background:"rgba(6,11,28,0.7)", border:"1px solid rgba(148,178,255,0.1)", borderRadius:12, padding:"12px 14px", fontFamily:MONO, fontSize:11, color:FAINT, lineHeight:1.9}}>
              <span style={{color:FAINT}}>{`// pot $1.00; winning cell holds $0.40`}</span><br/>
              prize ≈ <b style={{color:ACCENT_LIGHT}}>$0.90</b><br/>
              you staked <b style={{color:ACCENT_LIGHT}}>$0.10</b> of that $0.40<br/>
              you get = <b style={{color:ACCENT_LIGHT}}>$0.225</b> (25% of cell)
            </div>
          </MechCard>
        </div>
      </section>

      <Divider/>

      {/* ── PROVABLY FAIR ── */}
      <section className="sec-pad" style={{position:"relative", zIndex:5, padding:"60px 20px", maxWidth:1080, margin:"0 auto"}}>
        <div className="fair-card" style={{...CARD, padding:"34px 30px", display:"flex", flexDirection:"column", gap:32}}>
          <div style={{display:"flex", flexDirection:"column", gap:14}}>
            <div style={{fontFamily:MONO, fontSize:10, letterSpacing:3, color:ACCENT, fontWeight:700}}>PROVABLY FAIR</div>
            <div style={{fontFamily:BALOO, fontSize:24, fontWeight:700, color:TXT, lineHeight:1.3}}>Distributed Randomness Every Round</div>
            <div style={{fontSize:12.5, color:MUTED, lineHeight:1.8}}>Every winner is drawn from a drand beacon — randomness produced by the League of Entropy&apos;s distributed network. The beacon for each round doesn&apos;t exist until after betting closes, and the game contract verifies its BLS signature itself. Nobody — not even the resolver — can bias the outcome.</div>
            <div style={{display:"flex", flexWrap:"wrap", gap:6}}>
              {["DRAND EVMNET","BLS BN254","3S BEACONS","VERIFIED ON-CHAIN","LEAGUE OF ENTROPY"].map(p=><span key={p} style={{fontFamily:MONO, fontSize:9, padding:"4px 10px", borderRadius:999, fontWeight:700, letterSpacing:1, background:"rgba(62,139,255,0.1)", color:ACCENT_LIGHT, border:"1px solid rgba(62,139,255,0.2)"}}>{p}</span>)}
            </div>
          </div>
          <div style={{display:"flex", flexDirection:"column", gap:4}}>
            {ZK_STEPS.map((label,i)=>{
              const done=i<zkStep,active=i===zkStep;
              return (
                <div key={i}>
                  <div style={{display:"flex", alignItems:"center", gap:10, padding:"9px 14px", borderRadius:12, border:`1px solid ${active?"rgba(62,139,255,0.28)":done?"rgba(62,139,255,0.14)":"transparent"}`, background:active?"rgba(62,139,255,0.08)":done?"rgba(62,139,255,0.04)":"transparent", transition:"all 0.3s"}}>
                    <div style={{width:7, height:7, borderRadius:"50%", flexShrink:0, background:active?ACCENT:done?ACCENT:"rgba(62,139,255,0.18)", boxShadow:active?"0 0 8px rgba(62,139,255,0.8)":"none", animation:active?"pulse 1.5s ease-in-out infinite":"none"}}/>
                    <span style={{fontFamily:MONO, fontSize:11, color:active?ACCENT_LIGHT:done?MUTED:FAINT, fontWeight:active||done?600:400}}>{label}</span>
                  </div>
                  {i<ZK_STEPS.length-1&&<div style={{width:1, height:8, background:"rgba(62,139,255,0.15)", marginLeft:18}}/>}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="sec-pad" style={{display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12, padding:"18px 24px", borderTop:"1px solid rgba(148,178,255,0.08)", background:"rgba(6,11,28,0.95)", zIndex:10, position:"relative"}}>
        <div style={{display:"flex", alignItems:"center", gap:8}}>
          <GriddyMark size={18}/>
          <span style={{fontFamily:BALOO, fontSize:13, fontWeight:800, color:"#F4F7FF", letterSpacing:1}}>GRIDDY</span>
        </div>
        <div style={{display:"flex", gap:14, alignItems:"center", flexWrap:"wrap"}}>
          {process.env.NEXT_PUBLIC_GRIDDY_ADDR && (
            <a href={`https://testnet.arcscan.app/address/${process.env.NEXT_PUBLIC_GRIDDY_ADDR}`} target="_blank" rel="noopener noreferrer" className="foot-link" style={{fontFamily:MONO, fontSize:10, color:FAINT, textDecoration:"none", letterSpacing:1.5, transition:"color 0.2s", padding:"15px 8px", margin:"-15px -8px"}}>CONTRACT</a>
          )}
          <a href="https://drand.love" target="_blank" rel="noopener noreferrer" className="foot-link" style={{fontFamily:MONO, fontSize:10, color:FAINT, textDecoration:"none", letterSpacing:1.5, transition:"color 0.2s", padding:"15px 8px", margin:"-15px -8px"}}>DRAND</a>
        </div>
        <div style={{fontFamily:MONO, fontSize:9, color:FAINT, letterSpacing:2}}>SIMPLE GAME. REAL STAKES. ONCHAIN.</div>
      </footer>

      <style>{`
        *{box-sizing:border-box}
        @keyframes cellAppear{from{opacity:0;transform:scale(0.9)}to{opacity:1;transform:scale(1)}}
        @keyframes winPulse{0%,100%{box-shadow:0 5px 14px rgba(0,0,0,0.45),0 0 14px rgba(62,139,255,0.45)}50%{box-shadow:0 5px 14px rgba(0,0,0,0.45),0 0 30px rgba(62,139,255,0.85)}}
        @keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 4px rgba(62,139,255,0.7)}50%{opacity:0.4;box-shadow:0 0 10px rgba(62,139,255,0.9)}}
        @keyframes caretBlink{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes navGlow{0%,100%{text-shadow:0 0 6px rgba(62,139,255,0.5)}50%{text-shadow:0 0 14px rgba(62,139,255,0.9)}}
        .nav-btn-home:hover{color:#3E8BFF!important}
        .nav-btn-play-hp:hover{color:#6FB0FF!important}
        .cta-pill:hover{filter:brightness(1.08)}
        .ghost-pill:hover{border-color:rgba(62,139,255,0.4)!important;color:#EAF1FF!important}
        .foot-link:hover{color:#6FB0FF!important}
        .kc-empty:hover{border-color:rgba(62,139,255,0.8)!important}
        .kc-empty:hover .kc-dot{background:#3E8BFF!important}
        input::placeholder{color:#2E3F66}
        .hero-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;align-items:start}
        .states-band{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:20px;align-items:stretch}
        .steps-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
        .two-col-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
        @media(max-width:920px){
          .hero-cols{grid-template-columns:minmax(0,1fr);max-width:min(480px,100%);margin:0 auto}
          .states-band{grid-template-columns:minmax(0,1fr)}
          .steps-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
        }
        @media(max-width:700px){
          .two-col-grid{grid-template-columns:minmax(0,1fr)}
        }
        @media(max-width:480px){
          .sec-pad{padding-left:14px!important;padding-right:14px!important}
          .hero-tag{letter-spacing:2px!important}
          .state-card{padding:16px 14px!important}
          .tile-states-grid{gap:8px!important}
          .tile-lbl{font-size:7.5px!important;letter-spacing:1px!important}
          .fair-card{padding:24px 18px!important}
        }
        @media(max-width:460px){
          .steps-grid{grid-template-columns:minmax(0,1fr)}
        }
      `}</style>
    </div>
  );
}
