'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { AppTopBar } from '@/components/shared/AppTopBar';
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
  const odds = id === 'degen' ? '{fighterA} odds {oddsA_bps/100}% (BPS, clamped 5–95%)' : '{fighterB} odds {oddsB_bps/100}% = 100% − oddsA (clamped 5–95%)';
  const cornerLabel = side === 'a' ? 'RED CORNER' : 'BLUE CORNER';
  return (
    <div
      className={`card ${side === 'a' ? 'glow-a' : 'glow-b'}`}
      style={{
        flex: 1,
        borderColor: f.hex,
        overflow: 'hidden',
        transform: side === 'a' ? 'translateX(-12px)' : 'translateX(12px)',
        opacity: 0,
        animation: `${side === 'a' ? 'slideInLeft' : 'slideInRight'} 600ms cubic-bezier(.34,1.56,.64,1) both`,
      }}
    >
      {/* Ribbon header */}
      <div
        className="row ai-c jc-sb"
        style={{
          padding: '10px 16px',
          background: `linear-gradient(${side === 'a' ? 90 : 270}deg, ${f.hex}22, transparent 70%)`,
          borderBottom: `1px solid ${f.hex}55`,
        }}
      >
        <div className="row gap-8 ai-c">
          <span
            style={{
              width: 22,
              height: 22,
              background: f.hex,
              color: '#0a0612',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--fnt-display)',
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            {f.rank}
          </span>
          <span
            className="t-display t-up"
            style={{ fontSize: 13, color: f.hex, letterSpacing: '0.18em', whiteSpace: 'nowrap' }}
          >
            {cornerLabel}
          </span>
          <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>· {f.tier}</span>
        </div>
        <span className="chip" style={{ color: f.hex, borderColor: f.hex }}>{odds}</span>
      </div>

      {/* Portrait + name + tagline */}
      <div className="col gap-16 ai-c" style={{ padding: 24 }}>
        <FighterAvatar fighter={id} context="card" size={220} state="winning" />
        <div className="col ai-c gap-4">
          <span
            className="t-display t-up"
            style={{ fontSize: 24, letterSpacing: '0.1em', color: f.hex, lineHeight: 1, whiteSpace: 'nowrap' }}
          >
            {f.name}
          </span>
          <span className="t-mono t-sm t-dim" style={{ fontStyle: 'italic', whiteSpace: 'nowrap' }}>
            &ldquo;{f.tagline}&rdquo;
          </span>
        </div>
      </div>

      {/* Meters */}
      <div className="col gap-10" style={{ padding: '0 24px 16px' }}>
        <div className="row jc-sb ai-c">
          <span className="label-tiny">AGGRESSION</span>
          <Meter value={f.aggression} side={side} />
        </div>
        <div className="row jc-sb ai-c">
          <span className="label-tiny">PATIENCE</span>
          <Meter value={f.patience} side={side} />
        </div>
        <div className="row jc-sb ai-c">
          <span className="label-tiny">RISK</span>
          <Meter value={f.risk} side={side} />
        </div>
      </div>

      {/* Footer: RECORD + BACK */}
      <div
        className="row jc-sb ai-c"
        style={{
          padding: '12px 24px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-stage)',
        }}
      >
        <div className="col gap-2">
          <span className="label-tiny">RECORD</span>
          <span className="t-num t-sm">{f.record.w}W · {f.record.l}L</span>
        </div>
        <BracketButton variant={side}>BACK +2 USDso</BracketButton>
      </div>
    </div>
  );
}

export default function PreDuelPage() {
  const router = useRouter();
  const params = useParams();
  const duelId = String(params?.id ?? '342');
  const turnsParam = Number(params?.turns ?? 15);
  const turns: 3 | 6 | 9 | 15 = ([3, 6, 9, 15] as const).includes(turnsParam as 3 | 6 | 9 | 15)
    ? (turnsParam as 3 | 6 | 9 | 15)
    : 15;
  // Indicative pot — minDepositFor scales roughly with active pool count.
  // Healthy book example from progress.md: 6-turn SOMI+WETH ≈ 24 USDso.
  const potByTier: Record<3 | 6 | 9 | 15, number> = { 3: 12, 6: 24, 9: 48, 15: 80 };
  const pot = potByTier[turns];
  const n = 24;
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
    <div className="col" style={{ minHeight: '100vh', background: 'var(--bg-deep)' }}>
      <AppTopBar />
      {/* Status strip */}
      <div
        className="row ai-c jc-sb"
        style={{
          padding: '14px 32px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-stage)',
        }}
      >
        <div className="row gap-12 ai-c">
          <span
            className="t-mono t-xs"
            style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}
          >
            § PRE-DUEL · DUEL #{duelId}
          </span>
          <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
          <Chip variant="gold">▸ MAIN EVENT</Chip>
        </div>
        <div className="row gap-12 ai-c">
          <span className="label-tiny">BETS OPEN WHILE DUEL ACTIVE — odds locked at placement</span>
          <span
            className="t-num"
            style={{ fontSize: 24, color: t <= 10 ? 'var(--loss)' : 'var(--gold)' }}
          >
            {fmtTime(t)}
          </span>
        </div>
      </div>

      <div className="shell-pad col gap-24" style={{ paddingTop: 32, paddingBottom: 32 }}>
        {/* Marquee headline */}
        <div className="col ai-c gap-4">
          <span className="eyebrow" style={{ color: 'var(--text-dim)' }}>TALE OF THE TAPE</span>
          <h1
            className="fp-display"
            style={{
              fontSize: 'clamp(48px, 7vw, 84px)',
              letterSpacing: '0.04em',
              lineHeight: 1,
              textAlign: 'center',
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
        <div className="row gap-24 ai-c" style={{ alignItems: 'stretch' }}>
          <Corner id="degen" side="a" />
          <div className="col ai-c gap-12" style={{ width: 80, justifyContent: 'center' }}>
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
            <span className="t-mono t-xs t-faint" style={{ textAlign: 'center' }}>
              BEST OF<br />{turns} ROUNDS
            </span>
          </div>
          <Corner id="whale" side="b" />
        </div>

        {/* Bottom strip */}
        <div className="card pad-16 row jc-sb ai-c">
          <div className="row gap-24 ai-c">
            <div className="col gap-2">
              <span className="eyebrow">PURSE</span>
              <span className="t-num text-gold" style={{ fontSize: 22 }}>{pot} USDso</span>
            </div>
            <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
            <div className="col gap-2">
              <span className="eyebrow">BETTORS (unique placeBet addresses)</span>
              <span className="t-num" style={{ fontSize: 22 }}>{n}</span>
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
