'use client';

import React, { useReducer, useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Play, TrendingUp, Users, Coins, HelpCircle, Shield, Award, Terminal, Activity, ArrowUpRight, ArrowDownRight, Square } from 'lucide-react';
import { TopBar } from '@/components/shared/TopBar';
import { Avatar } from '@/components/shared/Avatar';
import { Sparkline } from '@/components/shared/Sparkline';
import { OddsBar } from '@/components/shared/OddsBar';
import { AnimatedNumber } from '@/components/shared/AnimatedNumber';
import { Typewriter } from '@/components/shared/Typewriter';
import { BracketButton, Chip, Dot, SectionHead } from '@/components/shared/OtherHUD';
import { useUIStore } from '@/store/ui';
import { simReducer, makeInitialSim } from '@/lib/simulation';
import { FIGHTERS } from '@/lib/fighters';
import { fmtUsd, fmtPct } from '@/lib/format';

export default function ArenaPage() {
  const router = useRouter();
  const params = useParams();
  const layout = useUIStore((state) => state.layout);
  const audioOn = useUIStore((state) => state.audioOn);

  const [simState, dispatch] = useReducer(simReducer, makeInitialSim());
  const [activeTab, setActiveTab] = useState<'holdings' | 'orderbook'>('holdings');
  const [betPlaced, setBetPlaced] = useState<'degen' | 'whale' | null>(null);
  const [betAmount, setBetAmount] = useState<number>(0);

  // Clock Ticker to advance time and auto-advance turns
  useEffect(() => {
    const clock = setInterval(() => {
      dispatch({ type: 'TICK' });
    }, 1000);
    return () => clearInterval(clock);
  }, []);

  const handleAdvance = () => {
    dispatch({ type: 'ADVANCE' });
  };

  const handleFastForward = () => {
    dispatch({ type: 'FAST_FORWARD' });
  };

  const handlePlaceBet = (fighter: 'degen' | 'whale', amount: number) => {
    setBetPlaced(fighter);
    setBetAmount((prev) => prev + amount);
    dispatch({ type: 'PLACE_BET', fighter, amount, odds: fighter === 'degen' ? simState.oddsDegen : 100 - simState.oddsDegen });
  };

  // Determine leader for border glow
  const degenVal = simState.degen.pnl;
  const whaleVal = simState.whale.pnl;
  const degenIsLeading = degenVal >= whaleVal;

  // Simple BID/ASK heatmap grid items
  const heatmapFills = [
    { type: 'bid', size: 45, opacity: 0.6 },
    { type: 'bid', size: 12, opacity: 0.25 },
    { type: 'ask', size: 8, opacity: 0.2 },
    { type: 'ask', size: 34, opacity: 0.55 },
    { type: 'bid', size: 70, opacity: 0.8 },
    { type: 'ask', size: 55, opacity: 0.75 },
    { type: 'bid', size: 23, opacity: 0.4 },
    { type: 'ask', size: 18, opacity: 0.35 },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-deep)]">
      {/* top status area */}
      <TopBar showNavigation={false} />

      {/* Arena status sub-bar */}
      <section className="border-b border-[var(--border)] px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-4 font-mono uppercase text-xs" style={{ background: 'linear-gradient(90deg, var(--fighter-a-soft) 0%, transparent 35%, transparent 65%, var(--fighter-b-soft) 100%)' }}>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-[var(--text-faint)] font-bold">§ ARENA</span>
          <Chip variant="live">MAIN EVENT</Chip>
          <span className="font-bold text-[var(--text)]">ROUND #{simState.round}/15</span>
          <span className="text-[var(--gold)] flex items-center gap-1">
            <Dot variant="gold" pulse={true} className="w-1.5 h-1.5" />
            TURN CLOCK: {simState.timeLeft}s
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-6">
          <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-cyan-400" /> {simState.spectators} WATCHING</span>
          <span className="flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5 text-[var(--win)]" /> POT: {fmtUsd(simState.pot)}</span>
          <span className="h-4 w-[1px] bg-[var(--border)]" />
          <Link href="/duel">
            <BracketButton variant="ghost" className="text-[10px] py-1 px-3">
              LEAVE ARENA
            </BracketButton>
          </Link>
        </div>
      </section>

      {/* Main Grid: Combatants & Sidebar details */}
      <main className="flex-1 shell-pad grid grid-cols-1 xl:grid-cols-12 gap-8 py-8 items-start">
        
        {/* Left 8 Cols: Fighting Ring Combatants & LLM Feed */}
        <div className="xl:col-span-8 flex flex-col gap-8">
          
          {/* § COMBATANTS */}
          <div>
            <div className="flex justify-between items-center mb-4">
              <span className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider">§ COMBATANTS</span>
              <div className="flex gap-2">
                <Chip variant="a">RED: DEGEN</Chip>
                <Chip variant="b">BLUE: WHALE</Chip>
              </div>
            </div>

            {/* Layout modes controlled by state */}
            <div className={`grid gap-6 ${
              layout === 'split' ? 'grid-cols-1 md:grid-cols-2' :
              layout === 'oneUp' ? 'grid-cols-1' :
              'grid-cols-1'
            }`}>
              
              {/* Fighter A: THE DEGEN Card */}
              <div
                className={`card p-6 bg-[var(--bg-stage)]/30 rounded-[2px] transition-all duration-300 flex flex-col justify-between ${
                  degenIsLeading && degenVal >= 0 ? 'shadow-[0_0_24px_rgba(255,51,102,0.12)]' : ''
                } ${layout === 'oneUp' && !degenIsLeading ? 'scale-95 opacity-75' : ''}`}
                style={{ minHeight: layout === 'stacked' ? '280px' : '380px', borderColor: '#ff3366' }}
              >
                {/* Header ribbon bar */}
                <div className="flex justify-between items-center border-b border-[var(--border-soft)] pb-3 mb-4 text-[10px] text-[var(--text-dim)] font-mono uppercase">
                  <div className="flex items-center gap-1.5">
                    <Chip variant="a">DG</Chip>
                    <span>RED CORNER · AGGRESSOR</span>
                  </div>
                  <Chip variant={degenIsLeading ? 'live' : 'default'} className="text-[8px] py-0 px-1 border-none font-bold">
                    {degenIsLeading ? 'LEADING' : 'CHASING'}
                  </Chip>
                </div>

                {/* Profile row */}
                <div className="flex items-center gap-4 mb-4">
                  <Avatar fighter="degen" size={layout === 'stacked' ? 64 : 80} variant="shield" state={degenIsLeading ? 'winning' : 'idle'} />
                  <div>
                    <h3 className="t-display text-xl text-[var(--text)] uppercase font-sans">THE DEGEN</h3>
                    <p className="text-[10px] text-[var(--text-faint)] font-mono italic">"Send it. Always."</p>
                  </div>
                </div>

                {/* PNL Block */}
                <div className="border-t border-[var(--border-soft)] py-4 my-2 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-[var(--text-faint)] font-mono block">PORTFOLIO PNL</span>
                    <div className={`text-2xl sm:text-3xl font-mono font-bold leading-none mt-1 ${
                      degenVal >= 0 ? 'text-[var(--win)]' : 'text-[var(--loss)]'
                    }`}>
                      {fmtUsd(degenVal)}
                    </div>
                  </div>
                  
                  <div className="w-48 h-10 hidden sm:block">
                    <Sparkline data={simState.degen.history} color="var(--fighter-a)" height={38} />
                  </div>
                </div>

                {/* Tokens Holdings tabs */}
                <div className="border-t border-[var(--border-soft)] pt-4 mt-2 text-xs font-mono text-[var(--text-dim)] space-y-2.5">
                  <span className="text-[9px] text-[var(--text-faint)] uppercase block tracking-wider">PORTFOLIO HOLDINGS</span>
                  {simState.degen.holdings.map((hold) => (
                    <div key={hold.token} className="flex flex-col gap-1">
                      <div className="flex justify-between items-center text-[10px]">
                        <span>{hold.token} ({hold.amount})</span>
                        <span>{hold.pct}%</span>
                      </div>
                      <div className="w-full h-1 bg-slate-900 overflow-hidden rounded-full">
                        <div className="h-full bg-[var(--fighter-a)]" style={{ width: `${hold.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Fighter B: THE WHALE Card */}
              <div
                className={`card p-6 bg-[var(--bg-stage)]/30 rounded-[2px] transition-all duration-300 flex flex-col justify-between ${
                  !degenIsLeading && whaleVal >= 0 ? 'shadow-[0_0_24px_rgba(0,217,255,0.12)]' : ''
                } ${layout === 'oneUp' && degenIsLeading ? 'scale-95 opacity-75' : ''}`}
                style={{ minHeight: layout === 'stacked' ? '280px' : '380px', borderColor: '#00d9ff' }}
              >
                {/* Header ribbon bar */}
                <div className="flex justify-between items-center border-b border-[var(--border-soft)] pb-3 mb-4 text-[10px] text-[var(--text-dim)] font-mono uppercase">
                  <div className="flex items-center gap-1.5">
                    <Chip variant="b">WH</Chip>
                    <span>BLUE CORNER · TACTICIAN</span>
                  </div>
                  <Chip variant={!degenIsLeading ? 'live' : 'default'} className="text-[8px] py-0 px-1 border-none font-bold">
                    {!degenIsLeading ? 'LEADING' : 'CHASING'}
                  </Chip>
                </div>

                {/* Profile row */}
                <div className="flex items-center gap-4 mb-4">
                  <Avatar fighter="whale" size={layout === 'stacked' ? 64 : 80} variant="helm" state={!degenIsLeading ? 'winning' : 'idle'} />
                  <div>
                    <h3 className="t-display text-xl text-[var(--text)] uppercase font-sans">THE WHALE</h3>
                    <p className="text-[10px] text-[var(--text-faint)] font-mono italic">"I'll wait for it."</p>
                  </div>
                </div>

                {/* PNL Block */}
                <div className="border-t border-[var(--border-soft)] py-4 my-2 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-[var(--text-faint)] font-mono block">PORTFOLIO PNL</span>
                    <div className={`text-2xl sm:text-3xl font-mono font-bold leading-none mt-1 ${
                      whaleVal >= 0 ? 'text-[var(--win)]' : 'text-[var(--loss)]'
                    }`}>
                      {fmtUsd(whaleVal)}
                    </div>
                  </div>
                  
                  <div className="w-48 h-10 hidden sm:block">
                    <Sparkline data={simState.whale.history} color="var(--fighter-b)" height={38} />
                  </div>
                </div>

                {/* Tokens Holdings tabs */}
                <div className="border-t border-[var(--border-soft)] pt-4 mt-2 text-xs font-mono text-[var(--text-dim)] space-y-2.5">
                  <span className="text-[9px] text-[var(--text-faint)] uppercase block tracking-wider">PORTFOLIO HOLDINGS</span>
                  {simState.whale.holdings.map((hold) => (
                    <div key={hold.token} className="flex flex-col gap-1">
                      <div className="flex justify-between items-center text-[10px]">
                        <span>{hold.token} ({hold.amount})</span>
                        <span>{hold.pct}%</span>
                      </div>
                      <div className="w-full h-1 bg-slate-900 overflow-hidden rounded-full">
                        <div className="h-full bg-[var(--fighter-b)]" style={{ width: `${hold.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </div>

          {/* § FEED: Reasoning panel */}
          <div>
            <div className="flex justify-between items-center mb-4">
              <span className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5" /> § REASONING FEED
              </span>
              <Chip variant="live">LIVE LOGS</Chip>
            </div>

            <div className="card p-6 bg-black/60 rounded-[2px] border-slate-800 font-mono text-xs text-[var(--text-dim)] leading-relaxed space-y-4 max-h-[300px] overflow-y-auto">
              {/* Degen Reasoning */}
              <div className="flex items-start gap-3">
                <span className="text-[var(--fighter-a)] font-bold font-sans tracking-wide">DG:</span>
                <div className="flex-1 bg-[var(--bg-stage)]/40 p-3 border border-l-2 border-l-[var(--fighter-a)] border-[var(--border-soft)]">
                  <Typewriter text={simState.degen.reasoning} speed={35} className="text-[var(--text)] font-mono" />
                </div>
              </div>

              {/* Whale Reasoning */}
              <div className="flex items-start gap-3">
                <span className="text-[var(--fighter-b)] font-bold font-sans tracking-wide">WH:</span>
                <div className="flex-1 bg-[var(--bg-stage)]/40 p-3 border border-l-2 border-l-[var(--fighter-b)] border-[var(--border-soft)]">
                  <Typewriter text={simState.whale.reasoning} speed={35} className="text-[var(--text)] font-mono" />
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Right 4 Cols: Marketplace orderbook, betting slots, and manual tickers */}
        <div className="xl:col-span-4 space-y-8">
          
          {/* § MARKETPLACE DETAILS */}
          <div>
            <div className="flex justify-between items-center mb-4">
              <span className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> § MARKET HEATMAP
              </span>
              <span className="text-[10px] text-emerald-400 font-bold">dreamDEX</span>
            </div>

            <div className="card p-4 bg-[var(--bg-stage)]/20 rounded-[2px] space-y-4">
              {/* bid ask cards */}
              <div className="grid grid-cols-2 gap-4 text-xs font-mono text-center">
                <div className="border border-[var(--border-soft)] p-2">
                  <span className="text-[9px] text-[var(--text-faint)] uppercase font-bold">BEST BID</span>
                  <span className="text-sm font-bold text-[var(--win)] block mt-1">${simState.market.bid}</span>
                </div>
                <div className="border border-[var(--border-soft)] p-2">
                  <span className="text-[9px] text-[var(--text-faint)] uppercase font-bold">BEST ASK</span>
                  <span className="text-sm font-bold text-[var(--loss)] block mt-1">${simState.market.ask}</span>
                </div>
              </div>

              {/* Heatmap Grid blocks */}
              <div className="grid grid-cols-8 gap-1.5 h-16 border border-slate-900 p-1.5 bg-black/40">
                {heatmapFills.map((fill, i) => (
                  <div
                    key={i}
                    className={`h-full transition-all duration-300 ${
                      fill.type === 'bid' ? 'bg-[var(--win)]' : 'bg-[var(--loss)]'
                    }`}
                    style={{ opacity: fill.opacity }}
                  />
                ))}
              </div>

              <div className="flex justify-between text-[10px] font-mono text-[var(--text-faint)] uppercase pt-1">
                <span>VOL 24H: ${simState.market.vol.toLocaleString()}</span>
                <span>RATIO: {simState.market.buyRatio * 100}% BUY</span>
              </div>
            </div>
          </div>

          {/* § BOOK BETTING DRAWERS */}
          <div>
            <SectionHead num="§ BOOK" title="BETTING SLIPS" />

            <div className="card border-[var(--border)] mt-4 p-4 bg-[var(--bg-deep)]/90 rounded-[2px] space-y-4">
              <div className="flex justify-between items-center text-[10px] font-mono text-[var(--text-dim)] uppercase">
                <span>DEGEN odds: {simState.oddsDegen}%</span>
                <span>WHALE odds: {100 - simState.oddsDegen}%</span>
              </div>
              <OddsBar oddsA={simState.oddsDegen} oddsB={100 - simState.oddsDegen} />

              {/* Wallet connection / placement */}
              <div className="border-t border-[var(--border-soft)] pt-4 space-y-3">
                {betPlaced ? (
                  <div className="text-center py-2 border border-dashed border-[var(--gold)]/30 rounded-[2px] bg-yellow-950/10">
                    <p className="text-[10px] font-bold text-[var(--gold)] uppercase">
                      BET CONFIRMED AT LOCKED ODDS!
                    </p>
                    <p className="text-xs font-mono text-[var(--text)] mt-1">
                      ${betAmount.toFixed(2)} USDSO STAKED ON {betPlaced.toUpperCase()}
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-[10px] text-[var(--text-faint)] font-bold uppercase text-center mb-2">
                      SELECT COMBATANT TO BACK
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <BracketButton variant="a" onClick={() => handlePlaceBet('degen', 2)} className="text-[10px] py-2 leading-none">
                        BACK DEGEN +$2
                      </BracketButton>
                      <BracketButton variant="b" onClick={() => handlePlaceBet('whale', 2)} className="text-[10px] py-2 leading-none">
                        BACK WHALE +$2
                      </BracketButton>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Simulation advances controllers */}
          <div className="space-y-3 border-t border-[var(--border)] pt-6">
            <span className="text-[10px] text-[var(--text-faint)] font-bold uppercase block tracking-wider text-center">
              DEMO SIMULATOR INTERACTION CONTROLS
            </span>
            
            {simState.round >= 15 ? (
              <Link href={`/duel/${params?.id || 1}/result`} className="block w-full">
                <BracketButton variant="gold" className="w-full text-xs py-3.5 leading-none">
                  ★ BOUT CONCLUDED. SEE WINNER →
                </BracketButton>
              </Link>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <BracketButton variant="primary" onClick={handleAdvance} className="text-[10px] py-2">
                  ADVANCE TURN (R+{simState.round})
                </BracketButton>
                <BracketButton variant="ghost" onClick={handleFastForward} className="text-[10px] py-2 border-[var(--border)] hover:border-slate-600">
                  FAST-FORWARD Match
                </BracketButton>
              </div>
            )}
          </div>

        </div>

      </main>
    </div>
  );
}
