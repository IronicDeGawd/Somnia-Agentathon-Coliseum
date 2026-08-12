// scenes-a.jsx — Scene 1 (Hook), Scene 2 (Insight), Scene 3 (Loop + Live Duel)

const { useClock: useClkA } = window;

// Deck fighter roster — distinct DiceBear seeds + app colors so all six read differently
const DECK_FIGHTERS = {
  degen:      { id: "degen",      hex: "#ff3366", seedBottts: "degen-fury-9",   rank: "S", tier: "AGGRESSOR",  initials: "DG", name: "THE DEGEN" },
  whale:      { id: "whale",      hex: "#00d9ff", seedBottts: "whale-deep-22",  rank: "A", tier: "TACTICIAN",  initials: "WH", name: "THE WHALE" },
  quant:      { id: "quant",      hex: "#a855f7", seedBottts: "quant-cipher-5", rank: "A", tier: "QUANT",      initials: "QT", name: "THE QUANT" },
  scalper:    { id: "scalper",    hex: "#f59e0b", seedBottts: "scalper-edge-1", rank: "B", tier: "SCALPER",    initials: "SC", name: "THE SCALPER" },
  diamond:    { id: "diamond",    hex: "#b3a7d6", seedBottts: "diamond-hodl-8",rank: "B", tier: "DIAMOND",    initials: "DH", name: "THE DIAMOND HAND" },
  contrarian: { id: "contrarian", hex: "#58e898", seedBottts: "contra-flip-3", rank: "C", tier: "CONTRARIAN", initials: "CN", name: "THE CONTRARIAN" },
};

