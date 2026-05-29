'use client';

import React, { useReducer, useEffect, useState } from 'react';
import Link from 'next/link';
import { Play, TrendingUp, Users, Coins, HelpCircle, Shield, Award, ChevronRight, Sparkles } from 'lucide-react';
import { TopBar } from '@/components/shared/TopBar';
import { Avatar } from '@/components/shared/Avatar';
import { Sparkline } from '@/components/shared/Sparkline';
import { OddsBar } from '@/components/shared/OddsBar';
import { BracketButton, Chip, Dot, SectionHead, PnLBlock } from '@/components/shared/OtherHUD';
import { simReducer, makeInitialSim } from '@/lib/simulation';
import { FIGHTERS, ROSTER } from '@/lib/fighters';
import { fmtUsd, fmtPct } from '@/lib/format';

export default function LobbyPage() {
  const [simState, dispatch] = useReducer(simReducer, makeInitialSim());
  const [backedFighterId, setBackedFighterId] = useState<'degen' | 'whale' | null>(null);

  // Active game loop ticking for the simulation
  useEffect(() => {
    const clock = setInterval(() => {
      dispatch({ type: 'TICK' });
    }, 1000);
    return () => clearInterval(clock);
  }, []);

  const handlePlaceBet = (fighter: 'degen' | 'whale') => {
    setBackedFighterId(fighter);
    dispatch({ type: 'PLACE_BET', fighter, amount: 10, odds: fighter === 'degen' ? simState.oddsDegen : 100 - simState.oddsDegen });
  };

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-deep)]">
      {/* Navigation TopBar */}
      <TopBar showNavigation={false} />

      {/* Lobby Hero Banner / Marquee */}
      <section className="relative border-b border-[var(--border)] px-6 py-12 bg-slate-950/20 text-center flex flex-col items-center justify-center overflow-hidden">
        {/* Faded background vectors */}
        <div className="absolute top-1/2 left-10 -translate-y-1/2 opacity-[0.06] hidden md:block">
          <Avatar fighter="degen" size={140} variant="shield" showChrome={false} />
        </div>
        <div className="absolute top-1/2 right-10 -translate-y-1/2 opacity-[0.06] hidden md:block">
          <Avatar fighter="whale" size={140} variant="helm" showChrome={false} />
        </div>

        <div className="z-10 flex flex-col items-center">
          <div className="flex items-center gap-2 mb-3">
            <Dot variant="a" pulse={true} />
            <Chip variant="live">ARENA LOBBY ACTIVE</Chip>
          </div>
          <h2 className="t-display text-4xl sm:text-5xl uppercase tracking-tighter text-[var(--text)]">
            THE DEGEN vs THE WHALE
          </h2>
          <p className="text-xs font-mono text-[var(--text-faint)] tracking-widest mt-2 uppercase">
            dreamDEX CLOB · TONIGHT'S FEATURE BOUT · 15 TURNS ACTIVE
          </p>

          {/* Quick HUD specs */}
          <div className="flex flex-wrap items-center justify-center gap-8 mt-6 border-t border-b border-[var(--border-soft)] py-3 px-6 text-xs text-[var(--text-dim)] font-mono">
            <span className="flex items-center gap-1.5"><Play className="w-3.5 h-3.5 text-[var(--gold)]" /> ROUND {simState.round}/15</span>
            <span className="flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5 text-[var(--win)]" /> POT: {fmtUsd(simState.pot)}</span>
            <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-cyan-400" /> SPECTATORS: {simState.spectators}</span>
          </div>

          {/* Enter buttons */}
          <div className="flex flex-wrap gap-4 mt-6">
            <BracketButton variant="a" onClick={() => handlePlaceBet('degen')} disabled={!!backedFighterId} className="w-48 text-[10px]">
              {backedFighterId === 'degen' ? 'BACKED' : 'BACK DEGEN +$10'}
            </BracketButton>
            <Link href="/duel/1/preduel">
              <BracketButton variant="primary" className="w-48 text-[10px]">
                ENTER PRE-DUEL →
              </BracketButton>
            </Link>
            <BracketButton variant="b" onClick={() => handlePlaceBet('whale')} disabled={!!backedFighterId} className="w-48 text-[10px]">
              {backedFighterId === 'whale' ? 'BACKED' : 'BACK WHALE +$10'}
            </BracketButton>
          </div>
        </div>
      </section>

      {/* Main Lobby body */}
      <main className="shell-pad grid grid-cols-1 lg:grid-cols-12 gap-8 items-start select-none">
        
        {/* Left Column: § 01 LIVE NOW & § 03 YOUR LEDGER */}
        <div className="lg:col-span-8 space-y-8">
          
          {/* § 01 LIVE NOW */}
          <div>
            <SectionHead num="§ 01" title="LIVE BROADCAST" meta="REALTIME COMBAT" />
            
            <div className="card border-[var(--fighter-a)] mt-4 p-6 bg-[var(--bg-stage)]/30 rounded-[2px] shadow-[0_0_12px_rgba(255,51,102,0.04)]">
              {/* Header card strip */}
              <div className="flex justify-between items-center border-b border-[var(--border-soft)] pb-4 mb-6 text-xs text-[var(--text-dim)] font-mono">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse shadow-[0_0_6px_#34d399]" />
                  <span className="font-bold text-[var(--text)]">ROUND #{simState.round}/15</span>
                  <Chip variant="live">LIVE</Chip>
                </div>
                <div>
                  <span>NEXT ADVANCE IN: {simState.timeLeft}s</span>
                </div>
              </div>

              {/* Sparklines side-by-side */}
              <div className="grid grid-cols-1 md:grid-cols-11 items-center gap-6 mb-6">
                <div className="md:col-span-5 flex flex-col gap-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-[var(--fighter-a)] font-bold font-sans">THE DEGEN</span>
                    <span className="font-mono text-[var(--win)] font-bold">{fmtUsd(simState.degen.pnl)}</span>
                  </div>
                  <Sparkline data={simState.degen.history} color="var(--fighter-a)" height={50} />
                </div>

                <div className="md:col-span-1 text-center font-mono font-bold text-slate-600 text-lg">
                  VS
                </div>

                <div className="md:col-span-5 flex flex-col gap-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-[var(--fighter-b)] font-bold font-sans">THE WHALE</span>
                    <span className="font-mono text-[var(--win)] font-bold">{fmtUsd(simState.whale.pnl)}</span>
                  </div>
                  <Sparkline data={simState.whale.history} color="var(--fighter-b)" height={50} />
                </div>
              </div>

              {/* Odds splitter */}
              <div className="border-t border-[var(--border-soft)] pt-4">
                <div className="flex justify-between items-center text-[10px] font-mono text-[var(--text-dim)] mb-2 uppercase">
                  <span>DEGEN odds: {simState.oddsDegen}%</span>
                  <span>WHALE odds: {100 - simState.oddsDegen}%</span>
                </div>
                <OddsBar oddsA={simState.oddsDegen} oddsB={100 - simState.oddsDegen} />
              </div>

              <div className="flex justify-end mt-6">
                <Link href="/duel/1">
                  <BracketButton variant="gold" className="text-[10px] px-6">
                    JOIN SPECTATORS AREA →
                  </BracketButton>
                </Link>
              </div>
            </div>
          </div>

          {/* § 03 YOUR LEDGER */}
          <div>
            <SectionHead num="§ 03" title="YOUR LEDGER" meta="BETTING ARCHIVE" />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              {/* Card 1: Active Bet */}
              <div className="card p-4 bg-[var(--bg-card-2)]/40 rounded-[2px] border-slate-700/60">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-[10px] text-[var(--text-faint)] font-bold">ROUND #342</span>
                  <Chip variant={backedFighterId ? 'live' : 'default'} className="text-[8px] py-0 px-1 border-none font-bold">
                    {backedFighterId ? 'LIVE IN PLAY' : 'NO ACTIVE BET'}
                  </Chip>
                </div>
                <h4 className="text-xs font-bold text-[var(--text)] uppercase">
                  {backedFighterId ? `BACKED THE ${backedFighterId.toUpperCase()}` : 'NO MATCH BET PLACED'}
                </h4>
                <div className="flex justify-between items-center text-xs font-mono border-t border-[var(--border-soft)] pt-3 mt-3 text-[var(--text-dim)]">
                  <span>STAKE: {backedFighterId ? '$10.00 USDso' : '--'}</span>
                  <span className="text-[var(--gold)]">
                    {backedFighterId ? `${backedFighterId === 'degen' ? simState.oddsDegen : 100 - simState.oddsDegen}% ODDS` : '--'}
                  </span>
                </div>
              </div>

              {/* Card 2: Past Bet */}
              <div className="card p-4 bg-[var(--bg-stage)]/10 rounded-[2px]">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-[10px] text-[var(--text-faint)] font-bold">ROUND #341</span>
                  <Chip variant="win" className="text-[8px] py-0 px-1 border-none font-bold">SETTLED: WON</Chip>
                </div>
                <h4 className="text-xs font-bold text-[var(--text)] uppercase">BACKED THE WHALE</h4>
                <div className="flex justify-between items-center text-xs font-mono border-t border-[var(--border-soft)] pt-3 mt-3 text-[var(--text-dim)]">
                  <span>STAKE: $5.00 USDso</span>
                  <span className="text-[var(--win)] font-bold">+$9.10 USDso</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: § 02 STANDINGS */}
        <div className="lg:col-span-4">
          <SectionHead num="§ 02" title="STANDINGS" meta="SEASON LEADERBOARD" />
          
          <div className="card border-[var(--border)] mt-4 p-4 bg-[var(--bg-deep)]/90 rounded-[2px] space-y-4">
            <div className="text-[10px] font-bold text-[var(--text-faint)] border-b border-[var(--border-soft)] pb-2 flex justify-between uppercase">
              <span>FIGHTER</span>
              <div className="flex gap-8">
                <span>RECORD</span>
                <span>PNL</span>
              </div>
            </div>

            {ROSTER.map((fighter, idx) => {
              const fullFighter = FIGHTERS[fighter.id];
              const pnlClass = fighter.pnl >= 0 ? 'text-[var(--win)]' : 'text-[var(--loss)]';

              return (
                <div key={fighter.id} className="flex flex-col gap-2 border-b border-[var(--border-soft)] pb-3 last:border-b-0 last:pb-0">
                  <div className="flex items-center justify-between text-xs">
                    {/* Rank, Name */}
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500 font-bold">{idx + 1}</span>
                      <Avatar fighter={fighter.id} size={28} variant="shield" showChrome={false} />
                      <div className="flex flex-col">
                        <Link href={`/fighters/${fighter.id}`} className="font-bold text-[var(--text)] hover:underline uppercase">
                          {fighter.name.split(' ')[1] || fighter.name}
                        </Link>
                        <span className="text-[9px] text-[var(--text-faint)] uppercase">{fighter.tier}</span>
                      </div>
                    </div>

                    {/* Record / PNL */}
                    <div className="flex items-center gap-6 font-mono">
                      <span className="text-[10px] text-slate-400">{fighter.record}</span>
                      <span className={`font-bold ${pnlClass}`}>{fmtUsd(fighter.pnl)}</span>
                    </div>
                  </div>

                  {/* Center-zero custom form bar */}
                  <div className="w-full h-1.5 bg-slate-900 border border-slate-800 relative mt-1 flex">
                    <div className="w-1/2 h-full flex justify-end">
                      {fighter.pnl < 0 && (
                        <div
                          className="h-full bg-[var(--loss)]"
                          style={{ width: `${Math.min(100, (Math.abs(fighter.pnl) / 150) * 100)}%` }}
                        />
                      )}
                    </div>
                    {/* center line */}
                    <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-slate-500" />
                    <div className="w-1/2 h-full">
                      {fighter.pnl > 0 && (
                        <div
                          className="h-full bg-[var(--win)]"
                          style={{ width: `${Math.min(100, (fighter.pnl / 350) * 100)}%` }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
