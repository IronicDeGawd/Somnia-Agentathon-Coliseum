'use client';

import React, { useEffect, useRef, useState } from 'react';

// Each turn on Somnia testnet is 600 blocks × ~1s/block ≈ 60–90s.
// We can't read exact block timing cheaply, so we use a local 90s countdown
// that resets whenever the parent signals a TurnAdvanced event.
const TURN_DURATION_SEC = 90;

interface RoundClockProps {
  currentTurn: number;
  totalTurns: number;
  isActive: boolean;
  onTurnAdvanced?: () => void;
}

export const RoundClock: React.FC<RoundClockProps> = ({
  currentTurn,
  totalTurns,
  isActive,
  onTurnAdvanced,
}) => {
  const [secondsLeft, setSecondsLeft] = useState<number>(TURN_DURATION_SEC);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevTurnRef = useRef<number>(currentTurn);

  // Reset the countdown whenever currentTurn increments (chain confirmed TurnAdvanced).
  useEffect(() => {
    if (currentTurn !== prevTurnRef.current) {
      prevTurnRef.current = currentTurn;
      setSecondsLeft(TURN_DURATION_SEC);
      onTurnAdvanced?.();
    }
  }, [currentTurn, onTurnAdvanced]);

  // Tick the local countdown while the duel is active.
  useEffect(() => {
    if (!isActive) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          // Clock reached 0 before chain confirmation — optimistic reset, visual only.
          return TURN_DURATION_SEC;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isActive]);

  const progress = ((TURN_DURATION_SEC - secondsLeft) / TURN_DURATION_SEC) * 100;
  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const timeLabel = mins > 0
    ? `${mins}m ${secs.toString().padStart(2, '0')}s`
    : `${secs}s`;

  const isFinalRound = currentTurn >= totalTurns;

  let barColor: string;
  if (!isActive) {
    barColor = 'var(--win)';
  } else if (isFinalRound) {
    barColor = 'var(--gold)';
  } else {
    barColor = 'var(--fighter-a)';
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px 16px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        minWidth: '200px',
      }}
    >
      {/* Layer 1 — top row: round label + optional badge */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        <span
          className="t-mono t-up"
          style={{
            fontSize: '11px',
            letterSpacing: '0.08em',
            color: 'var(--text-dim)',
          }}
        >
          {!isActive
            ? 'DUEL COMPLETE'
            : isFinalRound
            ? 'FINAL ROUND'
            : `ROUND ${currentTurn} / ${totalTurns}`}
        </span>

        {!isActive ? (
          <span
            style={{ fontSize: '14px', color: 'var(--gold)', lineHeight: 1 }}
            aria-label="trophy"
          >
            ★
          </span>
        ) : isFinalRound ? (
          <span
            className="chip chip-live"
            style={{ fontSize: '10px', padding: '2px 6px' }}
          >
            FINAL
          </span>
        ) : null}
      </div>

      {/* Layer 2 — countdown line (hidden when not active) */}
      {isActive && (
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '4px',
          }}
        >
          <span
            className="t-mono t-xs t-dim"
            style={{ letterSpacing: '0.04em', whiteSpace: 'nowrap' }}
          >
            NEXT TURN IN
          </span>
          <span
            className="t-mono t-num"
            style={{
              fontSize: '15px',
              fontWeight: 700,
              color: secondsLeft <= 10 ? 'var(--loss)' : 'var(--text)',
              minWidth: '52px',
              textAlign: 'right',
            }}
          >
            ~{timeLabel}
          </span>
        </div>
      )}

      {/* Layer 3 — 3px progress bar */}
      <div
        style={{
          height: '3px',
          borderRadius: '2px',
          background: 'var(--border)',
          overflow: 'hidden',
          marginTop: '2px',
        }}
      >
        <div
          style={{
            height: '100%',
            width: isActive ? `${progress}%` : '100%',
            background: barColor,
            transition: 'width 1s linear, background 0.3s ease',
            borderRadius: '2px',
          }}
        />
      </div>
    </div>
  );
};