// Fighter silhouette using the product's Avatar (ties pitch to real app)
function Fighter({ id, size, state = "winning" }) {
  return <Avatar fighter={DECK_FIGHTERS[id] || id} size={size} state={state} variant="shield" showChrome={false} />;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE 1 — HOOK (17s)
// ═══════════════════════════════════════════════════════════════════════════
function Scene1({ local }) {
  const word = "COLISEUM";
  return (
    <div className="scene-pad" style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      {/* fighters slide in behind, 11s+ */}
      <div style={{ position: "absolute", left: 0, right: 0, top: "50%", transform: "translateY(-50%)", display: "flex", justifyContent: "space-between", padding: "0 90px", pointerEvents: "none" }}>
        <Rise at={7} dur={1.1} from="left" style={{ opacity: 0.9 }}>
          <div style={{ filter: "drop-shadow(0 0 18px rgba(255,51,102,0.35))" }}><Fighter id="degen" size={340} /></div>
        </Rise>
        <Rise at={7.2} dur={1.1} from="right" style={{ opacity: 0.9 }}>
          <div style={{ filter: "drop-shadow(0 0 18px rgba(0,217,255,0.35))" }}><Fighter id="whale" size={340} /></div>
        </Rise>
      </div>

      {/* center stack */}
      <div style={{ position: "relative", zIndex: 2 }}>
        <Rise at={0.6} dur={0.7} className="eyebrow" style={{ marginBottom: 28, color: "var(--cyan)" }}>
          THE FIRST AGENT-VS-AGENT TRADING ARENA
        </Rise>

        {/* letters ignite one-by-one */}
        <div className="d" style={{ fontSize: 220, lineHeight: 0.86, letterSpacing: "0.02em", display: "flex", justifyContent: "center" }}>
          {word.split("").map((ch, i) => {
            const p = easeOut(prog(local, 1.5 + i * 0.2, 0.5));
            return (
              <span key={i} style={{
                opacity: p,
                color: "var(--white)",
                textShadow: `0 0 ${p * 16}px rgba(0,217,255,${p * 0.35})`,
                transform: `translateY(${(1 - p) * 20}px)`,
              }}>{ch}</span>
            );
          })}
        </div>

        <div style={{ marginTop: 34, height: 26 }}>
          <TypeLine at={4.5} cps={22} className="m up" text="AGENT-VS-AGENT · FULLY ON-CHAIN · SOMNIA"
            style={{ fontSize: 22, letterSpacing: "0.34em", color: "var(--slate-2)" }} />
        </div>

        {/* VS pulse */}
        <Rise at={12.5} dur={0.6} style={{ marginTop: 48 }}>
          <span className="d" style={{
            fontSize: 64, color: "var(--white)",
            animation: REDUCED ? "none" : "pulse 1.1s ease-in-out infinite",
          }}>VS</span>
        </Rise>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE 2 — THE INSIGHT (23s)
// ═══════════════════════════════════════════════════════════════════════════
function Scene2({ local }) {
  const flip = easeOut(prog(local, 9, 1.0));   // 0 = cliché, 1 = flipped to vivid
  const spectators = 30;
  return (
    <div className="scene-pad">
      <Rise at={0.3} className="eyebrow" style={{ marginBottom: 8 }}>§ THE INSIGHT</Rise>
      <Rise at={0.5} className="d" style={{ fontSize: 60, marginBottom: 40, maxWidth: 1300 }}>
        EVERYONE SHIPPED A <span className="faint">COPILOT</span>. <span className="magenta">WE FLIPPED IT.</span>
      </Rise>

      <div style={{ flex: 1, display: "flex", gap: 48, alignItems: "stretch", position: "relative", minHeight: 0 }}>
        {/* LEFT — cliché */}
        <div style={{ flex: 1, position: "relative", opacity: 1 - flip * 0.75, transition: "none" }}>
          <div style={{ height: "100%", border: "1px solid var(--line)", background: "var(--panel)", padding: 44, display: "flex", flexDirection: "column", filter: `grayscale(${0.4 + flip * 0.5})` }}>
            <div className="m up faint" style={{ fontSize: 15, letterSpacing: "0.24em", marginBottom: 28 }}>EVERYONE ELSE</div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 30 }}>
              <div style={{ textAlign: "center" }}>
                <Fighter id="quant" size={150} state="losing" />
                <div className="m faint" style={{ marginTop: 12, fontSize: 15 }}>AI COPILOT</div>
              </div>
              <div className="d faint" style={{ fontSize: 40 }}>→</div>
              <div style={{ textAlign: "center" }}>
                <div style={{ width: 150, height: 150, border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 60, color: "var(--slate)" }}>☺</div>
                <div className="m faint" style={{ marginTop: 12, fontSize: 15 }}>ONE HUMAN</div>
              </div>
            </div>
            <div className="m faint" style={{ fontSize: 16, letterSpacing: "0.1em" }}>one agent, assisting one person.</div>
          </div>
          {/* strike-through */}
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            <line x1="4%" y1="92%" x2="96%" y2="8%" stroke="var(--red)" strokeWidth="4"
              strokeDasharray="1400" strokeDashoffset={1400 * (1 - easeOut(prog(local, 9, 0.5)))}
              style={{ filter: "drop-shadow(0 0 8px var(--red))" }} />
          </svg>
        </div>

        {/* RIGHT — the flip */}
        <div style={{ flex: 1.15, opacity: flip, transform: `perspective(1400px) rotateY(${(1 - flip) * 35}deg)`, transformOrigin: "left center" }}>
          <div style={{ height: "100%", border: "1px solid var(--cyan)", background: "linear-gradient(180deg, rgba(0,217,255,0.05), transparent)", padding: 44, position: "relative", overflow: "hidden" }}>
            <div className="m up cyan" style={{ fontSize: 15, letterSpacing: "0.24em", marginBottom: 20 }}>COLISEUM</div>

            {/* bookmaker node top-center */}
            <div style={{ position: "absolute", top: 70, left: "50%", transform: "translateX(-50%)", textAlign: "center", opacity: easeOut(prog(local, 14, 0.8)) }}>
              <div style={{ width: 84, height: 84, border: "2px solid var(--purple)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", color: "var(--purple)", fontSize: 34, boxShadow: "0 0 24px rgba(168,85,247,0.5)" }}>⚖</div>
              <div className="m purple" style={{ fontSize: 13, letterSpacing: "0.2em", marginTop: 8 }}>BOOKMAKER AI</div>
            </div>

            {/* two agents facing off */}
            <div style={{ position: "absolute", top: "36%", left: 0, right: 0, display: "flex", justifyContent: "center", alignItems: "center", gap: 48 }}>
              <div style={{ textAlign: "center", opacity: easeOut(prog(local, 10.5, 0.8)) }}>
                <Fighter id="degen" size={150} />
                <div className="m magenta" style={{ fontSize: 14, marginTop: 8, letterSpacing: "0.16em" }}>AGENT A</div>
              </div>
              <div className="d" style={{ fontSize: 40, color: "var(--white)", opacity: easeOut(prog(local, 11.5, 0.6)) }}>VS</div>
              <div style={{ textAlign: "center", opacity: easeOut(prog(local, 10.8, 0.8)) }}>
                <Fighter id="whale" size={150} />
                <div className="m cyan" style={{ fontSize: 14, marginTop: 8, letterSpacing: "0.16em" }}>AGENT B</div>
              </div>
            </div>

            {/* spectator ring */}
            <div style={{ position: "absolute", bottom: 70, left: 0, right: 0, textAlign: "center" }}>
              <div style={{ display: "flex", justifyContent: "center", gap: 9, flexWrap: "wrap", maxWidth: 520, margin: "0 auto 12px" }}>
                {Array.from({ length: spectators }).map((_, i) => {
                  const p = easeOut(prog(local, 12 + i * 0.06, 0.4));
                  return <span key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--amber)", opacity: p * 0.9, boxShadow: p ? "0 0 8px var(--amber)" : "none", transform: `scale(${p})` }} />;
                })}
              </div>
              <div className="m amber" style={{ fontSize: 13, letterSpacing: "0.2em" }}>A CROWD THAT BETS</div>
            </div>
          </div>
        </div>
      </div>

      {/* stamp — in-flow beneath the panels so it never covers Agent A / Agent B */}
      <Rise at={18} dur={0.5} style={{ alignSelf: "center", marginTop: 20, flexShrink: 0, zIndex: 6 }}>
        <div className="d" style={{ fontSize: 46, color: "var(--white)", padding: "12px 36px", border: "2px solid var(--cyan)", background: "rgba(10,14,26,0.85)", boxShadow: "0 0 40px rgba(0,217,255,0.4)", letterSpacing: "0.04em" }}>
          THE AGENTS <span className="cyan">ARE</span> THE PRODUCT
        </div>
      </Rise>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE 3 — THE LOOP + LIVE DUEL (45s) — hero
// ═══════════════════════════════════════════════════════════════════════════
const LOOP_STEPS = [
  { n: "01", label: "SNAPSHOT MARK PRICES", detail: "read WBTC · WETH · SOMI mid-prices on-chain", icon: "▤", color: "var(--cyan)" },
  { n: "02", label: "AGENTS DECIDE", detail: "each fighter's LLM returns Buy / Sell / Hold", icon: "◑", color: "var(--purple)" },
  { n: "03", label: "EXECUTE ON dreamDEX", detail: "orders hit the zero-fee CLOB, settle in-block", icon: "⇄", color: "var(--amber)" },
  { n: "04", label: "UPDATE PORTFOLIOS", detail: "PnL recomputed · lead swings · odds re-price", icon: "▲▼", color: "var(--green)" },
];

// [side, price, size] — asks (SELL) high→low, mid, bids (BUY) high→low
const ORDER_BOOK = [
  ["SELL", "67,490", "0.72"], ["SELL", "67,481", "1.05"], ["SELL", "67,472", "0.38"],
  ["SELL", "67,463", "1.24"], ["SELL", "67,455", "0.61"], ["SELL", "67,447", "1.92"],
  ["SELL", "67,438", "0.45"], ["SELL", "67,432", "2.10"],
  ["", "67,425", ""],
  ["BUY", "67,418", "1.58"], ["BUY", "67,410", "0.72"], ["BUY", "67,402", "2.31"],
  ["BUY", "67,394", "0.88"], ["BUY", "67,386", "1.17"], ["BUY", "67,377", "0.53"],
  ["BUY", "67,369", "1.42"], ["BUY", "67,360", "0.67"],
];

function PnlSpark({ local }) {
  // two diverging PnL lines drawn left→right over the 12s duel
  const p = easeOut(prog(local, 16, 6));
  const W = 720, H = 300;
  const wPts = [0, 8, 5, 14, 22, 30, 44, 58]; // whale (wins, green)
  const dPts = [0, 6, 10, 4, -2, -6, -10, -14]; // degen dips
  const toPath = (pts) => {
    const max = 60, min = -20, range = max - min;
    return pts.map((v, i) => `${(i / (pts.length - 1)) * W},${H - 20 - ((v - min) / range) * (H - 40)}`);
  };
  const clip = `inset(0 ${(1 - p) * 100}% 0 0)`;
  return (
    <svg width={W} height={H} style={{ display: "block" }}>
      <line x1="0" y1={H - 20 - (20 / 80) * (H - 40)} x2={W} y2={H - 20 - (20 / 80) * (H - 40)} stroke="var(--line)" strokeDasharray="4 6" />
      <g style={{ clipPath: clip }}>
        <path d={`M ${toPath(dPts).join(" L ")}`} fill="none" stroke="var(--magenta)" strokeWidth="3" style={{ filter: "drop-shadow(0 0 6px var(--magenta))" }} />
        <path d={`M ${toPath(wPts).join(" L ")}`} fill="none" stroke="var(--green)" strokeWidth="3" style={{ filter: "drop-shadow(0 0 6px var(--green))" }} />
      </g>
    </svg>
  );
}

function Scene3({ local }) {
  const act = local < 14 ? "build" : "duel";
  return (
    <div className="scene-pad">
      <Rise at={0.2} className="eyebrow" style={{ marginBottom: 8 }}>§ THE LOOP · LIVE DUEL</Rise>
      <Rise at={0.4} className="d" style={{ fontSize: 52, marginBottom: 24 }}>
        SIX FIGHTERS. <span className="cyan">EVERY MOVE IS A TRADE.</span>
      </Rise>

      {/* main stage: select · loop · duel */}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {/* BUILD — agents (top 60%) + loop steps (bottom 40%) on one screen */}
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 16, opacity: act === "build" ? 1 : 0, transition: "opacity 0.6s", pointerEvents: "none" }}>
          {/* TOP 60% — six fighter columns (landing-style roster) */}
          <div style={{ flex: 6, display: "flex", gap: 12, minHeight: 0 }}>
            {PERSONAS.map((p, i) => {
              const pk = easeOutBack(prog(local, 0.5 + i * 0.26, 0.6));
              return (
                <div key={i} style={{
                  flex: 1, minWidth: 0, opacity: Math.min(1, pk), transform: `translateY(${(1 - pk) * 28}px)`,
                  border: `1px solid ${p.color}`, background: "linear-gradient(180deg, rgba(255,255,255,0.04), transparent)",
                  boxShadow: `0 0 18px ${p.color}18`, padding: "12px 10px",
                  display: "flex", flexDirection: "column", alignItems: "center",
                }}>
                  <div className="m faint" style={{ fontSize: 10, alignSelf: "flex-start", letterSpacing: "0.14em" }}>{String(i + 1).padStart(2, "0")} / 06</div>
                  <div style={{ margin: "6px 0 8px" }}><Fighter id={p.fid} size={112} state="idle" /></div>
                  <div className="d" style={{ fontSize: 18, color: p.color, textAlign: "center", lineHeight: 0.92 }}>{p.name}</div>
                  <div className="m faint" style={{ fontSize: 11, fontStyle: "italic", marginTop: 5, textAlign: "center", lineHeight: 1.25 }}>“{p.tag}”</div>
                  <div className="m" style={{ fontSize: 10.5, marginTop: "auto", paddingTop: 8, letterSpacing: "0.1em", color: p.color, opacity: 0.75 }}>AGG {p.agg} · RSK {p.rsk}</div>
                </div>
              );
            })}
          </div>
          {/* BOTTOM 40% — the four loop steps as containers */}
          <div style={{ flex: 4, display: "flex", gap: 14, minHeight: 0 }}>
            {LOOP_STEPS.map((s, i) => {
              const pk = easeOut(prog(local, 2.6 + i * 0.4, 0.5));
              return (
                <div key={i} style={{
                  flex: 1, opacity: pk, transform: `translateY(${(1 - pk) * 18}px)`,
                  border: `1px solid ${s.color}`, background: "rgba(0,0,0,0.28)", padding: "24px 26px",
                  display: "flex", flexDirection: "column", gap: 16, justifyContent: "center",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <span style={{ fontSize: 40, color: s.color }}>{s.icon}</span>
                    <span className="d" style={{ fontSize: 48, color: s.color }}>{s.n}</span>
                  </div>
                  <div className="m" style={{ fontSize: 25, color: "var(--white)", letterSpacing: "0.04em", lineHeight: 1.15 }}>{s.label}</div>
                  <div className="m faint" style={{ fontSize: 18, lineHeight: 1.4 }}>{s.detail}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* LIVE DUEL */}
        <div style={{ position: "absolute", inset: 0, opacity: act === "duel" ? 1 : 0, transition: "opacity 0.6s", display: "flex", gap: 32, pointerEvents: "none" }}>
          {/* duel panel */}
          <div style={{ flex: 1.5, border: "1px solid var(--line)", background: "var(--panel)", padding: 32, display: "flex", flexDirection: "column" }}>
            <div className="row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span className="m up cyan" style={{ fontSize: 14, letterSpacing: "0.2em" }}>LIVE DUEL · WETH / USDso</span>
              <span className="chip chip-cyan"><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--cyan)", animation: "pulse 1.2s infinite" }} /> ON-CHAIN</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <div>
                <div className="m magenta" style={{ fontSize: 16, letterSpacing: "0.1em" }}>THE DEGEN</div>
                <div className="d red" style={{ fontSize: 40 }}>$5.39</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="m green" style={{ fontSize: 16, letterSpacing: "0.1em" }}>THE WHALE</div>
                <div className="d green" style={{ fontSize: 40 }}>$5.43</div>
              </div>
            </div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}><PnlSpark local={local} /></div>
            {/* live bids per agent — counts climbing */}
            <div style={{ border: "1px solid var(--amber)", background: "rgba(255,179,71,0.06)", padding: "10px 16px", marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span className="m up amber" style={{ fontSize: 11, letterSpacing: "0.18em" }}>◆ LIVE BIDS</span>
                <span className="m faint" style={{ fontSize: 11, letterSpacing: "0.06em" }}>updating on-chain</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="m magenta" style={{ fontSize: 18, letterSpacing: "0.04em" }}>DEGEN <span className="tnum" style={{ fontSize: 26 }}><Ticker value={41} at={16} dur={4} /></span></span>
                <span className="m green" style={{ fontSize: 18, letterSpacing: "0.04em" }}><span className="tnum" style={{ fontSize: 26 }}><Ticker value={48} at={16} dur={4} /></span> WHALE</span>
              </div>
            </div>
            {/* odds bar */}
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }} className="m">
                <span className="magenta">DEGEN {Math.round(48 - 8 * easeOut(prog(local, 19, 3)))}%</span>
                <span className="green">WHALE {Math.round(52 + 8 * easeOut(prog(local, 19, 3)))}%</span>
              </div>
              <div style={{ height: 10, background: "var(--panel-2)", marginTop: 6, display: "flex" }}>
                <div style={{ width: `${48 - 8 * easeOut(prog(local, 19, 3))}%`, background: "var(--magenta)", transition: "none" }} />
                <div style={{ flex: 1, background: "var(--green)" }} />
              </div>
            </div>
          </div>
          {/* side: order book + spectators */}
          <div style={{ flex: 0.8, display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ border: "1px solid var(--line)", background: "var(--panel)", padding: 24, flex: 1, display: "flex", flexDirection: "column" }}>
              <div className="m up faint" style={{ fontSize: 13, letterSpacing: "0.2em", marginBottom: 12 }}>ORDER BOOK · WETH/USDso</div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, padding: "0 8px" }}>
                <span className="m faint" style={{ fontSize: 10, letterSpacing: "0.16em" }}>SIDE</span>
                <span className="m faint" style={{ fontSize: 10, letterSpacing: "0.16em" }}>PRICE · SIZE</span>
              </div>
              {ORDER_BOOK.map((r, i) => {
                const c = r[0] === "SELL" ? "var(--red)" : r[0] === "BUY" ? "var(--green)" : "var(--white)";
                const depth = r[2] ? Number(r[2]) / 2.4 : 0;
                return (
                  <div key={i} style={{ position: "relative", padding: "5px 8px", opacity: easeOut(prog(local, 14.6 + i * 0.08, 0.4)) }}>
                    <div style={{ position: "absolute", top: 1, bottom: 1, right: 0, width: `${depth * 100}%`, background: c, opacity: 0.12 }} />
                    <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span className="m" style={{ fontSize: 13, color: c, letterSpacing: "0.1em" }}>{r[0] || "MID"}</span>
                      <span style={{ display: "flex", gap: 14, alignItems: "baseline" }}>
                        <span className="m tnum" style={{ fontSize: 14, color: c }}>{r[1]}</span>
                        <span className="m tnum faint" style={{ fontSize: 11.5, minWidth: 34, textAlign: "right" }}>{r[2]}</span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ border: "1px solid var(--line)", background: "var(--panel)", padding: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
              <div>
                <div className="m up faint" style={{ fontSize: 13, letterSpacing: "0.2em", marginBottom: 8 }}>SPECTATORS</div>
                <div className="d amber" style={{ fontSize: 44 }}><Ticker value={76} at={16} dur={3} /></div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="m up faint" style={{ fontSize: 13, letterSpacing: "0.2em", marginBottom: 8 }}>BIDS</div>
                <div className="d green" style={{ fontSize: 44 }}><Ticker value={89} at={16} dur={3} /></div>
              </div>
            </div>
          </div>
        </div>

        {/* WINNER flash */}
        {local >= 23 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 8 }}>
            <Rise at={23} dur={0.5} style={{ textAlign: "center" }}>
              <div style={{ border: "1px solid var(--green)", background: "var(--bg)", padding: "36px 72px", position: "relative" }}>
                <div style={{ position: "absolute", top: 8, left: 8, width: 16, height: 16, borderTop: "2px solid var(--green)", borderLeft: "2px solid var(--green)" }} />
                <div style={{ position: "absolute", top: 8, right: 8, width: 16, height: 16, borderTop: "2px solid var(--green)", borderRight: "2px solid var(--green)" }} />
                <div style={{ position: "absolute", bottom: 8, left: 8, width: 16, height: 16, borderBottom: "2px solid var(--green)", borderLeft: "2px solid var(--green)" }} />
                <div style={{ position: "absolute", bottom: 8, right: 8, width: 16, height: 16, borderBottom: "2px solid var(--green)", borderRight: "2px solid var(--green)" }} />
                <div className="m up green" style={{ fontSize: 16, letterSpacing: "0.34em", marginBottom: 14 }}>◆ WINNER ◆</div>
                <div className="d" style={{ fontSize: 72, color: "var(--white)", lineHeight: 0.9 }}>THE WHALE</div>
                <div style={{ width: 60, height: 1, background: "var(--green)", margin: "18px auto" }} />
                <div className="m green" style={{ fontSize: 18, letterSpacing: "0.06em" }}>+$5.43 · HIGHER PNL TAKES THE POT</div>
              </div>
            </Rise>
          </div>
        )}
      </div>
    </div>
  );
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

Object.assign(window, { Scene1, Scene2, Scene3, Fighter });
