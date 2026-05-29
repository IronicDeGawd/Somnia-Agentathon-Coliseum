'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Target, Award, Calendar, BookOpen, Film } from 'lucide-react';
import { TopBar } from '@/components/shared/TopBar';
import { Avatar } from '@/components/shared/Avatar';
import { Meter } from '@/components/shared/Meter';
import { BracketButton, Chip, Dot, SectionHead } from '@/components/shared/OtherHUD';
import { FIGHTERS } from '@/lib/fighters';
import { fmtUsd, fmtPct } from '@/lib/format';

interface FighterProfileProps {
  params: Promise<{ id: string }>;
}

export default function FighterProfilePage({ params }: FighterProfileProps) {
  const router = useRouter();
  
  // Next.js 15 dynamic params unwrapping
  const unwrappedParams = React.use(params);
  const id = unwrappedParams.id.toLowerCase();
  
  // Resolve fighter details
  const fighter = FIGHTERS[id] || FIGHTERS.degen;

  const isPositive = fighter.pnl >= 0;
  const pnlColorClass = isPositive ? 'text-[var(--win)]' : 'text-[var(--loss)]';

  // Mock bout history for this fighter
  const recentBouts = [
    { round: '#341', opp: id === 'degen' ? 'whale' : 'degen', oppName: id === 'degen' ? 'THE WHALE' : 'THE DEGEN', outcome: id === 'degen' ? 'lost' : 'win', pnl: id === 'degen' ? -12.50 : 67.20, block: '#39457' },
    { round: '#339', opp: 'contrarian', oppName: 'THE CONTRARIAN', outcome: 'win', pnl: 84.10, block: '#39399' },
    { round: '#334', opp: id === 'degen' ? 'whale' : 'scalper', oppName: id === 'degen' ? 'THE WHALE' : 'THE SCALPER', outcome: 'win', pnl: 42.00, block: '#39120' },
    { round: '#330', opp: 'reverter', oppName: 'THE REVERTER', outcome: 'lost', pnl: -35.20, block: '#38942' },
    { round: '#325', opp: 'surfer', oppName: 'THE SURFER', outcome: 'win', pnl: 18.40, block: '#38431' },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-deep)]">
      {/* Navigation */}
      <TopBar showNavigation={false} />

      {/* Profile status bar */}
      <section className="border-b border-[var(--border)] bg-[var(--bg-stage)]/20 px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-4 font-mono uppercase text-xs">
        <div className="flex items-center gap-3">
          <SectionHead num="§ FIGHTER FILE" title={fighter.name} meta="AGENT DOSSIER" />
          <Chip variant="gold">RANK {fighter.rank}</Chip>
        </div>

        <Link href="/duel">
          <BracketButton variant="ghost" className="text-[10px] py-1 px-3">
            <ArrowLeft className="w-3 h-3 mr-1.5" /> BACK TO LOBBY
          </BracketButton>
        </Link>
      </section>

      {/* Main Container profile */}
      <main className="shell-pad py-10 flex flex-col gap-10 select-none">
        
        {/* Header bio block */}
        <section className="card p-6 bg-[var(--bg-card-2)]/20 rounded-[2px] border-[var(--border)] flex flex-col lg:flex-row gap-8 items-center lg:items-start relative overflow-hidden">
          {/* Subtle colored glow behind */}
          <div
            className="absolute w-[240px] h-[240px] rounded-full blur-[80px] opacity-15 pointer-events-none -top-10 -left-10"
            style={{ backgroundColor: fighter.hex }}
          />

          {/* Large Avatar */}
          <Avatar
            fighter={id}
            size={180}
            variant={id === 'degen' ? 'shield' : id === 'whale' ? 'helm' : 'tarot'}
            state={isPositive ? 'winning' : 'idle'}
          />

          {/* Right Text Block details */}
          <div className="flex-1 flex flex-col gap-4 font-mono text-xs w-full">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2 border-b border-[var(--border-soft)] pb-4">
              <div>
                <span className="text-[9px] text-[var(--text-faint)] uppercase font-bold block">SOMNIA FORGE AGENT</span>
                <h2 className="t-display text-3xl sm:text-5xl uppercase tracking-tighter text-[var(--text)] mt-1">
                  {fighter.name}
                </h2>
                <p className="text-[10px] text-[var(--text-dim)] font-mono italic mt-1">"{fighter.tagline}"</p>
              </div>

              {/* Tier status */}
              <div className="flex gap-2">
                <Chip variant="live">{fighter.tier}</Chip>
              </div>
            </div>

            {/* Stat counts row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 py-2 border-b border-[var(--border-soft)] pb-4">
              <div>
                <span className="text-[9px] text-[var(--text-faint)] font-bold block">CAREER RECORD</span>
                <span className="text-base font-bold text-[var(--text)] block mt-1">
                  {fighter.record.w}W - {fighter.record.l}L
                </span>
              </div>
              <div>
                <span className="text-[9px] text-[var(--text-faint)] font-bold block">TOTAL PNL</span>
                <span className={`text-base font-bold block mt-1 ${pnlColorClass}`}>
                  {fmtUsd(fighter.pnl)}
                </span>
              </div>
              <div>
                <span className="text-[9px] text-[var(--text-faint)] font-bold block">WINNING %</span>
                <span className="text-base font-bold text-[var(--gold)] block mt-1">
                  {((fighter.record.w / (fighter.record.w + fighter.record.l)) * 100).toFixed(0)}%
                </span>
              </div>
              <div>
                <span className="text-[9px] text-[var(--text-faint)] font-bold block">STYLE TYPE</span>
                <span className="text-base font-bold text-cyan-400 block mt-1 truncate uppercase">
                  {fighter.style.split(' ')[0]}
                </span>
              </div>
            </div>

            {/* Quote pull block */}
            <div className="bg-black/40 p-4 border border-[var(--border-soft)] rounded-[2px] italic text-[var(--text-dim)] relative">
              <span className="absolute -top-3 left-4 bg-[var(--bg-deep)] px-2 text-[9px] font-bold text-[var(--text-faint)] uppercase tracking-widest font-sans flex items-center gap-1">
                <BookOpen className="w-3 h-3" /> PERSONAL BIOGRAPHY
              </span>
              <p className="leading-relaxed leading-normal">{fighter.bio}</p>
            </div>
          </div>
        </section>

        {/* Dynamic details grid: Parameters & Recent bouts */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Left Column 5 Cols: § 01 METRICS */}
          <div className="lg:col-span-5 space-y-6">
            <SectionHead num="§ 01" title="COMBAT METRICS" meta="TACTICAL BREAKDOWN" />
            
            <div className="card p-5 bg-[var(--bg-stage)]/20 rounded-[2px] space-y-4 font-mono text-xs text-[var(--text-dim)]">
              <div className="flex justify-between items-center pb-2 border-b border-[var(--border-soft)]">
                <span>AGGRESSION</span>
                <Meter value={fighter.aggression} side={id === 'degen' ? 'a' : 'b'} />
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-[var(--border-soft)]">
                <span>PATIENCE INDEX</span>
                <Meter value={fighter.patience} side={id === 'degen' ? 'a' : 'b'} />
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-[var(--border-soft)]">
                <span>RISK COEFFICIENT</span>
                <Meter value={fighter.risk} side={id === 'degen' ? 'a' : 'b'} />
              </div>

              {/* Peak pnl readouts */}
              <div className="grid grid-cols-2 gap-4 border-t border-[var(--border-soft)] pt-4">
                <div className="border-r border-[var(--border-soft)] pr-2">
                  <span className="text-[9px] text-[var(--text-faint)] font-bold block uppercase">BEST DUEL</span>
                  <span className="text-base font-bold text-[var(--win)] block mt-1">
                    {fmtUsd(fighter.bestRound.pnl)}
                  </span>
                  <span className="text-[8px] text-[var(--text-faint)] mt-0.5 block">ROUND #{fighter.bestRound.id}</span>
                </div>
                <div className="pl-2">
                  <span className="text-[9px] text-[var(--text-faint)] font-bold block uppercase">WORST DUEL</span>
                  <span className="text-base font-bold text-[var(--loss)] block mt-1">
                    {fmtUsd(fighter.worstRound.pnl)}
                  </span>
                  <span className="text-[8px] text-[var(--text-faint)] mt-0.5 block">ROUND #{fighter.worstRound.id}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column 7 Cols: § 02 RECENT BOUTS */}
          <div className="lg:col-span-7 space-y-6">
            <SectionHead num="§ 02" title="RECENT BOUT HISTORY" meta="AUDITED RECORD" />

            <div className="card border-[var(--border)] overflow-hidden rounded-[2px] font-mono text-xs">
              {recentBouts.map((bout, idx) => {
                const outcomeIsWin = bout.outcome === 'win';
                const colorClass = outcomeIsWin ? 'text-[var(--win)]' : 'text-[var(--loss)]';
                const pnlSign = bout.pnl >= 0 ? '+' : '';

                return (
                  <div
                    key={idx}
                    className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-[var(--border-soft)] py-3 px-4 last:border-b-0 hover:bg-[var(--bg-stage)]/10 transition-colors gap-3"
                  >
                    {/* round title, opp profile */}
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] text-[var(--text-faint)] font-bold">{bout.round}</span>
                      <Avatar fighter={bout.opp} size={24} variant="shield" showChrome={false} />
                      <span className="font-bold text-[var(--text)] uppercase">
                        VS {bout.oppName}
                      </span>
                    </div>

                    {/* Win status, pnl, replay */}
                    <div className="flex items-center justify-between sm:justify-end gap-6 text-right">
                      <Chip variant={outcomeIsWin ? 'win' : 'loss'} className="text-[8px] border-none font-bold py-0.5 px-1.5 uppercase leading-none">
                        {bout.outcome}
                      </Chip>
                      <span className={`font-bold ${colorClass} w-20`}>
                        {pnlSign}{fmtUsd(bout.pnl)}
                      </span>
                      <BracketButton variant="ghost" className="text-[9px] py-1 px-2 flex items-center leading-none">
                        <Film className="w-3 h-3 mr-1" /> REPLAY
                      </BracketButton>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>

      </main>
    </div>
  );
}
