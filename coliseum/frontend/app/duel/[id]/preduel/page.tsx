'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { Meter } from '@/components/shared/Meter';
import { BracketButton, Chip } from '@/components/shared/OtherHUD';
import { FIGHTERS } from '@/lib/fighters';
import { fmtTime } from '@/lib/format';

interface CornerProps {
  id: 'degen' | 'whale';
  side: 'a' | 'b';
}

function Corner({ id, side }: CornerProps) {
  const f = FIGHTERS[id];
  const odds = id === 'degen' ? '58%' : '42%';
  const cornerLabel = side === 'a' ? 'RED CORNER' : 'BLUE CORNER';
  return (
    <div
      className={`card flex-1 overflow-hidden ${side === 'a' ? 'glow-a' : 'glow-b'}`}
      style={{
        borderColor: f.hex,
        transform: side === 'a' ? 'translateX(-12px)' : 'translateX(12px)',
        opacity: 0,
        animation: `${side === 'a' ? 'slideInLeft' : 'slideInRight'} 600ms cubic-bezier(.34,1.56,.64,1) both`,
      }}
    >
      {/* Ribbon header — gradient + rank square + corner label + tier + odds chip */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: '10px 16px',
          background: `linear-gradient(${side === 'a' ? 90 : 270}deg, ${f.hex}22, transparent 70%)`,
          borderBottom: `1px solid ${f.hex}55`,
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center"
            style={{
              width: 22, height: 22, background: f.hex, color: '#0a0612',
              fontFamily: 'var(--fnt-display)', fontWeight: 700, fontSize: 14,
            }}
          >
            {f.rank}
          </span>
          <span
            className="t-display whitespace-nowrap"
            style={{ fontSize: 13, color: f.hex, letterSpacing: '0.18em', textTransform: 'uppercase' }}
          >
            {cornerLabel}
          </span>
          <span className="t-mono text-[11px] text-[var(--text-dim)] whitespace-nowrap">· {f.tier}</span>
        </div>
        <span className="chip" style={{ color: f.hex, borderColor: f.hex }}>{odds}</span>
      </div>

      {/* Portrait + name + tagline */}
      <div className="flex flex-col items-center gap-4" style={{ padding: 24 }}>
        <FighterAvatar fighter={id} context="card" size={220} state="winning" />
        <div className="flex flex-col items-center gap-1">
          <span
            className="t-display whitespace-nowrap"
            style={{ fontSize: 24, letterSpacing: '0.1em', color: f.hex, lineHeight: 1, textTransform: 'uppercase' }}
          >
            {f.name}
          </span>
          <span className="t-mono text-[12px] text-[var(--text-dim)] italic whitespace-nowrap">
            &ldquo;{f.tagline}&rdquo;
          </span>
        </div>
      </div>

      {/* Meters */}
      <div className="flex flex-col gap-2" style={{ padding: '0 24px 16px' }}>
        <div className="flex justify-between items-center">
          <span className="label-tiny">AGGRESSION</span>
          <Meter value={f.aggression} side={side} />
        </div>
        <div className="flex justify-between items-center">
          <span className="label-tiny">PATIENCE</span>
          <Meter value={f.patience} side={side} />
        </div>
        <div className="flex justify-between items-center">
          <span className="label-tiny">RISK</span>
          <Meter value={f.risk} side={side} />
        </div>
      </div>

      {/* Footer: RECORD + BACK +$2 */}
      <div
        className="flex justify-between items-center"
        style={{
          padding: '12px 24px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-stage)',
        }}
      >
        <div className="flex flex-col gap-0.5">
          <span className="label-tiny">RECORD</span>
          <span className="t-num text-[12px]">{f.record.w}W · {f.record.l}L</span>
        </div>
        <BracketButton variant={side}>BACK +$2</BracketButton>
      </div>
    </div>
  );
}

export default function PreDuelPage() {
  const router = useRouter();
  const [t, setT] = useState(30);

  useEffect(() => {
    if (t <= 0) {
      router.push('/duel/1');
      return;
    }
    const id = setTimeout(() => setT((x) => x - 1), 1000);
    return () => clearTimeout(id);
  }, [t, router]);

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
            § PRE-DUEL · ROUND #342
          </span>
          <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
          <Chip variant="gold">▸ MAIN EVENT</Chip>
        </div>
        <div className="flex items-center gap-3">
          <span className="label-tiny">BETS LOCK IN</span>
          <span
            className="t-num"
            style={{ fontSize: 24, color: t <= 10 ? 'var(--loss)' : 'var(--gold)' }}
          >
            {fmtTime(t)}
          </span>
        </div>
      </div>

      <div className="shell-pad flex flex-col gap-6" style={{ paddingTop: 32, paddingBottom: 32 }}>
        {/* Marquee headline */}
        <div className="flex flex-col items-center gap-1">
          <span className="eyebrow" style={{ color: 'var(--text-dim)' }}>TALE OF THE TAPE</span>
          <h1
            className="fp-display text-center"
            style={{
              fontSize: 'clamp(48px, 7vw, 84px)',
              letterSpacing: '0.04em',
              lineHeight: 1,
              margin: '8px 0',
              color: 'var(--text)',
            }}
          >
            <span className="text-a">THE DEGEN</span>
            <span style={{ color: 'var(--text-faint)', margin: '0 16px' }}>vs</span>
            <span className="text-b">THE WHALE</span>
          </h1>
        </div>

        {/* Corner cards w/ gradient VS */}
        <div className="flex items-stretch gap-6">
          <Corner id="degen" side="a" />
          <div className="flex flex-col items-center justify-center gap-3" style={{ width: 80 }}>
            <span
              className="t-display vs-pop"
              style={{
                fontSize: 80,
                lineHeight: 1,
                background: 'linear-gradient(180deg, var(--fighter-a), var(--fighter-b))',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              VS
            </span>
            <span className="t-mono text-[11px] text-[var(--text-faint)] text-center">
              BEST OF<br />15 TURNS
            </span>
          </div>
          <Corner id="whale" side="b" />
        </div>

        {/* Bottom strip — purse + spectators + H2H + SKIP TO ARENA */}
        <div className="card flex items-center justify-between gap-4 flex-wrap" style={{ padding: 16 }}>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex flex-col gap-1">
              <span className="eyebrow">PURSE</span>
              <span className="t-num text-gold" style={{ fontSize: 22 }}>$142 USDSO</span>
            </div>
            <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
            <div className="flex flex-col gap-1">
              <span className="eyebrow">SPECTATORS</span>
              <span className="t-num" style={{ fontSize: 22 }}>47</span>
            </div>
            <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
            <div className="flex flex-col gap-1">
              <span className="eyebrow">HEAD-TO-HEAD</span>
              <span className="t-mono text-[12px]">
                DEGEN <span className="t-num">1</span>—<span className="t-num">2</span> WHALE
              </span>
            </div>
          </div>
          <BracketButton variant="primary" onClick={() => router.push('/duel/1')}>
            SKIP TO ARENA →
          </BracketButton>
        </div>
      </div>
    </div>
  );
}
