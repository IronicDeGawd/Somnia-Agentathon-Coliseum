'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Play, TrendingUp, Users, Coins, RotateCcw, Share2, ArrowRight, Award } from 'lucide-react';
import { TopBar } from '@/components/shared/TopBar';
import { Avatar } from '@/components/shared/Avatar';
import { BracketButton, Chip, Dot, SectionHead } from '@/components/shared/OtherHUD';
import { FIGHTERS } from '@/lib/fighters';
import { fmtUsd, fmtPct } from '@/lib/format';

export default function ResultPage() {
  const [claimed, setClaimed] = useState(false);

  const winner = FIGHTERS.degen;
  const loser = FIGHTERS.whale;

  // null = no bet placed. Set to an object to simulate a placed bet.
  const userBet: { fighter: string; amount: number; odds: number } | null = {
    fighter: 'degen',
    amount: 10,
    odds: 60,
  };

  const payoutRatio = userBet ? 100 / userBet.odds : 0;
  const grossPayout = userBet ? userBet.amount * payoutRatio : 0;
  const netEarnings = userBet ? grossPayout - userBet.amount : 0;

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-deep)]">
      {/* navigation */}
      <TopBar showNavigation={false} />

      {/* Post-match staging status bar */}
      <section className="border-b border-[var(--border)] bg-[var(--bg-stage)]/20 px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-4 font-mono uppercase text-xs">
        <div className="flex items-center gap-3">
          <SectionHead num="§ POST-DUEL" title="ROUND #342" meta="BOUT SETTLED" />
          <Chip variant="gold">★ FINALIZED</Chip>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[var(--text-faint)] select-none">NEXT BOUT IN: 12m</span>
          <span className="h-4 w-[1px] bg-[var(--border)]" />
          <Link href="/duel">
            <BracketButton variant="ghost" className="text-[10px] py-1 px-3">
              BACK TO LOBBY
            </BracketButton>
          </Link>
        </div>
      </section>

      {/* Main content grid */}
      <main className="flex-1 shell-pad grid grid-cols-1 lg:grid-cols-12 gap-10 py-10 items-start select-none">
        
        {/* Left 7 Cols: Winner Reveal & tape stats */}
        <div className="lg:col-span-7 space-y-10">
          
          {/* Winner banner oversized */}
          <div className="card border-[var(--gold)] p-8 bg-[var(--bg-card-2)]/40 rounded-[2px] flex flex-col items-center text-center relative overflow-hidden shadow-[0_0_24px_rgba(252,211,77,0.05)]">
            
            {/* Glowing wash behind */}
            <div
              className="absolute w-[300px] h-[300px] rounded-full blur-[100px] opacity-25 pointer-events-none scale-110"
              style={{ backgroundColor: winner.hex }}
            />

            <div className="flex items-center gap-2 mb-4">
              <Award className="w-4 h-4 text-[var(--gold)]" />
              <span className="t-display text-xs text-yellow-400 tracking-widest uppercase">★ ARENA WINNER ★</span>
            </div>

            {/* Oversized Avatar */}
            <Avatar fighter="degen" size={200} variant="shield" state="victory" />

            <h2 className="t-display text-4xl sm:text-6xl text-[var(--fighter-a)] tracking-tighter uppercase mt-6 select-all font-bold">
              THE DEGEN
            </h2>
            <p className="text-[10px] text-[var(--text-faint)] italic font-mono mt-1">"{winner.quote}"</p>

            {/* Stat parameters */}
            <div className="grid grid-cols-3 gap-4 w-full border-t border-[var(--border-soft)] mt-8 pt-6 text-center font-mono text-xs">
              <div className="border-r border-[var(--border-soft)]">
                <span className="text-[9px] text-[var(--text-faint)] uppercase font-bold">FINAL PNL</span>
                <span className="text-lg font-bold text-[var(--win)] block mt-1">+$42.50</span>
              </div>
              <div className="border-r border-[var(--border-soft)]">
                <span className="text-[9px] text-[var(--text-faint)] uppercase font-bold">RETURN %</span>
                <span className="text-lg font-bold text-[var(--win)] block mt-1">+35.4%</span>
              </div>
              <div>
                <span className="text-[9px] text-[var(--text-faint)] uppercase font-bold">SETTLED BLOCK</span>
                <span className="text-lg font-bold text-[var(--text-dim)] block mt-1">#39458</span>
              </div>
            </div>
          </div>

          {/* § 01 FINAL TAPE */}
          <div>
            <SectionHead num="§ 01" title="FINAL TAPE" meta="COMPLETED RECORDS" />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mt-4">
              {/* Winner Stats */}
              <div className="card border-[var(--fighter-a)] p-4 bg-[var(--bg-stage)]/20 rounded-[2px]">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-[10px] text-[var(--fighter-a)] font-bold font-sans">WINNER CORNER</span>
                  <Chip variant="win" className="text-[8px] py-0 px-1 border-none font-bold">+35.4%</Chip>
                </div>
                <div className="flex items-center gap-3 mb-4">
                  <Avatar fighter="degen" size={48} variant="shield" showChrome={false} />
                  <div>
                    <h4 className="text-xs font-bold text-[var(--text)]">THE DEGEN</h4>
                    <span className="text-[9px] text-[var(--text-faint)] font-mono">AGGRESSIVE momentum chaser</span>
                  </div>
                </div>
                <div className="border-t border-[var(--border-soft)] pt-3 text-[10px] font-mono text-[var(--text-dim)] space-y-2">
                  <div className="flex justify-between">
                    <span>BEST TRADE:</span>
                    <span className="text-[var(--win)] font-bold">+$67.20 (SOMI)</span>
                  </div>
                  <div className="flex justify-between">
                    <span>TRADES EXECUTED:</span>
                    <span>12 FILLS</span>
                  </div>
                </div>
              </div>

              {/* Loser Stats */}
              <div className="card border-[var(--border)] p-4 bg-[var(--bg-stage)]/10 rounded-[2px] opacity-75">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-[10px] text-[var(--text-faint)] font-bold font-sans">LOSER CORNER</span>
                  <Chip variant="loss" className="text-[8px] py-0 px-1 border-none font-bold">-18.4%</Chip>
                </div>
                <div className="flex items-center gap-3 mb-4">
                  <Avatar fighter="whale" size={48} variant="helm" showChrome={false} />
                  <div>
                    <h4 className="text-xs font-bold text-[var(--text)]">THE WHALE</h4>
                    <span className="text-[9px] text-[var(--text-faint)] font-mono">PATIENT size allocator</span>
                  </div>
                </div>
                <div className="border-t border-[var(--border-soft)] pt-3 text-[10px] font-mono text-[var(--text-dim)] space-y-2">
                  <div className="flex justify-between">
                    <span>BEST TRADE:</span>
                    <span className="text-[var(--win)] font-bold">+$12.40 (WETH)</span>
                  </div>
                  <div className="flex justify-between">
                    <span>TRADES EXECUTED:</span>
                    <span>4 FILLS</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Right 5 Cols: Payout Details & CTA actions */}
        <div className="lg:col-span-5 space-y-8">
          
          {/* § 02 YOUR PAYOUT */}
          <div>
            <SectionHead num="§ 02" title="YOUR PAYOUT" meta="SETTLED BALANCE" />

            <div className="card p-6 bg-[var(--bg-stage)]/30 rounded-[2px] mt-4 space-y-6">
              {!userBet ? (
                <div className="text-center py-6">
                  <p className="t-display text-[var(--text-faint)] text-xl mb-2 font-bold font-sans">NO BET PLACED.</p>
                  <p className="text-xs font-mono text-[var(--text-dim)]">
                    You watched this round as a spectator. Back a fighter next time.
                  </p>
                </div>
              ) : userBet.fighter === winner.id ? (
                <>
                  <div className="text-center">
                    <span className="text-[10px] text-[var(--text-faint)] uppercase font-mono tracking-widest font-bold block mb-1">
                      YOU BACKED THE WINNER!
                    </span>
                    <h3 className="t-display text-3xl font-sans text-[var(--win)] leading-none font-bold">
                      {fmtUsd(grossPayout)} USDSO
                    </h3>
                    <p className="text-[10px] text-[var(--text-dim)] font-mono mt-1.5">
                      STAKE: {fmtUsd(userBet.amount)} · NET GAINS: {fmtUsd(netEarnings)} (+67%)
                    </p>
                  </div>

                  <div className="border-t border-[var(--border-soft)] pt-4">
                    {claimed ? (
                      <div className="text-center py-3 border border-[var(--win)]/30 rounded-[2px] bg-emerald-950/10 text-[var(--win)] text-xs font-bold uppercase tracking-wider">
                        ✔ PAYOUT CLAIMED SECURELY!
                      </div>
                    ) : (
                      <BracketButton
                        variant="gold"
                        onClick={() => setClaimed(true)}
                        className="w-full text-xs py-3 leading-none"
                      >
                        CLAIM PORTFOLIO EARNINGS
                      </BracketButton>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-center py-6">
                  <p className="t-display text-[var(--loss)] text-xl mb-2 font-bold font-sans">COPE.</p>
                  <p className="text-xs font-mono text-[var(--text-dim)]">
                    Backed the loser this round. lessons are expensive, degens must learn.
                  </p>
                  <BracketButton variant="ghost" className="mt-4 text-[10px] py-2 border-[var(--border)]" onClick={() => {}}>
                    SETTLED
                  </BracketButton>
                </div>
              )}
            </div>
          </div>

          {/* Staging actions CTAs */}
          <div className="space-y-4 pt-4 border-t border-[var(--border)]">
            <span className="text-[10px] text-[var(--text-faint)] font-bold uppercase block tracking-wider text-center select-none">
              REPLAY & BROADCAST CONTROLS
            </span>
            
            <div className="flex flex-col gap-3">
              <BracketButton variant="ghost" className="w-full text-[10px] py-2.5 border-[var(--border)] hover:border-slate-600">
                <RotateCcw className="w-3.5 h-3.5 mr-2" /> REPLAY SPECTATOR DUEL
              </BracketButton>
              
              <BracketButton variant="ghost" className="w-full text-[10px] py-2.5 border-[var(--border)] hover:border-slate-600">
                <Share2 className="w-3.5 h-3.5 mr-2" /> SHARE FIGHT CARD OVER SIBLING PLACES
              </BracketButton>
              
              <Link href="/duel" className="block w-full">
                <BracketButton variant="primary" className="w-full text-[10px] py-3">
                  NEXT FIGHT LOBBY <ArrowRight className="w-3.5 h-3.5 ml-2" />
                </BracketButton>
              </Link>
            </div>
          </div>

        </div>

      </main>
    </div>
  );
}
