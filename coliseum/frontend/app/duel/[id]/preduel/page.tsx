'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
  const odds = id === 'degen' ? '58%' : '42%';
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
        <div className="row gap-12 ai-c">
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
        <div className="col ai-c gap-12">
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
      <div className="col gap-12" style={{ padding: '0 24px 16px' }}>
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
        <div className="col gap-12">
          <span className="label-tiny">RECORD</span>
          <span className="t-num t-sm">{f.record.w}W · {f.record.l}L</span>
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
            § PRE-DUEL · ROUND #342
          </span>
          <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
          <Chip variant="gold">▸ MAIN EVENT</Chip>
        </div>
        <div className="row gap-12 ai-c">
          <span className="label-tiny">BETS LOCK IN</span>
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
        <div className="col ai-c gap-12">
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
        <div className="row gap-24" style={{ alignItems: 'stretch' }}>
          <Corner id="degen" side="a" />
          <div className="col ai-c gap-12" style={{ width: 80, justifyContent: 'center' }}>
            <span
              className="t-display"
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
            <span className="t-mono t-xs text-faint" style={{ textAlign: 'center' }}>
              BEST OF<br />15 TURNS
            </span>
          </div>
          <Corner id="whale" side="b" />
        </div>

        {/* Bottom strip */}
        <div className="card pad-16 row jc-sb ai-c">
          <div className="row gap-24 ai-c">
            <div className="col gap-12">
              <span className="eyebrow">PURSE</span>
              <span className="t-num text-gold" style={{ fontSize: 22 }}>$142 USDSO</span>
            </div>
            <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
            <div className="col gap-12">
              <span className="eyebrow">SPECTATORS</span>
              <span className="t-num" style={{ fontSize: 22 }}>47</span>
            </div>
            <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
            <div className="col gap-12">
              <span className="eyebrow">HEAD-TO-HEAD</span>
              <span className="t-mono t-sm">
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
