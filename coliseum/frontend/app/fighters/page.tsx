'use client';

import React from 'react';
import Link from 'next/link';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { Meter } from '@/components/shared/Meter';
import { useFighters } from '@/hooks/useFighters';
import { fighterIndexToId } from '@/lib/fighters';

export default function FightersPage() {
  const { fighters, isLoading } = useFighters();

  return (
    <div className="col">
      <AppTopBar />

      <div
        className="row ai-c jc-sb"
        style={{ padding: '14px var(--gutter)', borderBottom: '1px solid var(--border)', background: 'var(--bg-stage)', flexWrap: 'wrap', gap: 12 }}
      >
        <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}>
          § FIGHTERS · {fighters.length} registered · Somnia Shannon
        </span>
        <Link href="/duel" style={{ textDecoration: 'none' }}>
          <span className="t-mono t-xs" style={{ color: 'var(--text-dim)', letterSpacing: '0.1em' }}>← BACK TO LOBBY</span>
        </Link>
      </div>

      <section className="shell-pad col gap-24" style={{ paddingTop: 40, paddingBottom: 120 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 01</span>
          <span className="sect-head-title">FIGHTER ROSTER</span>
          <span className="sect-head-meta">all agents registered on-chain via FighterRegistry</span>
        </div>

        {isLoading ? (
          <div className="card pad-24 col ai-c jc-c" style={{ minHeight: 200 }}>
            <span className="t-mono t-xs" style={{ letterSpacing: '0.2em', color: 'var(--text-faint)' }}>
              LOADING FIGHTERS…
            </span>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 16,
            }}
          >
            {fighters.map((f) => {
              const fid = fighterIndexToId(f.index);
              return (
                <Link
                  key={f.index}
                  href={`/fighters/${fid}`}
                  style={{ textDecoration: 'none' }}
                >
                  <div
                    className="card col gap-16 pad-24"
                    style={{
                      cursor: 'pointer',
                      borderColor: f.hex,
                      transition: 'box-shadow 0.15s, border-color 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLDivElement).style.boxShadow = `0 0 24px ${f.hex}44`;
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.boxShadow = '';
                    }}
                  >
                    <div className="row gap-16 ai-c">
                      <div style={{ filter: `drop-shadow(0 0 12px ${f.hex})`, flexShrink: 0 }}>
                        <FighterAvatar fighter={fid} context="card" size={72} state="idle" />
                      </div>
                      <div className="col gap-4 flex-1" style={{ minWidth: 0 }}>
                        <span className="eyebrow" style={{ color: 'var(--text-faint)' }}>
                          INDEX {f.index}
                        </span>
                        <span
                          className="t-mono"
                          style={{ fontSize: 20, fontWeight: 700, color: f.hex, lineHeight: 1.1 }}
                        >
                          {f.name}
                        </span>
                        <span
                          className="t-mono t-xs"
                          style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}
                        >
                          &ldquo;{f.tagline}&rdquo;
                        </span>
                      </div>
                    </div>

                    <hr className="divider" />

                    <div className="col gap-8">
                      <div className="row jc-sb ai-c">
                        <span className="label-tiny">AGGRESSION</span>
                        <Meter value={f.aggression} side={f.side} />
                      </div>
                      <div className="row jc-sb ai-c">
                        <span className="label-tiny">PATIENCE</span>
                        <Meter value={f.patience} side={f.side} />
                      </div>
                      <div className="row jc-sb ai-c">
                        <span className="label-tiny">RISK</span>
                        <Meter value={f.risk} side={f.side} />
                      </div>
                    </div>

                    <div className="row jc-sb ai-c" style={{ marginTop: 4 }}>
                      <span className="t-mono t-xs t-faint">VIEW DOSSIER →</span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
