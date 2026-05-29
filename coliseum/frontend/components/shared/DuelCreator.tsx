'use client';

import { useState, useCallback } from 'react';
import { formatUnits } from 'viem';
import { useStartDuel } from '@/hooks/useStartDuel';
import { useUSDsoBalance } from '@/hooks/useUSDsoBalance';
import { ROSTER } from '@/lib/fighters';

// Maps turn count to pool labels for the tier selector
const TIER_POOLS: Record<number, string[]> = {
  3:  ['SOMI'],
  6:  ['SOMI', 'WETH'],
  9:  ['SOMI', 'WETH', 'WBTC'],
  15: ['SOMI', 'WETH', 'WBTC'],
};

const TURN_OPTIONS = [3, 6, 9, 15] as const;
type TurnOption = typeof TURN_OPTIONS[number];

interface DuelCreatorProps {
  onDuelCreated?: (duelId: bigint) => void;
}

// Inner component that has valid hook args
function DuelCreatorInner({
  fighterA,
  fighterB,
  turns,
  onDuelCreated,
  onFighterAChange,
  onFighterBChange,
  onTurnsChange,
}: {
  fighterA: number;
  fighterB: number;
  turns: TurnOption;
  onDuelCreated?: (duelId: bigint) => void;
  onFighterAChange: (id: number) => void;
  onFighterBChange: (id: number) => void;
  onTurnsChange: (t: TurnOption) => void;
}) {
  const { balance, formatted: balanceFormatted, isLoading: balanceLoading } = useUSDsoBalance();
  const { startDuel, totalRequired, isPending, isSuccess, error } = useStartDuel(fighterA, fighterB, turns);

  const [createdDuelId, setCreatedDuelId] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<'idle' | 'approving' | 'creating' | 'done'>('idle');
  const [localError, setLocalError] = useState<string | null>(null);

  const totalRequiredFormatted = totalRequired !== null
    ? Number(formatUnits(totalRequired, 18)).toFixed(2)
    : '—';

  const hasSufficientBalance = totalRequired !== null && balance >= totalRequired;

  const handleSubmit = useCallback(async () => {
    setLocalError(null);
    setPhase('approving');

    const duelId = await startDuel();

    if (duelId !== null) {
      setCreatedDuelId(duelId);
      setPhase('done');
      onDuelCreated?.(duelId);
    } else if (error) {
      setLocalError(error.message);
      setPhase('idle');
    } else {
      // startDuel returned null but no error — tx went through, duelId unresolved
      setPhase('done');
    }
  }, [startDuel, error, onDuelCreated]);

  // Sync phase with isPending
  const displayPhase = isPending ? (phase === 'approving' ? 'approving' : 'creating') : phase;

  const canSubmit =
    fighterA !== fighterB &&
    totalRequired !== null &&
    hasSufficientBalance &&
    !isPending &&
    displayPhase !== 'done';

  const needsValidPair = fighterA === fighterB;

  const submitLabel = (() => {
    if (displayPhase === 'approving') return 'Waiting for approval…';
    if (displayPhase === 'creating') return 'Creating duel…';
    if (displayPhase === 'done') return createdDuelId !== null ? `Duel #${createdDuelId} created!` : 'Duel created!';
    return 'APPROVE + CREATE DUEL';
  })();

  return (
    <div className="col gap-24">

      {/* Header */}
      <div className="sect-head">
        <span className="sect-head-num">01</span>
        <span className="sect-head-title">START A DUEL</span>
      </div>

      {/* Fighter A */}
      <div className="col gap-12">
        <div className="eyebrow" style={{ color: 'var(--fighter-a)' }}>FIGHTER A</div>
        <div
          className="row gap-8"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '8px',
          }}
        >
          {ROSTER.map((f, idx) => {
            const selected = fighterA === idx;
            const disabledByB = fighterB === idx;
            return (
              <button
                key={f.id}
                className={`bk${selected ? ' bk-a' : ''}`}
                style={{
                  borderColor: selected ? 'var(--fighter-a)' : disabledByB ? 'var(--border)' : f.hex,
                  opacity: disabledByB ? 0.35 : 1,
                  cursor: disabledByB ? 'not-allowed' : 'pointer',
                  fontSize: '11px',
                  padding: '8px 6px',
                  letterSpacing: '0.04em',
                }}
                disabled={disabledByB}
                onClick={() => onFighterAChange(idx)}
              >
                <span
                  className="t-mono t-xs"
                  style={{ color: selected ? 'var(--fighter-a)' : f.hex }}
                >
                  {f.initials}
                </span>
                <span
                  className="t-xs t-up"
                  style={{
                    display: 'block',
                    color: selected ? 'var(--fighter-a)' : 'var(--text)',
                    marginTop: '2px',
                    fontSize: '9px',
                  }}
                >
                  {f.name.replace('THE ', '')}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Fighter B */}
      <div className="col gap-12">
        <div className="eyebrow" style={{ color: 'var(--fighter-b)' }}>FIGHTER B</div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '8px',
          }}
        >
          {ROSTER.map((f, idx) => {
            const selected = fighterB === idx;
            const disabledByA = fighterA === idx;
            return (
              <button
                key={f.id}
                className={`bk${selected ? ' bk-b' : ''}`}
                style={{
                  borderColor: selected ? 'var(--fighter-b)' : disabledByA ? 'var(--border)' : f.hex,
                  opacity: disabledByA ? 0.35 : 1,
                  cursor: disabledByA ? 'not-allowed' : 'pointer',
                  fontSize: '11px',
                  padding: '8px 6px',
                  letterSpacing: '0.04em',
                }}
                disabled={disabledByA}
                onClick={() => onFighterBChange(idx)}
              >
                <span
                  className="t-mono t-xs"
                  style={{ color: selected ? 'var(--fighter-b)' : f.hex }}
                >
                  {f.initials}
                </span>
                <span
                  className="t-xs t-up"
                  style={{
                    display: 'block',
                    color: selected ? 'var(--fighter-b)' : 'var(--text)',
                    marginTop: '2px',
                    fontSize: '9px',
                  }}
                >
                  {f.name.replace('THE ', '')}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tier / Turns selector */}
      <div className="col gap-12">
        <div className="eyebrow">TIER / ROUNDS</div>
        <div className="row gap-8">
          {TURN_OPTIONS.map((t) => {
            const selected = turns === t;
            const pools = TIER_POOLS[t];
            return (
              <button
                key={t}
                className={`bk${selected ? ' bk-gold' : ''}`}
                style={{
                  flex: 1,
                  padding: '10px 4px',
                  cursor: 'pointer',
                }}
                onClick={() => onTurnsChange(t)}
              >
                <span
                  className="t-mono"
                  style={{
                    display: 'block',
                    color: selected ? 'var(--gold)' : 'var(--text)',
                    fontSize: '16px',
                    fontWeight: 700,
                    lineHeight: 1,
                  }}
                >
                  {t}
                </span>
                <span
                  className="label-tiny t-dim"
                  style={{ display: 'block', marginTop: '4px', fontSize: '8px' }}
                >
                  {pools.join('+')}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Deposit + Balance */}
      <div className="panel pad-16 col gap-12">
        <div className="row jc-sb ai-c">
          <span className="t-sm t-dim">Required deposit</span>
          <span className="t-mono text-gold" style={{ fontSize: '15px' }}>
            {totalRequiredFormatted} USDso
          </span>
        </div>
        <div className="row jc-sb ai-c">
          <span className="t-sm t-dim">Your balance</span>
          <span className={`t-mono ${hasSufficientBalance || balanceLoading ? '' : 'text-loss'}`}
                style={{ fontSize: '13px' }}>
            {balanceLoading ? '...' : `${balanceFormatted} USDso`}
          </span>
        </div>
        {!hasSufficientBalance && !balanceLoading && totalRequired !== null && (
          <div
            className="t-xs"
            style={{ color: 'var(--loss)', borderTop: '1px solid var(--border)', paddingTop: '8px' }}
          >
            Insufficient balance. You need {totalRequiredFormatted} USDso to start this duel.
          </div>
        )}
      </div>

      {/* Validation hint */}
      {needsValidPair && (
        <div className="t-xs t-dim" style={{ textAlign: 'center' }}>
          Fighter A and Fighter B must be different.
        </div>
      )}

      {/* Error */}
      {(error || localError) && displayPhase !== 'done' && (
        <div
          className="panel pad-16 t-xs"
          style={{ color: 'var(--loss)', borderColor: 'var(--loss)', wordBreak: 'break-word' }}
        >
          {localError ?? error?.message}
        </div>
      )}

      {/* Success */}
      {displayPhase === 'done' && (
        <div
          className="panel pad-16 t-xs"
          style={{ color: 'var(--win)', borderColor: 'var(--win)', textAlign: 'center' }}
        >
          {createdDuelId !== null
            ? `Duel #${createdDuelId} created! The arena is ready.`
            : 'Duel created! Waiting for confirmation.'}
        </div>
      )}

      {/* Submit */}
      <button
        className={`bk bk-primary${canSubmit ? '' : ''}`}
        style={{
          width: '100%',
          padding: '14px',
          opacity: canSubmit ? 1 : 0.45,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          letterSpacing: '0.08em',
          fontSize: '13px',
        }}
        disabled={!canSubmit}
        onClick={handleSubmit}
      >
        {submitLabel}
      </button>
    </div>
  );
}

export function DuelCreator({ onDuelCreated }: DuelCreatorProps) {
  const [fighterA, setFighterA] = useState(0);
  const [fighterB, setFighterB] = useState(1);
  const [turns, setTurns] = useState<TurnOption>(6);

  return (
    <div className="card pad-24">
      <DuelCreatorInner
        fighterA={fighterA}
        fighterB={fighterB}
        turns={turns}
        onDuelCreated={onDuelCreated}
        onFighterAChange={setFighterA}
        onFighterBChange={setFighterB}
        onTurnsChange={setTurns}
      />
    </div>
  );
}

export default DuelCreator;
