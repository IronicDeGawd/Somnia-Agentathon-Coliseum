'use client';

import React from 'react';
import Link from 'next/link';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { Meter } from '@/components/shared/Meter';
import { BracketButton } from '@/components/shared/OtherHUD';
import { fighterIdToIndex, fighterIndexToId } from '@/lib/fighters';
import { useFighters } from '@/hooks/useFighters';

interface FighterProfileProps {
  params: Promise<{ id: string }>;
}

export default function FighterProfilePage({ params }: FighterProfileProps) {
  const unwrappedParams = React.use(params);
  const id = unwrappedParams.id.toLowerCase();
  const fighterIndex = fighterIdToIndex(id);

  const { fighters, isLoading } = useFighters();

  const f = fighters.find((x) => x.index === fighterIndex) ?? null;
  const fid = f ? fighterIndexToId(f.index) : id;

  if (isLoading) {
    return (
      <div className="col">
        <AppTopBar />
        <div
          className="row ai-c jc-c"
          style={{ height: '60vh', color: 'var(--text-dim)' }}
        >
          <span className="t-mono t-sm">LOADING FIGHTER DATA…</span>
        </div>
      </div>
    );
  }

  if (!f) {
    return (
      <div className="col">
        <AppTopBar />
        <div
          className="row ai-c jc-c"
          style={{ height: '60vh', color: 'var(--text-dim)' }}
        >
          <span className="t-mono t-sm">FIGHTER NOT FOUND</span>
        </div>
      </div>
    );
  }

  const hex = f.hex;
  const side = f.side;

  return (
    <div className="col">
      <AppTopBar />

      {/* Status strip */}
      <div
        className="row ai-c jc-sb"
        style={{ padding: '14px 32px', borderBottom: '1px solid var(--border)', background: 'var(--bg-stage)', gap: 12 }}
      >
        <div className="row gap-12 ai-c">
          <span
            className="t-mono t-xs"
            style={{ letterSpacing: '0.28em', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}
          >
            § FIGHTER FILE · INDEX {f.index} · aggression/patience/risk stats
          </span>
          <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
          <span className="chip" style={{ color: hex, borderColor: hex }}>
            FIGHTER · INDEX {f.index}
          </span>
        </div>
        <Link href="/duel">
          <BracketButton variant="ghost">← BACK TO LOBBY</BracketButton>
        </Link>
      </div>

      {/* Big bio header */}
      <section
        style={{ position: 'relative', padding: '48px 32px 32px', overflow: 'hidden', borderBottom: '1px solid var(--border)' }}
      >
        <div
          className="row gap-32 ai-c"
          style={{ position: 'relative', maxWidth: 1240, margin: '0 auto' }}
        >
          <div style={{ filter: `drop-shadow(0 0 40px ${hex})` }}>
            <FighterAvatar fighter={fid} context="card" size={220} state="winning" />
          </div>
          <div className="col gap-12 flex-1">
            <span className="eyebrow" style={{ color: 'var(--text-dim)' }}>
              SOMNIA · FIGHTER INDEX {f.index}
            </span>
            <h1
              className="fp-display"
              style={{
                fontSize: 'clamp(56px, 9vw, 124px)',
                letterSpacing: '0.04em',
                lineHeight: 1,
                margin: 0,
                color: hex,
                textShadow: `0 0 50px ${hex}`,
              }}
            >
              {f.name}
            </h1>
            <span className="t-mono" style={{ fontSize: 16, color: 'var(--text)', fontStyle: 'italic' }}>
              &ldquo;{f.tagline}&rdquo;
            </span>
            <div className="row gap-24 ai-c" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <div className="col gap-2">
                <span className="eyebrow">AGGRESSION</span>
                <span className="t-num" style={{ fontSize: 24 }}>{f.aggression} / 5</span>
              </div>
              <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
              <div className="col gap-2">
                <span className="eyebrow">PATIENCE</span>
                <span className="t-num" style={{ fontSize: 24 }}>{f.patience} / 5</span>
              </div>
              <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
              <div className="col gap-2">
                <span className="eyebrow">RISK</span>
                <span className="t-num" style={{ fontSize: 24 }}>{f.risk} / 5</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* § 01 PROFILE */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 32, paddingBottom: 32 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 01</span>
          <span className="sect-head-title">PROFILE</span>
          <span className="sect-head-meta">on-chain attributes from FighterRegistry</span>
        </div>

        <div className="row gap-16" style={{ alignItems: 'stretch' }}>
          <div className="card flex-1 col gap-12 pad-24">
            <span className="label-tiny">COMBAT ATTRIBUTES</span>
            <hr className="divider" />
            <div className="row jc-sb ai-c">
              <span className="label-tiny">AGGRESSION</span>
              <Meter value={f.aggression} side={side} />
            </div>
            <div className="row jc-sb ai-c">
              <span className="label-tiny">PATIENCE</span>
              <Meter value={f.patience} side={side} />
            </div>
            <div className="row jc-sb ai-c">
              <span className="label-tiny">RISK TOLERANCE</span>
              <Meter value={f.risk} side={side} />
            </div>
          </div>

          <div className="card flex-1 col gap-12 pad-24">
            <span className="label-tiny">FIGHTER INDEX</span>
            <span
              className="t-num"
              style={{ fontSize: 48, color: hex, lineHeight: 1 }}
            >
              #{f.index}
            </span>
            <hr className="divider" />
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Registry</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>FighterRegistry.sol</span>
            </div>
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Chain</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>Somnia Shannon</span>
            </div>
          </div>
        </div>
      </section>

      {/* § 02 DOSSIER */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 32 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">DOSSIER</span>
          <span className="sect-head-meta">system prompt from FighterRegistry.getFighter({f.index}).systemPrompt</span>
        </div>
        <div className="row gap-32 ai-s">
          <p
            className="fp-display"
            style={{
              fontSize: 'clamp(28px, 3.4vw, 48px)',
              lineHeight: 1.1,
              color: 'var(--text)',
              flex: 1,
              margin: 0,
            }}
          >
            &ldquo;<span style={{ color: hex }}>{f.tagline}</span>&rdquo;
          </p>
          <p
            className="t-mono t-sm"
            style={{ margin: 0, color: 'var(--text-dim)', lineHeight: 1.8, flex: 1, paddingTop: 6 }}
          >
            {f.systemPrompt}
          </p>
        </div>
      </section>

      {/* § 03 DUEL HISTORY */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 03</span>
          <span className="sect-head-title">DUEL HISTORY</span>
          <span className="sect-head-meta">settled duels from Arena events</span>
        </div>

        <div className="card pad-24 col gap-12 ai-c jc-c" style={{ minHeight: 120 }}>
          <span
            className="t-mono t-xs"
            style={{ letterSpacing: '0.2em', color: 'var(--text-faint)', textAlign: 'center' }}
          >
            DUEL HISTORY — wiring in progress
          </span>
          <span
            className="t-mono t-xs t-faint"
            style={{ textAlign: 'center' }}
          >
            On-chain event indexing coming soon. Check back after the first duels resolve.
          </span>
        </div>
      </section>
    </div>
  );
}
