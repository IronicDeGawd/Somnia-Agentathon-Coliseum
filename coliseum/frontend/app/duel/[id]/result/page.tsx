'use client';

import React, { useReducer, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { BracketButton, Chip } from '@/components/shared/OtherHUD';
import { simReducer, makeInitialSim } from '@/lib/simulation';
import { FIGHTERS } from '@/lib/fighters';
import { fmtUsd, fmtPct, fmtTime } from '@/lib/format';

interface ResultBet {
  fighter: 'degen' | 'whale';
  amount: number;
}

export default function ResultPage() {
  const router = useRouter();
  const [sim, dispatch] = useReducer(simReducer, makeInitialSim());

  useEffect(() => {
    const clock = setInterval(() => dispatch({ type: 'TICK' }), 1000);
    return () => clearInterval(clock);
  }, []);

  // Mock the user's bet — in production this comes from chain reads / URL state.
  const bet: ResultBet | null = { fighter: 'whale', amount: 5 };

  const winnerId: 'degen' | 'whale' = sim.degen.pnl >= sim.whale.pnl ? 'degen' : 'whale';
  const loserId: 'degen' | 'whale' = winnerId === 'degen' ? 'whale' : 'degen';
  const w = FIGHTERS[winnerId];
  const l = FIGHTERS[loserId];
  const wPnl = winnerId === 'degen' ? sim.degen.pnl : sim.whale.pnl;
  const lPnl = winnerId === 'degen' ? sim.whale.pnl : sim.degen.pnl;
  const wPct = (wPnl / 300) * 100;

  const betWon = bet !== null && bet.fighter === winnerId;
  const odds = bet ? (bet.fighter === 'degen' ? sim.oddsDegen : 100 - sim.oddsDegen) : 0;
  const payout = betWon && bet ? bet.amount * (100 / odds) : 0;
  const profit = payout - (bet ? bet.amount : 0);

  const payoutMeta = bet ? (betWon ? 'winning ticket · claimable' : 'losing ticket · settled') : 'no bet placed';

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-deep)]">
      {/* Status strip */}
      <div
        className="flex items-center justify-between flex-wrap gap-3"
        style={{
          padding: '14px 32px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-stage)',
        }}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className="t-mono text-[11px]"
            style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}
          >
            § POST-DUEL · ROUND #341
          </span>
          <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
          <Chip variant="gold">★ SETTLED · ON-CHAIN</Chip>
        </div>
        <span
          className="t-mono text-[11px] text-[var(--text-dim)]"
          style={{ letterSpacing: '0.18em' }}
        >
          NEXT BOUT IN{' '}
          <span className="t-num" style={{ color: 'var(--gold)' }}>{fmtTime(sim.countdown)}</span>
        </span>
      </div>

      {/* Winner reveal — bare section, no card chrome */}
      <section
        style={{ position: 'relative', padding: '64px 32px 48px', overflow: 'hidden' }}
      >
        <div
          className="flex flex-col items-center gap-4 relative"
          style={{ maxWidth: 1200, margin: '0 auto' }}
        >
          {/* ★ WINNER ★ eyebrow w/ flanking gold rules */}
          <div className="flex items-center gap-4">
            <span style={{ height: 1, width: 80, background: 'var(--gold)' }} />
            <span
              className="eyebrow"
              style={{ color: 'var(--gold)', letterSpacing: '0.42em' }}
            >
              ★ WINNER ★
            </span>
            <span style={{ height: 1, width: 80, background: 'var(--gold)' }} />
          </div>

          {/* Portrait w/ drop-shadow glow + vs-pop animation */}
          <div
            className="vs-pop"
            style={{ filter: `drop-shadow(0 0 60px ${w.hex})` }}
          >
            <FighterAvatar fighter={winnerId} context="card" size={220} state="victory" />
          </div>

          {/* Giant fp-display name */}
          <h1
            className="fp-display whitespace-nowrap text-center"
            style={{
              fontSize: 'clamp(56px, 8vw, 96px)',
              letterSpacing: '0.06em',
              lineHeight: 1,
              margin: 0,
              color: w.hex,
              textShadow: `0 0 60px ${w.hex}`,
            }}
          >
            {w.name}
          </h1>

          {/* 3-up stat strip: FINAL PNL / RETURN / METHOD */}
          <div className="flex items-center gap-8 flex-wrap" style={{ marginTop: 24 }}>
            <div className="flex flex-col items-center gap-1">
              <span className="eyebrow">FINAL PNL</span>
              <span className="t-num text-win whitespace-nowrap" style={{ fontSize: 32 }}>
                {fmtUsd(wPnl)}
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="flex flex-col items-center gap-1">
              <span className="eyebrow">RETURN</span>
              <span className="t-num text-win whitespace-nowrap" style={{ fontSize: 32 }}>
                {fmtPct(wPct)}
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="flex flex-col items-center gap-1">
              <span className="eyebrow">METHOD</span>
              <span
                className="t-display whitespace-nowrap"
                style={{
                  fontSize: 18,
                  color: 'var(--text)',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                }}
              >
                PNL DECISION
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* § 01 FINAL TAPE */}
      <section
        className="shell-pad flex flex-col gap-4"
        style={{ paddingTop: 16, paddingBottom: 40 }}
      >
        <div className="sect-head">
          <span className="sect-head-num">§ 01</span>
          <span className="sect-head-title">FINAL TAPE</span>
          <span className="sect-head-meta">15 rounds settled · {sim.spectators} spectators</span>
        </div>

        <div className="flex items-stretch gap-4">
          {/* Winner card */}
          <div className="card flex-1 flex flex-col gap-3" style={{ padding: 24 }}>
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <FighterAvatar fighter={winnerId} context="mini" size={40} />
                <div className="flex flex-col gap-1">
                  <Chip variant="win">★ WON</Chip>
                  <span
                    className="t-display"
                    style={{ color: w.hex, fontSize: 18, letterSpacing: '0.12em', textTransform: 'uppercase' }}
                  >
                    {w.name}
                  </span>
                </div>
              </div>
              <span className="t-num text-win" style={{ fontSize: 28 }}>{fmtUsd(wPnl)}</span>
            </div>
            <hr className="divider" />
            <div className="flex justify-between t-mono text-[11px] text-[var(--text-dim)]">
              <span>Best round</span>
              <span className="t-num text-win">+$8.92</span>
            </div>
            <div className="flex justify-between t-mono text-[11px] text-[var(--text-dim)]">
              <span>Worst round</span>
              <span className="t-num text-loss">−$2.10</span>
            </div>
            <div className="flex justify-between t-mono text-[11px] text-[var(--text-dim)]">
              <span>Trades executed</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>23</span>
            </div>
          </div>

          {/* Loser card — opacity 0.7 */}
          <div className="card flex-1 flex flex-col gap-3" style={{ padding: 24, opacity: 0.7 }}>
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <FighterAvatar fighter={loserId} context="mini" size={40} />
                <div className="flex flex-col gap-1">
                  <Chip variant="loss">LOST</Chip>
                  <span
                    className="t-display"
                    style={{ color: l.hex, fontSize: 18, letterSpacing: '0.12em', textTransform: 'uppercase' }}
                  >
                    {l.name}
                  </span>
                </div>
              </div>
              <span className="t-num text-loss" style={{ fontSize: 28 }}>{fmtUsd(lPnl)}</span>
            </div>
            <hr className="divider" />
            <div className="flex justify-between t-mono text-[11px] text-[var(--text-dim)]">
              <span>Best round</span>
              <span className="t-num text-win">+$4.20</span>
            </div>
            <div className="flex justify-between t-mono text-[11px] text-[var(--text-dim)]">
              <span>Worst round</span>
              <span className="t-num text-loss">−$6.80</span>
            </div>
            <div className="flex justify-between t-mono text-[11px] text-[var(--text-dim)]">
              <span>Trades executed</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>11</span>
            </div>
          </div>
        </div>
      </section>

      {/* § 02 YOUR PAYOUT */}
      <section
        className="shell-pad flex flex-col gap-4"
        style={{ paddingTop: 16, paddingBottom: 40 }}
      >
        <div className="sect-head">
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">YOUR PAYOUT</span>
          <span className="sect-head-meta">{payoutMeta}</span>
        </div>

        <div
          className="card"
          style={{
            padding: 24,
            borderColor: betWon ? 'var(--win)' : bet ? 'var(--loss)' : 'var(--border)',
          }}
        >
          {bet ? (
            <div className="flex justify-between items-center gap-6 flex-wrap">
              <div className="flex flex-col gap-1">
                <span className="t-mono text-[12px] text-[var(--text-dim)]">YOU BACKED</span>
                <span
                  className="t-display"
                  style={{
                    fontSize: 22,
                    color: FIGHTERS[bet.fighter].hex,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                  }}
                >
                  {FIGHTERS[bet.fighter].name}
                </span>
                <span className="t-mono text-[11px] text-[var(--text-faint)]">
                  ${bet.amount} @ {odds}%
                </span>
              </div>

              {betWon ? (
                <>
                  <div className="flex flex-col items-center gap-1">
                    <span className="eyebrow">PAYOUT</span>
                    <span className="t-num text-win" style={{ fontSize: 36 }}>
                      +${payout.toFixed(2)}
                    </span>
                    <span className="t-mono text-[11px] text-[var(--text-dim)]">
                      profit ${profit.toFixed(2)}
                    </span>
                  </div>
                  <BracketButton variant="gold">CLAIM PAYOUT →</BracketButton>
                </>
              ) : (
                <>
                  <div className="flex flex-col items-center gap-1">
                    <span className="eyebrow">RESULT</span>
                    <span className="t-num text-loss" style={{ fontSize: 36 }}>
                      −${bet.amount.toFixed(2)}
                    </span>
                    <span className="t-mono text-[11px] text-[var(--text-dim)]">
                      cope. lessons are expensive.
                    </span>
                  </div>
                  <BracketButton variant="ghost" disabled>SETTLED</BracketButton>
                </>
              )}
            </div>
          ) : (
            <span className="t-mono text-[12px] text-[var(--text-dim)]">
              No bet placed this round.
            </span>
          )}
        </div>
      </section>

      {/* Action row — centered horizontal */}
      <section
        className="shell-pad"
        style={{ paddingTop: 16, paddingBottom: 80 }}
      >
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <Link href="/duel/1">
            <BracketButton>WATCH REPLAY</BracketButton>
          </Link>
          <BracketButton variant="gold">SHARE CARD ⤴</BracketButton>
          <BracketButton variant="primary" onClick={() => router.push('/duel')}>
            NEXT BOUT →
          </BracketButton>
        </div>
      </section>
    </div>
  );
}
