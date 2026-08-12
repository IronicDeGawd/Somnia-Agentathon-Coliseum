// scenes-b.jsx — Scene 4 (Proof / on-chain ledger), Scene 5 (Why Somnia), Scene 6 (Traction + close)

// ═══════════════════════════════════════════════════════════════════════════
// SCENE 4 — PROOF: REAL DeFi, NOT A GAME (13s) — short, punchy money beat
// ═══════════════════════════════════════════════════════════════════════════
function actionColor(a) {
  if (a.startsWith("BUY")) return "var(--green)";
  if (a.startsWith("SELL")) return "var(--red)";
  return "var(--slate)";
}

function LedgerRow({ tr, i, local, highlight }) {
  const appear = easeOut(prog(local, 1 + i * 0.045, 0.4));
  const ag = AGENTS[tr.agent];
  const hot = highlight;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "80px 150px 130px 1fr", gap: 20, alignItems: "center",
      padding: "9px 16px", borderBottom: "1px solid var(--line)",
      opacity: appear,
      background: hot ? "rgba(0,217,255,0.06)" : "transparent",
      borderLeft: hot ? `3px solid ${ag.color}` : "3px solid transparent",
    }}>
      <span className="m tnum faint" style={{ fontSize: 15 }}>#{tr.duel} · {tr.round}</span>
      <span className="m" style={{ fontSize: 15, color: ag.color, letterSpacing: "0.08em" }}>{ag.short}</span>
      <span className="m tnum" style={{ fontSize: 14, color: actionColor(tr.action), letterSpacing: "0.06em" }}>{tr.action}</span>
      <span className="m tnum cyan" style={{ fontSize: 15 }}>{shortHash(tr.hash)}</span>
    </div>
  );
}

