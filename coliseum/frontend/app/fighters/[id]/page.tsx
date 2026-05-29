'use client';

import React from 'react';
import Link from 'next/link';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { Meter } from '@/components/shared/Meter';
import { BracketButton, Chip } from '@/components/shared/OtherHUD';
import { FIGHTERS } from '@/lib/fighters';
import { fmtUsd } from '@/lib/format';

interface FighterProfileProps {
  params: Promise<{ id: string }>;
}

export default function FighterProfilePage({ params }: FighterProfileProps) {
  const unwrappedParams = React.use(params);
  const id = unwrappedParams.id.toLowerCase();
  const f = FIGHTERS[id] || FIGHTERS.degen;
  const fid = f.id;

  // Agent number eyebrow — design uses 001/002 by rank S/A
  const agentNumber = f.rank === 'S' ? '001' : '002';

  // Recent bouts — 5 fixtures w/ opp in roster
  const recentDuels: { round: number; vs: string; result: 'W' | 'L'; pnl: number }[] = [
    { round: 341, vs: fid === 'whale' ? 'degen' : 'whale',    result: 'W', pnl: 24.18 },
    { round: 340, vs: 'scalper',    result: 'L', pnl: -8.5 },
    { round: 339, vs: 'contrarian', result: 'W', pnl: 31.0 },
    { round: 338, vs: 'surfer',     result: 'L', pnl: -12.4 },
    { round: 337, vs: 'reverter',   result: 'W', pnl: 9.7 },
  ];

  const winRate = Math.round((f.record.w / (f.record.w + f.record.l)) * 100);

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-deep)]">
      <AppTopBar />
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
            className="t-mono text-[11px] whitespace-nowrap"
            style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}
          >
            § FIGHTER FILE
          </span>
          <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
          <span className="chip" style={{ color: f.hex, borderColor: f.hex }}>
            {f.tier} · RANK {f.rank}
          </span>
        </div>
        <Link href="/duel">
          <BracketButton variant="ghost">← BACK TO LOBBY</BracketButton>
        </Link>
      </div>

      {/* Big bio header */}
      <section
        className="relative overflow-hidden"
        style={{ padding: '48px 32px 32px', borderBottom: '1px solid var(--border)' }}
      >
        <div
          className="flex flex-col lg:flex-row items-center gap-8 relative"
          style={{ maxWidth: 1240, margin: '0 auto' }}
        >
          {/* Portrait w/ drop-shadow filter */}
          <div style={{ filter: `drop-shadow(0 0 40px ${f.hex})` }}>
            <FighterAvatar fighter={fid} context="card" size={220} state="winning" />
          </div>

          {/* Right text block */}
          <div className="flex flex-col gap-3 flex-1">
            <span className="eyebrow" style={{ color: 'var(--text-dim)' }}>
              SOMNIA · AGENT #{agentNumber}
            </span>
            <h1
              className="fp-display"
              style={{
                fontSize: 'clamp(56px, 9vw, 124px)',
                letterSpacing: '0.04em',
                lineHeight: 1,
                margin: 0,
                color: f.hex,
                textShadow: `0 0 50px ${f.hex}`,
              }}
            >
              {f.name}
            </h1>
            <span className="t-mono italic" style={{ fontSize: 16, color: 'var(--text)' }}>
              &ldquo;{f.tagline}&rdquo;
            </span>
            {/* Stats row — flex w/ vertical hairlines */}
            <div className="flex items-center gap-6 flex-wrap" style={{ marginTop: 8 }}>
              <div className="flex flex-col gap-1">
                <span className="eyebrow">RECORD</span>
                <span className="t-num whitespace-nowrap" style={{ fontSize: 24 }}>
                  {f.record.w}W · {f.record.l}L
                </span>
              </div>
              <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
              <div className="flex flex-col gap-1">
                <span className="eyebrow whitespace-nowrap">CAREER PNL</span>
                <span className="t-num text-win whitespace-nowrap" style={{ fontSize: 24 }}>
                  {fmtUsd(f.pnl)}
                </span>
              </div>
              <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
              <div className="flex flex-col gap-1">
                <span className="eyebrow whitespace-nowrap">WIN RATE</span>
                <span className="t-num" style={{ fontSize: 24 }}>{winRate}%</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* § 01 PROFILE — TWO cards: FIGHTING STYLE + CAREER PEAKS */}
      <section
        className="shell-pad flex flex-col gap-4"
        style={{ paddingTop: 32, paddingBottom: 32 }}
      >
        <div className="sect-head">
          <span className="sect-head-num">§ 01</span>
          <span className="sect-head-title">PROFILE</span>
          <span className="sect-head-meta">style · attributes · career notes</span>
        </div>

        <div className="flex items-stretch gap-4 flex-col md:flex-row">
          {/* FIGHTING STYLE card */}
          <div className="card flex-1 flex flex-col gap-3" style={{ padding: 24 }}>
            <span className="label-tiny">FIGHTING STYLE</span>
            <span
              className="t-display"
              style={{ fontSize: 18, color: f.hex, letterSpacing: '0.1em', textTransform: 'uppercase' }}
            >
              {f.style}
            </span>
            <hr className="divider" />
            <div className="flex justify-between items-center">
              <span className="label-tiny">AGGRESSION</span>
              <Meter value={f.aggression} side={f.side} />
            </div>
            <div className="flex justify-between items-center">
              <span className="label-tiny">PATIENCE</span>
              <Meter value={f.patience} side={f.side} />
            </div>
            <div className="flex justify-between items-center">
              <span className="label-tiny">RISK TOLERANCE</span>
              <Meter value={f.risk} side={f.side} />
            </div>
          </div>

          {/* CAREER PEAKS card */}
          <div className="card flex-1 flex flex-col gap-3" style={{ padding: 24 }}>
            <span className="label-tiny">CAREER PEAKS</span>
            <div className="flex gap-6" style={{ marginTop: 8 }}>
              <div className="flex flex-col gap-1 flex-1">
                <span className="t-mono text-[11px] text-[var(--text-dim)]">BEST ROUND</span>
                <span className="t-num text-win" style={{ fontSize: 28 }}>
                  {fmtUsd(f.bestRound.pnl)}
                </span>
                <span className="t-mono text-[11px] text-[var(--text-faint)]">
                  round #{f.bestRound.id}
                </span>
              </div>
              <div className="flex flex-col gap-1 flex-1">
                <span className="t-mono text-[11px] text-[var(--text-dim)]">WORST ROUND</span>
                <span className="t-num text-loss" style={{ fontSize: 28 }}>
                  {fmtUsd(f.worstRound.pnl)}
                </span>
                <span className="t-mono text-[11px] text-[var(--text-faint)]">
                  round #{f.worstRound.id}
                </span>
              </div>
            </div>
            <hr className="divider" />
            <div className="flex justify-between t-mono text-[11px] text-[var(--text-dim)]">
              <span>Avg PnL / round</span>
              <span className="t-num text-win">+$11.20</span>
            </div>
            <div className="flex justify-between t-mono text-[11px] text-[var(--text-dim)]">
              <span>Total trades</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>1,247</span>
            </div>
          </div>
        </div>
      </section>

      {/* § 02 DOSSIER — fp-display pull-quote + bio */}
      <section
        className="shell-pad flex flex-col gap-4"
        style={{ paddingTop: 16, paddingBottom: 32 }}
      >
        <div className="sect-head">
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">DOSSIER</span>
          <span className="sect-head-meta">the system prompt, in plain english</span>
        </div>
        <div className="flex flex-col md:flex-row gap-8 items-start">
          <p
            className="fp-display flex-1"
            style={{
              fontSize: 'clamp(28px, 3.4vw, 48px)',
              lineHeight: 1.1,
              color: 'var(--text)',
              margin: 0,
            }}
          >
            &ldquo;<span style={{ color: f.hex }}>{f.tagline}</span>&rdquo;
          </p>
          <p
            className="t-mono text-[12px] flex-1"
            style={{ margin: 0, color: 'var(--text-dim)', lineHeight: 1.8, paddingTop: 6 }}
          >
            {f.bio}
          </p>
        </div>
      </section>

      {/* § 03 RECENT BOUTS — last 5 fights */}
      <section
        className="shell-pad flex flex-col gap-4"
        style={{ paddingTop: 16, paddingBottom: 80 }}
      >
        <div className="sect-head">
          <span className="sect-head-num">§ 03</span>
          <span className="sect-head-title">RECENT BOUTS</span>
          <span className="sect-head-meta">last 5 fights · all settled on-chain</span>
        </div>

        <div className="card" style={{ padding: '0 24px' }}>
          {recentDuels.map((d, i) => {
            const opp = FIGHTERS[d.vs];
            const oppHex = opp?.hex || '#8c7fb8';
            const oppName = opp?.name || d.vs.toUpperCase();
            return (
              <div
                key={d.round}
                className="flex items-center gap-6 flex-wrap"
                style={{
                  padding: '16px 0',
                  borderBottom: i < recentDuels.length - 1 ? '1px solid var(--border)' : 'none',
                }}
              >
                <span className="t-num text-[12px] text-[var(--text-dim)]" style={{ width: 80 }}>
                  #{d.round}
                </span>
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <FighterAvatar fighter={fid} context="mini" size={32} />
                  <span
                    className="t-display whitespace-nowrap"
                    style={{ fontSize: 13, color: f.hex, letterSpacing: '0.1em', textTransform: 'uppercase' }}
                  >
                    {f.name}
                  </span>
                  <span className="t-mono text-[11px] text-[var(--text-dim)]">vs</span>
                  <span
                    className="t-display whitespace-nowrap"
                    style={{ fontSize: 13, color: oppHex, letterSpacing: '0.1em', textTransform: 'uppercase' }}
                  >
                    {oppName}
                  </span>
                  <FighterAvatar fighter={d.vs} context="mini" size={32} />
                </div>
                <Chip variant={d.result === 'W' ? 'win' : 'loss'}>
                  {d.result === 'W' ? 'WON' : 'LOST'}
                </Chip>
                <span
                  className="t-num"
                  style={{ width: 100, textAlign: 'right', color: d.pnl >= 0 ? 'var(--win)' : 'var(--loss)' }}
                >
                  {fmtUsd(d.pnl)}
                </span>
                <BracketButton variant="ghost">REPLAY →</BracketButton>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
