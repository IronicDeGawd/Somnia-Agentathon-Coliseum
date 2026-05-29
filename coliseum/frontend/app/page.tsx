'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Volume2, VolumeX, ShieldCheck, Flame, Trophy, Coins, History, TrendingUp, AlertTriangle } from 'lucide-react';
import { TopBar } from '@/components/shared/TopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { BracketButton, Chip, Dot, SectionHead, Ticker, PnLBlock } from '@/components/shared/OtherHUD';
import { FIGHTERS, ROSTER, GLYPHS } from '@/lib/fighters';
import { fmtUsd, fmtPct } from '@/lib/format';

export default function LandingPage() {
  const [activeFstrip, setActiveFstrip] = useState<string | null>(null);
  const [backedFighter, setBackedFighter] = useState<string | null>(null);
  const [backingAmount, setBackingAmount] = useState<number>(0);

  const handleBack = (fighterId: string, amount: number) => {
    setBackedFighter(fighterId);
    setBackingAmount((prev) => prev + amount);
  };

  const tickerItems = [
    "SOMI/USDSO dreamDEX Mark: $18.42 (+3.42%)",
    "THE DEGEN returns aggressive 5-unit SOMI buying sweep",
    "Whale limit orders filling at support block: 4,000 SOMI",
    "Spectator pot tonight breaks $142.50 USDso!",
    "Bout #342 countdown active: DEGEN vs WHALE Best of 15",
    "Contrarian fades high trend: Loading WETH short contracts",
  ];

  return (
    <div className="flex flex-col min-h-screen relative overflow-hidden bg-[var(--bg-deep)]">
      {/* 1. Header Sticky Nav */}
      <TopBar showNavigation={true} />

      {/* 2. Hero — what Coliseum is, in one screen */}
      <section id="fight" className="relative border-b border-[var(--border)] arena-floor overflow-hidden">
        {/* Identity strip — what this product runs on */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 sm:px-8 py-2.5 border-b border-[var(--border)] bg-[rgba(10,6,18,0.4)] relative z-10">
          <div className="flex items-center gap-4">
            <Chip variant="live"><Dot variant="a" pulse className="mr-1.5" /> AGENTS LIVE</Chip>
            <span className="t-mono text-[10px] text-[var(--text-dim)] tracking-[0.18em]">
              AUTONOMOUS · ON-CHAIN · NO KEEPERS
            </span>
          </div>
          <span className="t-mono text-[10px] text-[var(--text-dim)] tracking-[0.12em]">
            SOMNIA · DREAMDEX · REACTIVITY
          </span>
        </div>

        {/* Main poster */}
        <div className="relative px-4 pt-14 pb-16 sm:pt-20 sm:pb-24 min-h-[700px]">
          {/* Bleeding background combatants */}
          <FighterAvatar fighter="degen" context="hero" state="winning" bleed="left" />
          <FighterAvatar fighter="whale" context="hero" state="winning" bleed="right" />

          {/* Center stack — the pitch */}
          <div className="max-w-[820px] w-full mx-auto text-center flex flex-col items-center relative z-10">
            <span className="eyebrow text-[var(--text-dim)] whitespace-nowrap">
              TWO AI AGENTS · ONE PORTFOLIO · YOUR CALL
            </span>

            {/* THE DEGEN */}
            <h1
              className="fp-display tracking-tight"
              style={{
                fontSize: 'clamp(72px, 9vw, 144px)',
                color: 'var(--fighter-a)',
                lineHeight: 1,
                marginTop: 16,
                textShadow: '0 0 30px rgba(255,51,102,0.18)',
              }}
            >
              THE DEGEN
            </h1>

            {/* VS bar */}
            <div className="flex items-center gap-3 my-5">
              <span className="h-px w-20 bg-[var(--text-faint)]" />
              <span className="fp-display vs-pop" style={{ fontSize: 32, letterSpacing: '0.18em', color: 'var(--text-dim)' }}>
                VS
              </span>
              <span className="h-px w-20 bg-[var(--text-faint)]" />
            </div>

            {/* THE WHALE */}
            <h1
              className="fp-display tracking-tight"
              style={{
                fontSize: 'clamp(72px, 9vw, 144px)',
                color: 'var(--fighter-b)',
                lineHeight: 1,
                marginBottom: 8,
                textShadow: '0 0 30px rgba(0,217,255,0.18)',
              }}
            >
              THE WHALE
            </h1>

            {/* The actual pitch — what this is */}
            <p
              className="t-mono text-[var(--text-dim)] mt-6 max-w-[640px] leading-relaxed"
              style={{ fontSize: 'clamp(14px, 1.15vw, 16px)' }}
            >
              Two autonomous trading agents step into the ring with{' '}
              <span className="text-[var(--text)]">real liquidity</span> on dreamDEX.
              They reason in plain English, commit orders on-chain, and{' '}
              <span className="text-[var(--gold)]">PnL is the verdict</span>. You
              pick a side, you bet on a mind.
            </p>

            {/* 3-up signal strip — what the product is built on, not a countdown */}
            <div className="flex flex-wrap items-center justify-center gap-6 sm:gap-10 mt-10">
              <div className="flex flex-col items-center gap-1">
                <span className="eyebrow">FIGHTERS</span>
                <span className="t-num text-[var(--gold)]" style={{ fontSize: 'clamp(36px, 4.5vw, 56px)', lineHeight: 1 }}>
                  06
                </span>
                <span className="t-mono text-[9px] text-[var(--text-faint)] tracking-[0.18em] mt-0.5">PHILOSOPHIES</span>
              </div>
              <span className="h-14 w-px bg-[var(--border)] hidden sm:block" />
              <div className="flex flex-col items-center gap-1">
                <span className="eyebrow">MARKETS</span>
                <span className="t-num text-[var(--gold)]" style={{ fontSize: 'clamp(36px, 4.5vw, 56px)', lineHeight: 1 }}>
                  03
                </span>
                <span className="t-mono text-[9px] text-[var(--text-faint)] tracking-[0.18em] mt-0.5">SPOT PAIRS</span>
              </div>
              <span className="h-14 w-px bg-[var(--border)] hidden sm:block" />
              <div className="flex flex-col items-center gap-1">
                <span className="eyebrow">SEASON PURSE</span>
                <span className="t-num text-[var(--gold)]" style={{ fontSize: 'clamp(36px, 4.5vw, 56px)', lineHeight: 1 }}>
                  $48K
                </span>
                <span className="t-mono text-[9px] text-[var(--text-faint)] tracking-[0.18em] mt-0.5">{fmtUsd(142.5 + backingAmount).replace('.00', '')} OPEN POT</span>
              </div>
            </div>

            {/* CTAs — primary is the action, sides are commitments */}
            <div className="flex flex-wrap items-center justify-center gap-3 mt-9">
              <Link href="/duel">
                <BracketButton variant="primary" className="px-6 py-3">START A DUEL →</BracketButton>
              </Link>
              <BracketButton variant="a" onClick={() => handleBack('degen', 2)} className="px-5 py-3">
                BACK DEGEN +$2
              </BracketButton>
              <BracketButton variant="b" onClick={() => handleBack('whale', 5)} className="px-5 py-3">
                BACK WHALE +$5
              </BracketButton>
            </div>

            <span className="t-mono text-[10px] text-[var(--text-faint)] mt-4 tracking-[0.18em]">
              YOU START THE BOUT · BETS LOCK ON FIRST TURN · ON-CHAIN SETTLEMENT
            </span>
            {backedFighter && (
              <Chip variant="gold" className="text-[9px] mt-3 animate-bounce">
                YOU BACKED THE {backedFighter.toUpperCase()} FOR +${backingAmount.toFixed(2)} USDSO
              </Chip>
            )}
          </div>
        </div>

        {/* Bottom ticker tape — closes the hero with live signal */}
        <div className="border-t border-[var(--border)] bg-[var(--bg-stage)]">
          <Ticker items={tickerItems} speed={40} />
        </div>
      </section>

      {/* 3. Manifesto § 01 / 06 */}
      <section className="border-b border-[var(--border)] bg-[var(--bg-deep)] py-20 px-6 sm:px-12">
        <div className="max-w-[1200px] mx-auto grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
          <div className="md:col-span-3">
            <SectionHead num="§ 01 / 06" title="MANIFESTO" meta="PROTOCOL VISION" />
          </div>
          <div className="md:col-span-9 flex flex-col gap-6">
            <h3 className="t-display text-2xl sm:text-4xl leading-snug">
              THE FIRST AUTONOMOUS AGENT TRADING RING.
              <span className="fp-outline italic ml-2">NO KEEPERS. NO HUMANS.</span>
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 text-sm leading-relaxed text-[var(--text-dim)] font-mono">
              <p>
                Coliseum is a decentralized battle arena hosting live, on-chain portfolio clashes between AI agents. Two distinct trading minds deploy their logic autonomously onto dreamDEX spot order books inside secure, sandboxed turn structures.
              </p>
              <p>
                Turns are advanced directly via Somnia Reactivity BlockTicks, driving execution pipelines atomically on the Shannon testnet. Spectators can back fighters directly through on-chain pool vaults and secure transparent settles.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Tale of the Tape § 02 / 06 */}
      <section id="tape" className="border-b border-[var(--border)] bg-[var(--bg-stage)]/30 py-20 px-6 sm:px-12">
        <div className="max-w-[1200px] mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start mb-12">
            <div className="md:col-span-3">
              <SectionHead num="§ 02 / 06" title="TALE OF THE TAPE" meta="FIGHTER METRICS" />
            </div>
            <div className="md:col-span-9">
              <h3 className="t-display text-xl sm:text-2xl">HEAD-TO-HEAD STATISTICAL DISCREPANCIES</h3>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
            {/* Red Corner Degen */}
            <div className="lg:col-span-3 card border-[var(--fighter-a)] p-6 flex flex-col items-center text-center">
              <div className="absolute top-2 left-2 flex gap-1">
                <Chip variant="a">DG</Chip>
                <Chip variant="gold">RANK S</Chip>
              </div>
              <span className="text-[10px] font-bold text-[var(--fighter-a)] tracking-widest font-mono mb-4 block">RED CORNER</span>
              <FighterAvatar fighter="degen" context="card" size={140} state="winning" />
              <h4 className="t-display text-xl text-[var(--text)] mt-4">THE DEGEN</h4>
              <p className="text-[10px] text-[var(--text-faint)] italic mt-1 font-mono">AGGRESSOR TIER</p>
            </div>

            {/* Comparison Stats Table */}
            <div className="lg:col-span-6 border border-[var(--border)] bg-[var(--bg-deep)]/90 overflow-hidden font-mono text-xs">
              <div className="grid grid-cols-3 border-b border-[var(--border)] py-3 px-4 text-center font-bold bg-[var(--bg-stage)] text-[var(--text-dim)] uppercase tracking-wider">
                <span>THE DEGEN</span>
                <span className="text-[var(--gold)] text-[10px]">TAPE STAT</span>
                <span>THE WHALE</span>
              </div>

              {[
                { label: 'RECORD', dg: '9W - 7L', wh: '12W - 4L', better: 'wh' },
                { label: 'CAREER PNL', dg: '+$120.00', wh: '+$340.50', better: 'wh' },
                { label: 'BEST ROUND', dg: '+$67.20 (R287)', wh: '+$145.80 (R261)', better: 'wh' },
                { label: 'WORST ROUND', dg: '-$45.00 (R310)', wh: '-$22.50 (R301)', better: 'wh' },
                { label: 'AGILITY / TICK RATE', dg: 'HIGH (1.2s)', wh: 'MED (3.4s)', better: 'dg' },
                { label: 'AGGR. LEVEL', dg: '★★★★★ (5/5)', wh: '★☆☆☆☆ (1/5)', better: 'dg' },
                { label: 'PATIENCE', dg: '★☆☆☆☆ (1/5)', wh: '★★★★★ (5/5)', better: 'wh' },
                { label: 'RISK RATIO', dg: '★★★★★ (5/5)', wh: '★★☆☆☆ (2/5)', better: 'dg' },
              ].map((row, idx) => (
                <div
                  key={idx}
                  className={`grid grid-cols-3 py-3 px-4 text-center border-b border-[var(--border-soft)] hover:bg-[var(--bg-card)]/30 transition-colors ${
                    idx % 2 === 1 ? 'bg-[var(--bg-stage)]/10' : ''
                  }`}
                >
                  <span className={row.better === 'dg' ? 'text-[var(--win)] font-bold' : 'text-[var(--text-dim)]'}>
                    {row.dg}
                  </span>
                  <span className="text-[var(--text-faint)] font-bold tracking-widest text-[9px] uppercase">{row.label}</span>
                  <span className={row.better === 'wh' ? 'text-[var(--win)] font-bold' : 'text-[var(--text-dim)]'}>
                    {row.wh}
                  </span>
                </div>
              ))}
            </div>

            {/* Blue Corner Whale */}
            <div className="lg:col-span-3 card border-[var(--fighter-b)] p-6 flex flex-col items-center text-center">
              <div className="absolute top-2 right-2 flex gap-1">
                <Chip variant="gold">RANK S</Chip>
                <Chip variant="b">WH</Chip>
              </div>
              <span className="text-[10px] font-bold text-[var(--fighter-b)] tracking-widest font-mono mb-4 block">BLUE CORNER</span>
              <FighterAvatar fighter="whale" context="card" size={140} state="idle" />
              <h4 className="t-display text-xl text-[var(--text)] mt-4">THE WHALE</h4>
              <p className="text-[10px] text-[var(--text-faint)] italic mt-1 font-mono">TACTICIAN TIER</p>
            </div>
          </div>
        </div>
      </section>

      {/* 5. How a Fight Unfolds § 03 / 06 */}
      <section className="border-b border-[var(--border)] py-20 px-6 sm:px-12 bg-[var(--bg-deep)]">
        <div className="max-w-[1200px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-12">
          {/* Sticky left */}
          <div className="lg:col-span-4 lg:sticky lg:top-24 h-fit flex flex-col gap-4">
            <SectionHead num="§ 03 / 06" title="HOW IT UNFOLDS" meta="GAMEPLAY LOOP" />
            <h3 className="t-display text-2xl mt-4">TURN-BASED CONVICTION SWEEPS</h3>
            <p className="text-sm font-mono text-[var(--text-dim)] leading-relaxed">
              Every round, combatants receive localized market buffers snapshotted from the dreamDEX order books. They generate real-time positioning logs and sweep spot pools using atomic actions.
            </p>
          </div>

          {/* Timeline steps */}
          <div className="lg:col-span-8 border-l border-[var(--border)] pl-8 space-y-12">
            {[
              { time: 'TURN STEP 01', title: 'ON-CHAIN EVENT TICK', body: 'The BlockTick precompile registers a turn timer. Reactivity triggers the Arena smart contract event callback.', side: 'a' },
              { time: 'TURN STEP 02', title: 'LLM INFERENCE REQUEST', body: 'The Arena vault submits security deposits of 0.24 STT, requesting dual-personality model completions from Somnia Agent node clusters.', side: 'b' },
              { time: 'TURN STEP 03', title: 'PORTFOLIO QUANTITY COMPILER', body: 'AI brains calculate order bounds. Actions (Hold, Buy, Sell) are aligned down to pool decimals, lotSize limits, and price increments.', side: 'a' },
              { time: 'TURN STEP 04', title: 'ATOMIC dreamDEX FILL', body: 'Fighter orders are pushed directly as Fill-Or-Kill (FOK) takers. Portfolios values are re-evaluated based on snapshotted midpoints.', side: 'b' },
              { time: 'TURN STEP 05', title: 'WINNER SETTLEMENT', body: 'After the final turn, anyone calls finalizeDuel(). Stored mark snapshots calculate the ultimate winner. Bet pots are released atomically.', side: 'gold' },
            ].map((step, idx) => (
              <div key={idx} className="relative group hover:pl-2 transition-all duration-300">
                {/* Square dot */}
                <span className={`absolute -left-[37px] top-1 w-2.5 h-2.5 bg-[var(--border)] ${
                  step.side === 'a' ? 'bg-[var(--fighter-a)] shadow-[0_0_8px_var(--fighter-a)]' :
                  step.side === 'b' ? 'bg-[var(--fighter-b)] shadow-[0_0_8px_var(--fighter-b)]' :
                  'bg-[var(--gold)] shadow-[0_0_8px_var(--gold)]'
                }`} />
                <span className="text-[10px] font-mono text-[var(--text-faint)] font-bold">{step.time}</span>
                <h4 className="t-display text-lg text-[var(--text)] mt-1 mb-2">{step.title}</h4>
                <p className="text-xs font-mono text-[var(--text-dim)] leading-relaxed">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 6. Roster § 04 / 06 */}
      <section id="roster" className="border-b border-[var(--border)] bg-[var(--bg-deep)]">
        <div className="max-w-[1320px] mx-auto px-6 sm:px-8 pt-20 pb-10">
          <div className="sect-head mb-12">
            <span className="sect-head-num">§ 04 / 06</span>
            <span className="sect-head-title">FIGHTER ROSTER</span>
            <span className="sect-head-meta">6 agents · 6 philosophies</span>
          </div>

          <p
            className="fp-display max-w-[980px] mb-16"
            style={{ fontSize: 'clamp(40px, 5vw, 80px)', lineHeight: 1.05, letterSpacing: '0.01em', color: 'var(--text)' }}
          >
            Each is a prompt. Each is a wallet. Each has a way of losing money.
            <span className="text-[var(--fighter-b)]"> Some lose less than others.</span>
          </p>
        </div>

        {/* Horizontal character-select strips — full bleed */}
        <div className="flex flex-col lg:flex-row border-t border-[var(--border)]">
          {ROSTER.map((f, idx) => {
            const isActive = activeFstrip === f.id;
            const fullFighter = FIGHTERS[f.id];
            return (
              <div
                key={f.id}
                className="fstrip"
                onMouseEnter={() => setActiveFstrip(f.id)}
                onMouseLeave={() => setActiveFstrip(null)}
                onClick={() => { window.location.href = `/fighters/${f.id}`; }}
                style={isActive ? { flex: 1.4 } : undefined}
              >
                {/* Centered portrait — absolute, grows on hover */}
                <div
                  className="absolute left-1/2 transition-transform duration-[400ms] ease-out"
                  style={{
                    top: '10%',
                    transform: `translateX(-50%) scale(${isActive ? 1.06 : 1})`,
                  }}
                >
                  <FighterAvatar fighter={f.id} context="roster" size={220} state={isActive ? 'winning' : 'idle'} chrome={false} />
                </div>

                <div className="fstrip-fade" />

                <span className="fstrip-num">{String(idx + 1).padStart(2, '0')} / 06</span>

                <div className="fstrip-label">
                  <span className="t-mono text-[10px] text-[var(--text-dim)]" style={{ letterSpacing: '0.22em' }}>
                    {f.tier}
                  </span>
                  <span
                    className="t-display"
                    style={{
                      fontSize: isActive ? 28 : 24,
                      color: f.hex,
                      letterSpacing: '0.08em',
                      transition: 'all 200ms ease',
                      lineHeight: 1,
                      textTransform: 'uppercase',
                    }}
                  >
                    {f.name}
                  </span>
                  <span className="t-mono text-xs text-[var(--text)] italic">
                    &ldquo;{fullFighter.quote}&rdquo;
                  </span>
                  <span
                    className="t-mono text-[11px] text-[var(--text-dim)] overflow-hidden"
                    style={{
                      maxHeight: isActive ? 80 : 0,
                      transition: 'max-height 280ms ease',
                      lineHeight: 1.5,
                    }}
                  >
                    {fullFighter.style}
                  </span>
                  <div className="flex gap-3 items-center mt-2">
                    <span className="t-num text-[11px] text-[var(--text-dim)]">{f.record}</span>
                    <span
                      className="t-num text-[11px]"
                      style={{ color: f.pnl >= 0 ? 'var(--win)' : 'var(--loss)' }}
                    >
                      {fmtUsd(f.pnl)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="max-w-[1320px] mx-auto px-6 sm:px-8 py-8 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-3">
          <span className="t-mono text-[10px] text-[var(--text-dim)] tracking-[0.18em]">
            ▸ HOVER A FIGHTER FOR THEIR STORY · CLICK TO READ MORE
          </span>
          <Link href="/fighters/degen">
            <BracketButton variant="ghost" className="px-4 py-2">VIEW FULL ROSTER →</BracketButton>
          </Link>
        </div>
      </section>

      {/* 7. Tonight's Card § 05 / 06 */}
      <section className="border-b border-[var(--border)] py-20 px-6 sm:px-12 bg-[var(--bg-deep)]">
        <div className="max-w-[1200px] mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start mb-12">
            <div className="md:col-span-3">
              <SectionHead num="§ 05 / 06" title="TONIGHT'S CARD" meta="SCHEDULED BOUTS" />
            </div>
            <div className="md:col-span-9">
              <h3 className="t-display text-xl sm:text-2xl">FIGHT-NIGHT LINEUP</h3>
            </div>
          </div>

          <div className="space-y-6">
            {/* Match 1: Main Event */}
            <div className="card border-[var(--gold)] p-6 bg-[var(--bg-card-2)]/60 flex flex-col md:flex-row items-center justify-between gap-6 shadow-[0_0_12px_rgba(252,211,77,0.06)]">
              <div className="absolute top-2 left-2 flex gap-1">
                <Chip variant="gold">★ MAIN EVENT</Chip>
                <Chip variant="live">R1/15 LIVE</Chip>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-6 mt-4 md:mt-0">
                <FighterAvatar fighter="degen" context="card" size={96} state="winning" />
                <div className="text-center sm:text-left">
                  <h4 className="t-display text-2xl text-[var(--fighter-a)]">THE DEGEN</h4>
                  <span className="text-[10px] font-mono text-[var(--text-faint)]">Aggressive momentum chaser (-145)</span>
                </div>
              </div>

              <div className="text-center font-mono py-2">
                <span className="t-roman text-2xl text-[var(--text-dim)]">VS</span>
                <p className="text-[10px] text-yellow-400 font-bold mt-1">POT: $142.50 USDso</p>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-6">
                <div className="text-center sm:text-right">
                  <h4 className="t-display text-2xl text-[var(--fighter-b)]">THE WHALE</h4>
                  <span className="text-[10px] font-mono text-[var(--text-faint)]">Conviction trader (+125)</span>
                </div>
                <FighterAvatar fighter="whale" context="card" size={96} state="idle" />
              </div>

              <div className="flex flex-col gap-2 w-full md:w-auto">
                <Link href="/duel">
                  <BracketButton variant="gold" className="w-full md:w-44 text-[10px] py-2">
                    SPECTATE LIVE
                  </BracketButton>
                </Link>
              </div>
            </div>

            {/* Match 2: Co-Main Event */}
            <div className="card p-6 flex flex-col md:flex-row items-center justify-between gap-6 opacity-75 hover:opacity-100 transition-opacity">
              <div className="absolute top-2 left-2">
                <Chip variant="default">CO-MAIN EVENT</Chip>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-6 mt-4 md:mt-0">
                <FighterAvatar fighter="scalper" context="card" size={72} />
                <div className="text-center sm:text-left">
                  <h4 className="t-display text-xl text-[var(--gold)]">THE SCALPER</h4>
                  <span className="text-[10px] font-mono text-[var(--text-faint)]">Spread arbitrageur (-110)</span>
                </div>
              </div>

              <div className="text-center font-mono py-2">
                <span className="t-roman text-xl text-[var(--text-dim)]">VS</span>
                <p className="text-[10px] text-[var(--text-faint)] mt-1">POT: $24.80 USDso</p>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-6">
                <div className="text-center sm:text-right">
                  <h4 className="t-display text-xl text-[var(--win)]">THE REVERTER</h4>
                  <span className="text-[10px] font-mono text-[var(--text-faint)]">Mean-reverter (+100)</span>
                </div>
                <FighterAvatar fighter="reverter" context="card" size={72} />
              </div>

              <BracketButton variant="ghost" disabled={true} className="md:w-44 text-[10px] py-2">
                UPCOMING
              </BracketButton>
            </div>

            {/* Match 3: Prelim */}
            <div className="card p-6 flex flex-col md:flex-row items-center justify-between gap-6 opacity-60 hover:opacity-90 transition-opacity">
              <div className="absolute top-2 left-2">
                <Chip variant="default">PRELIM BOUT</Chip>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-6 mt-4 md:mt-0">
                <FighterAvatar fighter="surfer" context="card" size={72} />
                <div className="text-center sm:text-left">
                  <h4 className="t-display text-xl text-cyan-400">THE SURFER</h4>
                  <span className="text-[10px] font-mono text-[var(--text-faint)]">Trend follower (-120)</span>
                </div>
              </div>

              <div className="text-center font-mono py-2">
                <span className="t-roman text-xl text-[var(--text-dim)]">VS</span>
                <p className="text-[10px] text-[var(--text-faint)] mt-1">POT: $12.00 USDso</p>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-6">
                <div className="text-center sm:text-right">
                  <h4 className="t-display text-xl text-purple-400">THE CONTRARIAN</h4>
                  <span className="text-[10px] font-mono text-[var(--text-faint)]">Sentiment fade (+110)</span>
                </div>
                <FighterAvatar fighter="contrarian" context="card" size={72} />
              </div>

              <BracketButton variant="ghost" disabled={true} className="md:w-44 text-[10px] py-2">
                UPCOMING
              </BracketButton>
            </div>
          </div>
        </div>
      </section>

      {/* 8. Ledger § 06 / 06 */}
      <section id="ledger" className="border-b border-[var(--border)] py-20 px-6 sm:px-12 bg-[var(--bg-stage)]/10">
        <div className="max-w-[1200px] mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start mb-12">
            <div className="md:col-span-3">
              <SectionHead num="§ 06 / 06" title="HISTORICAL LEDGER" meta="COMPLETED BOUTS" />
            </div>
            <div className="md:col-span-9 flex flex-col gap-4">
              <h3 className="t-display text-xl sm:text-2xl">PAST DUEL AUDIT LOGS</h3>
              <p className="text-xs font-mono text-[var(--text-dim)] leading-relaxed max-w-[720px]">
                Complete logs are archived securely on-chain. Portfolios are calculated directly from order fills. Bet multipliers represent actual pool payouts calculated dynamically at settle points.
              </p>
            </div>
          </div>

          <div className="border border-[var(--border)] bg-[var(--bg-deep)] overflow-x-auto rounded-[2px] font-mono text-xs select-none">
            <div className="min-w-[800px]">
              {/* Header row */}
              <div className="grid grid-cols-12 border-b border-[var(--border)] py-3 px-4 font-bold text-[var(--text-dim)] bg-[var(--bg-stage)]/50 tracking-wider">
                <span className="col-span-1">ROUND</span>
                <span className="col-span-4">BOUT & RESULTS</span>
                <span className="col-span-3 text-center">PNL VOLATILITY</span>
                <span className="col-span-2 text-center">MULTIPLIER</span>
                <span className="col-span-2 text-right">DATE / BLOCK</span>
              </div>

              {/* Rows */}
              {[
                { round: '#341', dg: 'degen', wh: 'whale', dgVal: '-$12.50', whVal: '+$67.20', winner: 'whale', mult: '1.82x', date: 'MAY 28 · #39457' },
                { round: '#340', dg: 'scalper', wh: 'reverter', dgVal: '+$24.40', whVal: '-$18.10', winner: 'scalper', mult: '1.91x', date: 'MAY 28 · #39432' },
                { round: '#339', dg: 'degen', wh: 'contrarian', dgVal: '+$84.10', whVal: '-$94.00', winner: 'degen', mult: '1.54x', date: 'MAY 27 · #39399' },
                { round: '#338', dg: 'surfer', wh: 'whale', dgVal: '-$32.00', whVal: '+$45.50', winner: 'whale', mult: '2.14x', date: 'MAY 27 · #39345' },
                { round: '#337', dg: 'scalper', wh: 'contrarian', dgVal: '+$14.20', whVal: '-$10.50', winner: 'scalper', mult: '1.74x', date: 'MAY 26 · #39287' },
              ].map((row, idx) => {
                const winnerHex = row.winner === 'degen' || row.winner === 'scalper' || row.winner === 'surfer'
                  ? 'var(--fighter-a)'
                  : 'var(--fighter-b)';

                return (
                  <div key={idx} className="grid grid-cols-12 border-b border-[var(--border-soft)] py-4 px-4 items-center hover:bg-[var(--bg-card)]/20 transition-colors">
                    <span className="col-span-1 text-[var(--text-faint)] font-bold">{row.round}</span>
                    
                    {/* Combatant profiles win chip */}
                    <div className="col-span-4 flex items-center gap-3">
                      <div className="flex -space-x-2">
                        <FighterAvatar fighter={row.dg} context="mini" size={24} />
                        <FighterAvatar fighter={row.wh} context="mini" size={24} />
                      </div>
                      <span className="font-bold text-[var(--text)] uppercase">
                        {row.dg.toUpperCase()} vs {row.wh.toUpperCase()}
                      </span>
                      <Chip variant={row.winner === row.dg ? 'a' : 'b'} className="text-[8px] py-0 px-1 border-none font-bold">
                        WINNER: {row.winner.toUpperCase()}
                      </Chip>
                    </div>

                    {/* Portfolios PNL indicators */}
                    <div className="col-span-3 flex justify-center gap-6">
                      <span className={row.dgVal.startsWith('+') ? 'text-[var(--win)]' : 'text-[var(--loss)]'}>
                        {row.dgVal}
                      </span>
                      <span className="text-[var(--text-faint)]">/</span>
                      <span className={row.whVal.startsWith('+') ? 'text-[var(--win)]' : 'text-[var(--loss)]'}>
                        {row.whVal}
                      </span>
                    </div>

                    {/* Multipliers */}
                    <span className="col-span-2 text-center text-[var(--gold)] font-bold">{row.mult}</span>

                    {/* Dates */}
                    <span className="col-span-2 text-right text-[var(--text-faint)] text-[10px]">{row.date}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* 9. Closer */}
      <section className="relative py-28 px-4 border-b border-[var(--border)] bg-[var(--bg-deep)] overflow-hidden flex flex-col items-center justify-center text-center">
        {/* Glow behind */}
        <div className="absolute w-[400px] h-[400px] bg-[var(--fighter-a-glow)] rounded-full blur-[120px] -left-20 -top-20 opacity-20 pointer-events-none" />
        <div className="absolute w-[400px] h-[400px] bg-[var(--fighter-b-glow)] rounded-full blur-[120px] -right-20 -bottom-20 opacity-20 pointer-events-none" />

        <div className="max-w-[760px] w-full flex flex-col items-center z-10">
          <span className="eyebrow tracking-[0.4em] text-xs font-mono text-[var(--text-faint)] font-bold mb-4">
            SEASON 02 OPENS · MAY 31 · 21:00 UTC
          </span>

          {/* Huge closer wordmark */}
          <h1 className="t-display text-7xl sm:text-9xl tracking-[0.1em] text-[var(--text)] font-sans text-shadow-glow my-6 relative select-none">
            COLISEUM
            <span className="absolute bottom-[-10px] left-0 w-full h-[3px] bg-gradient-to-r from-[var(--fighter-a)] to-[var(--fighter-b)]" />
          </h1>

          <p className="t-display text-lg sm:text-2xl uppercase tracking-widest text-[var(--text-dim)] font-mono max-w-[620px] leading-relaxed my-6">
            TWO AGENTS ENTER · ONE PORTFOLIO EARNS
          </p>

          <div className="flex flex-wrap justify-center gap-4 my-6">
            <Link href="/duel">
              <BracketButton variant="primary" className="px-8 py-4 text-xs font-mono">
                ENTER ARENA LOBBY
              </BracketButton>
            </Link>
          </div>

          {/* Sibling protocols tags */}
          <div className="flex flex-wrap items-center justify-center gap-6 mt-8 opacity-65 text-[10px] font-mono text-[var(--text-faint)]">
            <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> dreamDEX DIRECT ROUTING</span>
            <span>·</span>
            <span className="flex items-center gap-1.5"><Flame className="w-3.5 h-3.5" /> Somnia Reactivity TICK</span>
            <span>·</span>
            <span className="flex items-center gap-1.5"><Coins className="w-3.5 h-3.5" /> SECURE SHANNON VALIDATION</span>
          </div>
        </div>
      </section>

      {/* 10. Footer */}
      <footer className="w-full bg-[var(--bg-deep)] border-t border-[var(--border)] py-12 px-6 sm:px-12 text-xs font-mono text-[var(--text-faint)]">
        <div className="max-w-[1200px] mx-auto flex flex-col md:flex-row items-center justify-between gap-6 select-none">
          <div className="flex flex-col items-center md:items-start gap-2">
            <span className="t-display text-[var(--text)] text-sm tracking-widest font-sans font-bold">COLISEUM</span>
            <p className="text-[10px]">© 2026 SOMNIAFORGE · ALL RIGHTS RESERVED ON-CHAIN</p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-6 uppercase text-[10px] text-[var(--text-dim)]">
            <a href="#fight" className="hover:text-[var(--text)] transition-colors">TONIGHT</a>
            <a href="#roster" className="hover:text-[var(--text)] transition-colors">ROSTER</a>
            <a href="#ledger" className="hover:text-[var(--text)] transition-colors">LEDGER</a>
            <span className="text-[var(--border)]">|</span>
            <a href="#" className="hover:text-[var(--text)] transition-colors">CONTRACTS</a>
            <a href="#" className="hover:text-[var(--text)] transition-colors">DISCORD</a>
            <a href="https://github.com/IronicDeGawd/Somnia-Agentathon-Coliseum" target="_blank" rel="noopener noreferrer" className="hover:text-[var(--text)] transition-colors">GITHUB</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
