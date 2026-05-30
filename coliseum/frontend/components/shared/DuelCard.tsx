'use client';

import Link from 'next/link';
import { formatUnits } from 'viem';
import { useDuelState } from '@/hooks/useDuelState';
import { useFighters } from '@/hooks/useFighters';

interface DuelCardProps {
  duelId: bigint;
  fighterAIndex: number;
  fighterBIndex: number;
}

const VISUAL_IDENTITY: Record<number, { hex: string }> = {
  0: { hex: '#ff3366' },
  1: { hex: '#00d9ff' },
  2: { hex: '#a78bfa' },
  3: { hex: '#fcd34d' },
  4: { hex: '#f97316' },
  5: { hex: '#34d399' },
};

function getStatusLabel(status: number): string {
  switch (status) {
    case 1: return 'ACTIVE';
    case 2: return 'FINALIZING';
    case 3: return 'RESOLVED';
    default: return 'PENDING';
  }
}

export default function DuelCard({ duelId, fighterAIndex, fighterBIndex }: DuelCardProps) {
  const { duel, odds, totalBetsA, totalBetsB, currentTurn, isActive, isLoading } = useDuelState(duelId);
  const { fighters } = useFighters();

  const fighterA = fighters.find(f => f.index === fighterAIndex);
  const fighterB = fighters.find(f => f.index === fighterBIndex);

  const hexA = VISUAL_IDENTITY[fighterAIndex]?.hex ?? '#ff3366';
  const hexB = VISUAL_IDENTITY[fighterBIndex]?.hex ?? '#00d9ff';

  const totalTurns = duel?.turns ?? 0;
  const status = duel?.status ?? 0;
  const statusLabel = getStatusLabel(status);

  const oddsAPct = odds ? Math.round(odds.degenBps / 100) : 50;
  const oddsBPct = odds ? Math.round(odds.whaleBps / 100) : 50;

  const totalPot = totalBetsA + totalBetsB;
  const totalPotFormatted = formatUnits(totalPot, 18);
  const potDisplay = parseFloat(totalPotFormatted).toFixed(2);

  const nameA = fighterA?.name ?? `Fighter #${fighterAIndex}`;
  const nameB = fighterB?.name ?? `Fighter #${fighterBIndex}`;

  return (
    <Link href={`/duel/${duelId.toString()}`} style={{ textDecoration: 'none', display: 'block' }}>
      <div className="card" style={{ cursor: 'pointer', transition: 'border-color 0.15s' }}>
        <div className="col gap-12 pad-16">

          {/* Header row: Duel # + status chip */}
          <div className="row ai-c jc-sb">
            <span className="t-mono t-xs t-dim">DUEL #{duelId.toString()}</span>
            <span
              className={`chip${isActive ? ' chip-live' : ''}`}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {isActive && <span className="dot dot-a pulse" style={{ width: '6px', height: '6px', borderRadius: '50%' }} />}
              <span className="t-xs t-mono t-up">{statusLabel}</span>
            </span>
          </div>

          {/* Fighter names row */}
          <div className="row ai-c gap-8">
            <span
              className="t-mono t-sm t-up"
              style={{ color: hexA, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {nameA}
            </span>
            <span className="t-mono t-dim" style={{ fontSize: '10px', flexShrink: 0 }}>VS</span>
            <span
              className="t-mono t-sm t-up"
              style={{ color: hexB, flex: 1, textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {nameB}
            </span>
          </div>

          {/* Odds bar */}
          <div className="col gap-4">
            <div
              style={{
                height: '4px',
                borderRadius: '2px',
                overflow: 'hidden',
                background: 'var(--border)',
                display: 'flex',
              }}
            >
              <div style={{ width: `${oddsAPct}%`, background: hexA, transition: 'width 0.3s' }} />
              <div style={{ width: `${oddsBPct}%`, background: hexB, transition: 'width 0.3s' }} />
            </div>
            <div className="row jc-sb">
              <span className="t-xs t-mono" style={{ color: hexA }}>{oddsAPct}%</span>
              <span className="t-xs t-mono" style={{ color: hexB }}>{oddsBPct}%</span>
            </div>
          </div>

          {/* Footer row: round progress + pot */}
          <div className="row ai-c jc-sb">
            <span className="t-xs t-dim t-mono">
              {isLoading ? '—' : `RND ${currentTurn} / ${totalTurns}`}
            </span>
            <span className="t-xs t-mono" style={{ color: 'var(--gold)' }}>
              {potDisplay} <span className="t-faint">USDso</span>
            </span>
          </div>

        </div>
      </div>
    </Link>
  );
}