function Scene4({ local }) {
  const verify = local >= 8;
  const d8 = new Set(DUEL8_TAPE.map(t => t.hash));
  // scroll offset for ledger: starts almost immediately
  const scrollP = easeOut(prog(local, 1.2, 6));
  const rowH = 40;
  const listH = TRADES.length * rowH;
  const viewH = 620;
  const offset = -(Math.max(0, listH - viewH)) * scrollP;

  return (
    <div className="scene-pad" style={{ background: "linear-gradient(180deg, rgba(20,32,58,0.4), transparent 40%)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }}>
        <div>
          <Rise at={0.2} className="eyebrow" style={{ marginBottom: 8, color: "var(--green)" }}>§ PROOF · NOT A CONCEPT</Rise>
          <Rise at={0.4} className="d" style={{ fontSize: 62 }}>
            THE AGENTS <span className="green">ACTUALLY TRADED.</span>
          </Rise>
        </div>
        {/* running counter */}
        <Rise at={1} style={{ textAlign: "right" }}>
          <div className="d" style={{ fontSize: 26, color: "var(--white)", letterSpacing: "0.02em" }}>
            <Ticker value={75} at={1} dur={5} /> TRADES · <Ticker value={14} at={1} dur={5} /> DUELS
          </div>
          <div className="m up green" style={{ fontSize: 15, letterSpacing: "0.22em", marginTop: 4 }}>ALL ON-CHAIN · SOMNIA</div>
        </Rise>
      </div>

      <div style={{ flex: 1, display: "flex", gap: 32, minHeight: 0 }}>
        {/* LEDGER */}
        <div style={{ flex: 1.4, border: "1px solid var(--line)", background: "var(--bg-2)", display: "flex", flexDirection: "column", opacity: verify ? 0.25 : 1, transition: "opacity 0.5s" }}>
          <div style={{ display: "grid", gridTemplateColumns: "80px 150px 130px 1fr", gap: 20, padding: "14px 16px", borderBottom: "2px solid var(--line)" }}>
            {["DUEL", "AGENT", "ACTION", "TX HASH"].map(h => <span key={h} className="m up faint" style={{ fontSize: 12, letterSpacing: "0.2em" }}>{h}</span>)}
          </div>
          <div className="ledger-mask" style={{ flex: 1, height: viewH }}>
            <div style={{ transform: `translateY(${offset}px)` }}>
              {TRADES.map((tr, i) => <LedgerRow key={i} tr={tr} i={i} local={local} highlight={d8.has(tr.hash)} />)}
            </div>
          </div>
        </div>

        {/* RIGHT — exhibits, then verify */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20, position: "relative" }}>
          {!verify && (
            <>
              {/* Exhibit A — Duel 8 divergence */}
              <Rise at={2.5} style={{ border: "1px solid var(--magenta)", background: "var(--panel)", padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
                  <span className="m up magenta" style={{ fontSize: 14, letterSpacing: "0.16em" }}>EXHIBIT · DUEL #8</span>
                  <span className="chip chip-magenta">DIVERGENCE</span>
                </div>
                <div className="m dim" style={{ fontSize: 15, marginBottom: 14, lineHeight: 1.5 }}>Same market, opposite reads — <span className="cyan">Whale loads WETH</span>, <span className="magenta">Degen rotates to SOMI.</span></div>
                {DUEL8_TAPE.slice(0, 6).map((t, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", opacity: easeOut(prog(local, 3 + i * 0.15, 0.4)) }}>
                    <span className="m" style={{ fontSize: 14, color: AGENTS[t.agent].color }}>{t.round} · {AGENTS[t.agent].short}</span>
                    <span className="m tnum" style={{ fontSize: 14, color: actionColor(t.action) }}>{t.action}</span>
                  </div>
                ))}
              </Rise>
              {/* Exhibit B — Duel 5 REAL CLOB */}
              <Rise at={4.5} style={{ border: "1px solid var(--amber)", background: "var(--panel)", padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="m up amber" style={{ fontSize: 14, letterSpacing: "0.16em" }}>DUEL #5</span>
                  <span className="chip chip-amber">REAL CLOB</span>
                </div>
                <div className="m dim" style={{ fontSize: 15, marginTop: 10, lineHeight: 1.5 }}>Live dreamDEX order book — a real central-limit order book, not a mock AMM.</div>
              </Rise>
            </>
          )}

          {/* VERIFY beat */}
          {verify && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
              <Rise at={8} dur={0.4} style={{ marginBottom: 12 }}>
                <div className="m tnum cyan" style={{ fontSize: 20, letterSpacing: "0.02em", wordBreak: "break-all" }}>
                  0x9e1d8bbe…795746670
                </div>
                <div className="m faint" style={{ fontSize: 13, letterSpacing: "0.16em", marginTop: 4 }}>▸ CLICK ANY HASH → EXPLORER</div>
              </Rise>
              <Rise at={8.6} dur={0.5} style={{ flex: 1, position: "relative", minHeight: 0 }}>
                <div style={{ height: "100%", border: "1px solid var(--cyan)", overflow: "hidden", position: "relative", background: "#fff" }}>
                  <img src="uploads/proof-dreamdex-trade.png" alt="Somnia explorer transaction" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
                  <div style={{ position: "absolute", top: 16, right: 16, background: "var(--green)", color: "#04120b", padding: "8px 16px", fontFamily: "var(--fnt-display)", fontSize: 20, letterSpacing: "0.04em", transform: `scale(${easeOutBack(prog(local, 10, 0.6))})` }}>
                    CONFIRMED ≤ 0.101s
                  </div>
                </div>
              </Rise>
            </div>
          )}
        </div>
      </div>

      {/* bottom banner */}
      <div style={{ height: 30, marginTop: 20 }}>
        <TypeLine at={11} cps={30} className="m up" text="EVERY TRADE ON-CHAIN · VERIFY ANY HASH YOURSELF"
          style={{ fontSize: 20, letterSpacing: "0.24em", color: "var(--green)" }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE 5 — ARCHITECTURE: ONE STACK, FULLY ON-CHAIN (18s)
// diagram + real contract map + the load-bearing Somnia primitives
// ═══════════════════════════════════════════════════════════════════════════
const ARCH_LAYERS = [
  { tag: "01 · CLIENT",        title: "FRONTEND",        sub: "Next.js · wallet · live duel view",     color: "var(--slate-2)" },
  { tag: "02 · ORCHESTRATION", title: "ARENA CONTRACTS", sub: "matchmaking · vaults · odds · history", color: "var(--magenta)" },
  { tag: "03 · INTELLIGENCE + MARKET", title: "AGENTS · CLOB · REACTIVITY", color: "var(--purple)", primitives: true },
  { tag: "04 · SETTLEMENT",    title: "SOMNIA L1",       sub: "EVM · sub-second finality",             color: "var(--cyan)" },
];

function AddrRow({ c, i, local }) {
  const appear = easeOut(prog(local, 4 + i * 0.4, 0.4));
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center",
      padding: "12px 16px", borderBottom: "1px solid var(--line)",
      opacity: appear, transform: `translateX(${(1 - appear) * 16}px)`,
      borderLeft: `3px solid ${c.color}`,
    }}>
      <div>
        <div className="m" style={{ fontSize: 17, color: c.color, letterSpacing: "0.06em" }}>
          {c.name}{c.ext && <span className="faint" style={{ fontSize: 12, marginLeft: 8, letterSpacing: "0.14em" }}>◭ REAL</span>}
        </div>
        <div className="m faint" style={{ fontSize: 12.5, letterSpacing: "0.04em", marginTop: 3 }}>{c.role}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div className="m tnum cyan" style={{ fontSize: 15 }}>{shortHash(c.addr)}</div>
        <div className="m" style={{ fontSize: 10.5, letterSpacing: "0.18em", color: "var(--green)", marginTop: 3 }}>● LIVE</div>
      </div>
    </div>
  );
}

function SceneArch({ local }) {
  return (
    <div className="scene-pad">
      {/* header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 22 }}>
        <div>
          <Rise at={0.2} className="eyebrow" style={{ marginBottom: 8, color: "var(--purple)" }}>§ ARCHITECTURE · HOW IT'S BUILT</Rise>
          <Rise at={0.4} className="d" style={{ fontSize: 58 }}>ONE STACK. <span className="cyan">FULLY ON-CHAIN.</span></Rise>
        </div>
        <Rise at={1} className="chip chip-green" style={{ alignSelf: "center" }}>SHANNON TESTNET · CHAIN 50312</Rise>
      </div>

      <div style={{ flex: 1, display: "flex", gap: 34, minHeight: 0 }}>
        {/* LEFT — the layered stack */}
        <div style={{ flex: 1.45, display: "flex", flexDirection: "column", justifyContent: "center", gap: 14, position: "relative" }}>
          {ARCH_LAYERS.map((L, i) => {
            const rise = easeOut(prog(local, 1.2 + i * 0.7, 0.6));
            return (
              <React.Fragment key={i}>
                <div style={{
                  opacity: rise, transform: `translateY(${(1 - rise) * 24}px)`,
                  border: `1px solid ${L.color}`, background: "linear-gradient(180deg, rgba(255,255,255,0.03), transparent)",
                  padding: "18px 24px", position: "relative", overflow: "hidden",
                }}>
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: L.color, opacity: 0.85 }} />
                  <div className="m up" style={{ fontSize: 12, letterSpacing: "0.2em", color: L.color, marginBottom: 8 }}>{L.tag}</div>
                  {L.primitives ? (
                    <div style={{ display: "flex", gap: 12 }}>
                      {PRIMITIVES.map((p, k) => {
                        const pk = easeOutBack(prog(local, 5 + k * 0.5, 0.7));
                        return (
                          <div key={k} style={{
                            flex: 1, opacity: Math.min(1, pk), transform: `scale(${0.9 + pk * 0.1})`,
                            border: `1px solid ${p.color}`, background: "rgba(0,0,0,0.28)", padding: "12px 14px",
                          }}>
                            <div className="m" style={{ fontSize: 16, fontWeight: 700, color: p.color, letterSpacing: "0.04em", lineHeight: 1.1 }}>{p.title}</div>
                            <div className="m faint" style={{ fontSize: 12.5, marginTop: 6, letterSpacing: "0.03em" }}>{p.sub}</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
                      <span className="m" style={{ fontSize: 26, fontWeight: 700, color: "var(--white)", letterSpacing: "0.05em", lineHeight: 1 }}>{L.title}</span>
                      <span className="m dim" style={{ fontSize: 15, letterSpacing: "0.03em" }}>{L.sub}</span>
                    </div>
                  )}
                </div>
                {i < ARCH_LAYERS.length - 1 && (
                  <div style={{ textAlign: "center", opacity: easeOut(prog(local, 1.5 + i * 0.7, 0.5)), color: "var(--slate)", fontSize: 18, lineHeight: 0.5 }}>▼</div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* RIGHT — deployed contract map */}
        <div style={{ flex: 1, border: "1px solid var(--line)", background: "var(--bg-2)", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 16px", borderBottom: "2px solid var(--line)" }}>
            <span className="m up faint" style={{ fontSize: 12, letterSpacing: "0.2em" }}>DEPLOYED CONTRACTS</span>
            <span className="m up green" style={{ fontSize: 12, letterSpacing: "0.18em", display: "inline-flex", alignItems: "center", gap: 7 }}><SomniaMark size={16} /> SOMNIA</span>
          </div>
          <div style={{ flex: 1 }}>
            {CONTRACTS.map((c, i) => <AddrRow key={i} c={c} i={i} local={local} />)}
          </div>
        </div>
      </div>

      {/* bottom — one-line data flow */}
      <div style={{ height: 30, marginTop: 18 }}>
        <TypeLine at={11} cps={30} className="m up"
          text="AGENT DECIDES → ORDER EXECUTES ON dreamDEX → SETTLES ON-CHAIN → CONTRACT TICKS NEXT ROUND"
          style={{ fontSize: 17, letterSpacing: "0.16em", color: "var(--purple)" }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE 6 — THE AGENTS: HOW THE AI THINKS (24s)
// personas = on-chain prompts · one Somnia Agents LLM · the bookmaker agent
// ═══════════════════════════════════════════════════════════════════════════
function StatBar({ label, v, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span className="m faint" style={{ fontSize: 9.5, width: 26, letterSpacing: "0.06em" }}>{label}</span>
      <div style={{ display: "flex", gap: 3, flex: 1 }}>
        {[1, 2, 3, 4, 5].map(n => (
          <span key={n} style={{ flex: 1, height: 5, background: n <= v ? color : "var(--line)" }} />
        ))}
      </div>
    </div>
  );
}

// One roster column — landing-style: avatar + name + tagline + persona stats.
function RosterColumn({ p, i, local }) {
  const pk = easeOutBack(prog(local, 1.2 + i * 0.16, 0.6));
  return (
    <div style={{
      flex: 1, minWidth: 0, opacity: Math.min(1, pk), transform: `translateY(${(1 - pk) * 30}px)`,
      border: `1px solid ${p.color}`, background: "linear-gradient(180deg, rgba(255,255,255,0.03), transparent)",
      padding: "14px 12px", display: "flex", flexDirection: "column", alignItems: "center",
    }}>
      <div className="m faint" style={{ fontSize: 10, alignSelf: "flex-start", letterSpacing: "0.14em" }}>{String(i + 1).padStart(2, "0")} / 06</div>
      <div style={{ margin: "8px 0 12px" }}><Fighter id={p.fid} size={116} state="idle" /></div>
      <div className="d" style={{ fontSize: 18, color: p.color, textAlign: "center", lineHeight: 0.92 }}>{p.name}</div>
      <div className="m faint" style={{ fontSize: 11, fontStyle: "italic", marginTop: 6, textAlign: "center", lineHeight: 1.25, minHeight: 28 }}>“{p.tag}”</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 10, alignSelf: "stretch" }}>
        <StatBar label="AGG" v={p.agg} color={p.color} />
        <StatBar label="PAT" v={p.pat} color={p.color} />
        <StatBar label="RSK" v={p.rsk} color={p.color} />
      </div>
    </div>
  );
}

// A decision step — the title shows immediately; the detail loads when highlighted.
const DECIDE_STEPS = [
  { n: "01", title: "READ",  detail: "on-chain prompt + live market",     color: "var(--slate-2)" },
  { n: "02", title: "INFER", detail: "Somnia Agents · deterministic LLM", color: "var(--purple)" },
  { n: "03", title: "ACT",   detail: "Buy · Sell · Hold → dreamDEX",       color: "var(--green)" },
];

function StepBar({ s, at, local }) {
  const on = local >= at;
  const rv = easeOut(prog(local, at, 0.45));
  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", gap: 10,
      border: `1px solid ${on ? s.color : "var(--line)"}`,
      background: on ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.015)",
      padding: "0 12px",
    }}>
      <span className="m" style={{ fontSize: 15, fontWeight: 700, color: on ? s.color : "var(--slate)", whiteSpace: "nowrap" }}>{s.n} · {s.title}</span>
      <span className="m faint" style={{ fontSize: 13, opacity: rv, lineHeight: 1.25, marginLeft: "auto", textAlign: "right" }}>{s.detail}</span>
    </div>
  );
}

function SceneAgents({ local }) {
  const oddsGrow = easeOut(prog(local, 9, 0.8));
  return (
    <div className="scene-pad">
      {/* header */}
      <div style={{ marginBottom: 18 }}>
        <Rise at={0.2} className="eyebrow" style={{ marginBottom: 8, color: "var(--purple)" }}>§ THE AGENTS · HOW THE AI THINKS</Rise>
        <Rise at={0.4} className="d" style={{ fontSize: 54 }}>SIX MINDS. <span className="purple">ONE MODEL.</span></Rise>
      </div>

      {/* ── ROSTER — landing-style avatar columns ───────────────────────── */}
      <Rise at={0.8} className="m up faint" style={{ fontSize: 11.5, letterSpacing: "0.2em", marginBottom: 12 }}>
        PERSONAS = ON-CHAIN SYSTEM PROMPTS · SAME LLM, SIX MINDS
      </Rise>
      <div style={{ display: "flex", gap: 12, marginBottom: 22 }}>
        {PERSONAS.map((p, i) => <RosterColumn key={i} p={p} i={i} local={local} />)}
      </div>

      {/* ── HOW IT WORKS — three containers: fighter · bookmaker · betting ─ */}
      <div style={{ flex: 1, display: "flex", gap: 16, minHeight: 0 }}>
        {/* 1 · how a fighter decides */}
        <Rise at={3.5} style={{ flex: 1, border: "1px solid var(--purple)", background: "var(--panel)", padding: 18, display: "flex", flexDirection: "column" }}>
          <div className="m up purple" style={{ fontSize: 14.5, letterSpacing: "0.16em", marginBottom: 14 }}>HOW A FIGHTER DECIDES</div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 9 }}>
            {DECIDE_STEPS.map((s, k) => <StepBar key={k} s={s} at={4.3 + k * 0.9} local={local} />)}
          </div>
        </Rise>

        {/* 2 · the bookmaker */}
        <Rise at={6} style={{ flex: 1, border: "1px solid var(--amber)", background: "var(--panel)", padding: 18, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span className="m up amber" style={{ fontSize: 14.5, letterSpacing: "0.16em" }}>THE BOOKMAKER</span>
            <span className="chip chip-amber">SAME LLM</span>
          </div>
          <div className="m dim" style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 14 }}>A separate agent, same model — it prices the fight every turn.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, justifyContent: "center" }}>
            {[
              { t: "reads both fighters + balances", c: "var(--cyan)", at: 6.6 },
              { t: "inferNumber(0–100)", c: "var(--amber)", at: 7.1 },
              { t: "→ sets the live odds", c: "var(--green)", at: 7.6 },
            ].map((r, k) => (
              <React.Fragment key={k}>
                {k > 0 && <div style={{ textAlign: "center", color: "var(--slate)", fontSize: 13, lineHeight: 0.4, opacity: easeOut(prog(local, r.at - 0.2, 0.3)) }}>▼</div>}
                <div style={{ opacity: easeOut(prog(local, r.at, 0.4)), border: `1px solid ${r.c}`, background: "rgba(0,0,0,0.3)", padding: "9px 12px" }}>
                  <span className="m" style={{ fontSize: 14, color: r.c }}>{r.t}</span>
                </div>
              </React.Fragment>
            ))}
          </div>
        </Rise>

        {/* 3 · betting */}
        <Rise at={8} style={{ flex: 1, border: "1px solid var(--cyan)", background: "var(--panel)", padding: 18, display: "flex", flexDirection: "column" }}>
          <div className="m up cyan" style={{ fontSize: 14.5, letterSpacing: "0.16em", marginBottom: 12 }}>BETTING · THE CROWD</div>
          <div className="m dim" style={{ fontSize: 14, lineHeight: 1.55 }}>
            Spectators stake <span className="amber">USDso</span> on a fighter at the live odds. Back the winner → <span className="green">share the pot, pro-rata.</span> Bets settle on-chain when the bell rings.
          </div>
          {/* live odds bar */}
          <div style={{ marginTop: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span className="m magenta" style={{ fontSize: 13.5 }}>DEGEN 62%</span>
              <span className="m cyan" style={{ fontSize: 13.5 }}>38% WHALE</span>
            </div>
            <div style={{ display: "flex", height: 12, border: "1px solid var(--line)" }}>
              <div style={{ width: `${62 * oddsGrow}%`, background: "var(--magenta)" }} />
              <div style={{ flex: 1, background: "var(--cyan)", opacity: oddsGrow }} />
            </div>
          </div>
        </Rise>
      </div>

      {/* bottom caption */}
      <div style={{ height: 26, marginTop: 14 }}>
        <TypeLine at={11} cps={30} className="m up"
          text="ONE DETERMINISTIC MODEL · SIX PROMPTS · SIX MINDS — PLUS A BOOKMAKER THAT PRICES THE FIGHT"
          style={{ fontSize: 15, letterSpacing: "0.14em", color: "var(--purple)" }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE 7 — WHY ONLY SOMNIA (13s) — original pillar design, timing tightened
// ═══════════════════════════════════════════════════════════════════════════
const PILLARS = [
  { title: "SOMNIA AGENTS", sub: "on-chain LLM inference", code: "inferNumber()", color: "var(--purple)", icon: "cpu" },
  { title: "dreamDEX", sub: "zero-fee CLOB", code: "placeTakerOrder · FOK", color: "var(--amber)", icon: "book" },
  { title: "REACTIVITY", sub: "self-ticking contracts", code: "BlockTick → turn()", color: "var(--cyan)", icon: "bolt" },
];

function TechIcon({ kind, color }) {
  const c = color;
  const common = { width: 54, height: 54, viewBox: "0 0 48 48", fill: "none", stroke: c, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
  if (kind === "cpu") return (
    <svg {...common}>
      <rect x="15" y="15" width="18" height="18" />
      <circle cx="24" cy="24" r="3.5" fill={c} stroke="none" />
      {[0,1,2].map(i => <line key={"t"+i} x1={19+i*5} y1="15" x2={19+i*5} y2="9" />)}
      {[0,1,2].map(i => <line key={"b"+i} x1={19+i*5} y1="33" x2={19+i*5} y2="39" />)}
      {[0,1,2].map(i => <line key={"l"+i} x1="15" y1={19+i*5} x2="9" y2={19+i*5} />)}
      {[0,1,2].map(i => <line key={"r"+i} x1="33" y1={19+i*5} x2="39" y2={19+i*5} />)}
    </svg>
  );
  if (kind === "book") return (
    <svg {...common}>
      <line x1="13" y1="12" x2="13" y2="36" /><rect x="9.5" y="18" width="7" height="10" fill={c} stroke="none" opacity="0.9" />
      <line x1="24" y1="8" x2="24" y2="40" /><rect x="20.5" y="14" width="7" height="18" fill={c} stroke="none" opacity="0.6" />
      <line x1="35" y1="14" x2="35" y2="38" /><rect x="31.5" y="22" width="7" height="9" fill={c} stroke="none" opacity="0.9" />
    </svg>
  );
  return (
    <svg {...common}>
      <polygon points="26,6 12,26 22,26 20,42 36,20 26,20" fill={c} stroke="none" />
    </svg>
  );
}

function Scene5({ local }) {
  const fused = prog(local, 7, 3);
  return (
    <div className="scene-pad" style={{ alignItems: "center" }}>
      <Rise at={0.2} className="eyebrow" style={{ marginBottom: 14 }}>§ WHY ONLY SOMNIA</Rise>
      <Rise at={0.4} className="d" style={{ fontSize: 54, marginBottom: 40, textAlign: "center", lineHeight: 1.06 }}>
        THE INTELLIGENCE, THE MARKET, THE HEARTBEAT<br /><span className="cyan">ALL ON-CHAIN.</span>
      </Rise>

      {/* keystone — the positioning line lives up top */}
      <Rise at={1.4} style={{ marginBottom: 22, textAlign: "center" }}>
        <div className="d" style={{ fontSize: 30, letterSpacing: "0.1em", opacity: 0.5 + fused * 0.4, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <span className="cyan">ONLY POSSIBLE ON THE AGENTIC L1</span>
          <SomniaMark size={34} style={{ margin: "0 16px" }} />
          <span className="white">SOMNIA</span>
        </div>
      </Rise>

      {/* pillars */}
      <div style={{ display: "flex", gap: 40, alignItems: "flex-end", flex: 1, width: "100%", justifyContent: "center", paddingBottom: 30 }}>
        {PILLARS.map((p, i) => {
          const rise = easeOutBack(prog(local, 1.8 + i * 1.1, 0.9));
          const spark = prog(local, 2.2 + i * 1.1, 0.8);
          return (
            <div key={i} style={{ flex: 1, maxWidth: 420, transform: `translateY(${(1 - rise) * 400}px)`, opacity: Math.min(1, rise + 0.001) }}>
              <div style={{ border: `1px solid ${p.color}`, background: "linear-gradient(180deg, rgba(255,255,255,0.03), transparent)", padding: 36, paddingTop: 108, height: 400, display: "flex", flexDirection: "column", justifyContent: "flex-end", position: "relative" }}>
                {/* spark running up */}
                <div style={{ position: "absolute", left: 0, bottom: 0, width: 3, height: `${spark * 100}%`, background: p.color }} />
                <div style={{ position: "absolute", top: 34, left: 34, opacity: easeOut(prog(local, 2.4 + i * 1.1, 0.8)) }}><TechIcon kind={p.icon} color={p.color} /></div>
                <div className="d" style={{ fontSize: 22, color: p.color, letterSpacing: "0.1em" }}>0{i + 1}</div>
                <div className="d" style={{ fontSize: 40, color: "var(--white)", marginTop: 12, lineHeight: 0.95 }}>{p.title}</div>
                <div className="m dim" style={{ fontSize: 17, marginTop: 12, letterSpacing: "0.04em" }}>{p.sub}</div>
                <div className="m" style={{ fontSize: 16, marginTop: 18, color: p.color, background: "rgba(0,0,0,0.3)", padding: "8px 12px", border: `1px solid ${p.color}44`, letterSpacing: "0.02em" }}>{p.code}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* latency blip + caption */}
      <Rise at={5.5} style={{ display: "flex", gap: 40, alignItems: "center", marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="m up faint" style={{ fontSize: 14, letterSpacing: "0.2em" }}>FINALITY</span>
          <span className="d green" style={{ fontSize: 40 }}>&lt; 1s</span>
          <span style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--green)", animation: "pulse 0.9s infinite" }} />
        </div>
      </Rise>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE 8 — TRACTION + CLOSE (20s, then hold)
// ═══════════════════════════════════════════════════════════════════════════
const STAT_CARDS = [
  { big: "LIVE", sub: "TODAY ✓", color: "var(--green)", tick: false },
  { big: 14, sub: "ON-CHAIN DUELS", color: "var(--cyan)", tick: true },
  { big: 75, sub: "AGENT TRADES", color: "var(--magenta)", tick: true },
  { big: 6, sub: "AI FIGHTERS", color: "var(--amber)", tick: true },
];

// Every Somnia hackathon to date — full names + real placements.
const WINS = [
  { name: "Somnia Reactivity Mini Hackathon",   prize: "WINNER",              color: "var(--cyan)" },
  { name: "Somnia Data Streams Mini Hackathon", prize: "WINNER",              color: "var(--purple)" },
  { name: "Somnia AI Hackathon",                prize: "1ST · GAMING AGENTS", color: "var(--magenta)" },
  { name: "Somnia DeFi Mini Hackathon",         prize: "3RD · DEV TOOLING",   color: "var(--amber)" },
  { name: "Somnia Mini Games Hackathon",        prize: "1ST PLACE",           color: "var(--green)" },
];

function Scene6({ local }) {
  const statsGone = local >= 8;
  return (
    <div className="scene-pad" style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      {/* stat cards — 0-8 */}
      {!statsGone && (
        <div style={{ display: "flex", gap: 28 }}>
          {STAT_CARDS.map((s, i) => {
            const p = easeOutBack(prog(local, 0.3 + i * 0.5, 0.7));
            return (
              <div key={i} style={{ opacity: Math.min(1, p), transform: `translateY(${(1 - p) * 60}px)`, border: `1px solid ${s.color}`, background: "var(--panel)", padding: "40px 48px", minWidth: 260, boxShadow: `0 0 30px ${s.color}22` }}>
              <div className="d" style={{ fontSize: 88, color: s.color, lineHeight: 0.9 }}>
                  {s.tick ? <Ticker value={s.big} at={0.5 + i * 0.5} dur={2.4} /> : s.big}
                </div>
                <div className="m up" style={{ fontSize: 16, letterSpacing: "0.2em", marginTop: 14, color: "var(--slate-2)" }}>{s.sub}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* close — 8s+ */}
      {statsGone && (
        <div style={{ position: "relative", width: "100%" }}>
          {/* fighters behind — pushed to the far edges, dim, so they never sit under the URL */}
          <div style={{ position: "absolute", left: 0, right: 0, top: "50%", transform: "translateY(-50%)", display: "flex", justifyContent: "space-between", padding: "0 20px", opacity: 0.26, pointerEvents: "none" }}>
            <Rise at={8} from="left" dur={0.7}><div style={{ filter: "drop-shadow(0 0 16px rgba(255,51,102,0.3))" }}><Fighter id="degen" size={260} /></div></Rise>
            <Rise at={8.1} from="right" dur={0.7}><div style={{ filter: "drop-shadow(0 0 16px rgba(0,217,255,0.3))" }}><Fighter id="whale" size={260} /></div></Rise>
          </div>

          <div style={{ position: "relative", zIndex: 2, background: "radial-gradient(ellipse 66% 130% at 50% 50%, var(--bg) 42%, transparent 78%)", padding: "48px 40px" }}>
            <Rise at={8.2} dur={0.5} className="eyebrow" style={{ marginBottom: 22, fontSize: 20, color: "var(--cyan)" }}>LIVE TODAY · REAL DUELS · REAL BETS</Rise>
            <div className="d" style={{ fontSize: 80, color: "var(--white)", letterSpacing: "0.02em" }}>
              <TypeLine at={8.4} cps={16} text="coliseum.somniaforge.com" cursor={false} />
            </div>
            <Rise at={12.5} dur={0.5} style={{ marginTop: 44 }}>
              <div className="d" style={{ fontSize: 66, letterSpacing: "0.08em", color: "var(--magenta)" }}>STEP INTO THE ARENA</div>
            </Rise>
            <Rise at={13} style={{ marginTop: 32 }}>
              <div className="m up" style={{ fontSize: 21, letterSpacing: "0.14em", color: "var(--gold)", marginBottom: 18 }}>
                BUILT SOLO · 5 SOMNIA HACKATHONS · 5 PODIUM FINISHES
              </div>
              <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                {WINS.map((w, i) => {
                  const p = easeOut(prog(local, 13.4 + i * 0.18, 0.4));
                  return (
                    <div key={i} style={{ flex: 1, maxWidth: 320, opacity: p, transform: `translateY(${(1 - p) * 14}px)`, border: `1px solid ${w.color}`, background: "rgba(0,0,0,0.34)", padding: "16px 18px", textAlign: "left" }}>
                      <div className="m" style={{ fontSize: 16, color: "var(--white)", lineHeight: 1.3 }}>{w.name}</div>
                      <div className="m" style={{ fontSize: 14, color: w.color, letterSpacing: "0.08em", marginTop: 8 }}>▸ {w.prize}</div>
                    </div>
                  );
                })}
              </div>
            </Rise>
            <Rise at={15} style={{ marginTop: 30, display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
              <span className="m faint" style={{ fontSize: 17, letterSpacing: "0.26em" }}>BUILT ON</span>
              <SomniaMark size={30} />
              <span className="m" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "0.12em", color: "var(--white)" }}>SOMNIA</span>
            </Rise>
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Scene4, SceneArch, SceneAgents, Scene5, Scene6 });
