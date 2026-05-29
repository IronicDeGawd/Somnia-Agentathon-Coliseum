'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ShieldAlert, Play, Swords, Volume2, HelpCircle } from 'lucide-react';
import { Avatar } from '@/components/shared/Avatar';
import { Meter } from '@/components/shared/Meter';
import { BracketButton, Chip, Dot, SectionHead } from '@/components/shared/OtherHUD';
import { FIGHTERS } from '@/lib/fighters';

export default function PreDuelPage() {
  const router = useRouter();
  const [countdown, setCountdown] = useState(5);

  const degen = FIGHTERS.degen;
  const whale = FIGHTERS.whale;

  // Pre-duel auto navigation countdown
  useEffect(() => {
    const clock = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(clock);
          router.push('/duel/1');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(clock);
  }, [router]);

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-deep)] justify-between">
      {/* 1. Staging top status header */}
      <header className="w-full border-b border-[var(--border)] bg-[var(--bg-stage)]/30 px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 font-mono uppercase text-xs">
        <div className="flex items-center gap-3">
          <SectionHead num="§ PRE-DUEL" title="ROUND #342" meta="MAIN EVENT STAGING" />
          <Chip variant="gold">★ BOUT II</Chip>
        </div>

        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[var(--loss)] font-bold">
            <Dot variant="loss" pulse={true} className="w-1.5 h-1.5" />
            BETS LOCK IN: {countdown}s
          </span>
          <span className="h-4 w-[1px] bg-[var(--border)]" />
          <Link href="/duel">
            <BracketButton variant="ghost" className="text-[10px] py-1.5 px-3">
              LEAVE ARENA
            </BracketButton>
          </Link>
        </div>
      </header>

      {/* 2. Tale of the tape core container */}
      <main className="flex-1 w-full flex items-center justify-center py-12 px-6">
        <div className="max-w-[1100px] w-full grid grid-cols-1 lg:grid-cols-11 items-center gap-10">
          
          {/* Fighter A: Red Corner */}
          <div className="lg:col-span-4 card border-[var(--fighter-a)] p-6 bg-[var(--bg-card)]/40 rounded-[2px] slide-in-left shadow-[0_0_20px_rgba(255,51,102,0.06)] relative overflow-hidden flex flex-col items-center">
            {/* Header chip banner */}
            <div className="w-full border-b border-[var(--border-soft)] pb-4 mb-6 flex justify-between items-center text-[10px] font-mono text-[var(--text-dim)] uppercase">
              <span className="text-[var(--fighter-a)] font-bold">RED CORNER · DEGEN TIER</span>
              <span className="text-right">ODDS: 60%</span>
            </div>

            {/* Profile Avatar */}
            <Avatar fighter="degen" size={180} variant="shield" state="winning" />
            
            <h3 className="t-display text-2xl mt-6 text-[var(--text)] uppercase">THE DEGEN</h3>
            <p className="text-[10px] text-[var(--text-faint)] italic font-mono mt-1">"{degen.quote}"</p>

            {/* Attributes sliders */}
            <div className="w-full border-t border-[var(--border-soft)] mt-6 pt-4 space-y-3 font-mono text-xs text-[var(--text-dim)]">
              <div className="flex justify-between items-center">
                <span>AGGRESSION</span>
                <Meter value={degen.aggression} side="a" />
              </div>
              <div className="flex justify-between items-center">
                <span>PATIENCE</span>
                <Meter value={degen.patience} side="a" />
              </div>
              <div className="flex justify-between items-center">
                <span>RISK INDEX</span>
                <Meter value={degen.risk} side="a" />
              </div>
            </div>

            {/* Footer */}
            <div className="w-full border-t border-[var(--border-soft)] mt-4 pt-3 flex justify-between items-center text-[10px] font-mono text-[var(--text-faint)]">
              <span>RECORD: {degen.record.w}W - {degen.record.l}L</span>
              <span className="text-[var(--win)] font-bold">PNL: +$120.00</span>
            </div>
          </div>

          {/* VS Divider center column */}
          <div className="lg:col-span-3 flex flex-col items-center justify-center text-center select-none py-6">
            <span className="t-roman text-5xl md:text-7xl text-[var(--text-faint)] vs-pop">VS</span>
            <p className="t-display text-xs text-yellow-400 mt-4 tracking-widest uppercase">BEST OF 15 TURNS</p>
            <p className="text-[10px] text-[var(--text-faint)] mt-2 font-mono">ON-CHAIN CLOB ORCHESTRATION</p>
          </div>

          {/* Fighter B: Blue Corner */}
          <div className="lg:col-span-4 card border-[var(--fighter-b)] p-6 bg-[var(--bg-card)]/40 rounded-[2px] slide-in-right shadow-[0_0_20px_rgba(0,217,255,0.06)] relative overflow-hidden flex flex-col items-center">
            {/* Header chip banner */}
            <div className="w-full border-b border-[var(--border-soft)] pb-4 mb-6 flex justify-between items-center text-[10px] font-mono text-[var(--text-dim)] uppercase">
              <span className="text-[var(--fighter-b)] font-bold">BLUE CORNER · TACTICIAN TIER</span>
              <span className="text-right">ODDS: 40%</span>
            </div>

            {/* Profile Avatar */}
            <Avatar fighter="whale" size={180} variant="helm" state="idle" />
            
            <h3 className="t-display text-2xl mt-6 text-[var(--text)] uppercase">THE WHALE</h3>
            <p className="text-[10px] text-[var(--text-faint)] italic font-mono mt-1">"{whale.quote}"</p>

            {/* Attributes sliders */}
            <div className="w-full border-t border-[var(--border-soft)] mt-6 pt-4 space-y-3 font-mono text-xs text-[var(--text-dim)]">
              <div className="flex justify-between items-center">
                <span>AGGRESSION</span>
                <Meter value={whale.aggression} side="b" />
              </div>
              <div className="flex justify-between items-center">
                <span>PATIENCE</span>
                <Meter value={whale.patience} side="b" />
              </div>
              <div className="flex justify-between items-center">
                <span>RISK INDEX</span>
                <Meter value={whale.risk} side="b" />
              </div>
            </div>

            {/* Footer */}
            <div className="w-full border-t border-[var(--border-soft)] mt-4 pt-3 flex justify-between items-center text-[10px] font-mono text-[var(--text-faint)]">
              <span>RECORD: {whale.record.w}W - {whale.record.l}L</span>
              <span className="text-[var(--win)] font-bold">PNL: +$340.50</span>
            </div>
          </div>

        </div>
      </main>

      {/* 3. Bottom Staging strip CTA */}
      <footer className="w-full border-t border-[var(--border)] bg-[var(--bg-stage)]/10 px-6 py-6 flex flex-col md:flex-row justify-between items-center gap-6 font-mono text-xs">
        <div className="flex flex-wrap items-center justify-center gap-8 text-[var(--text-faint)] select-none">
          <span className="flex items-center gap-1.5"><Swords className="w-3.5 h-3.5" /> dreamDEX LIQUIDITY MATCHING</span>
          <span className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" /> SECURED ON-CHAIN PROTOCOL</span>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-[10px] text-[var(--text-faint)] uppercase select-none">STAGING COMPLETED. READY FOR CLASH.</span>
          <Link href="/duel/1">
            <BracketButton variant="primary" className="text-[10px] py-3 px-6 leading-none">
              SKIP TIMERS TO ARENA
            </BracketButton>
          </Link>
        </div>
      </footer>
    </div>
  );
}
