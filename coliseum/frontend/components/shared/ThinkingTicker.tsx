'use client';

import React from 'react';

// Trader-phase status lines shown while an agent is deciding its move (the
// on-chain LLM inference step). More intuitive than a generic "THINKING…" — it
// reads like the agent is actually working the market.
const PHRASES = [
  'Reading the order book',
  'Checking the spread',
  'Finding the breakpoint',
  'Sizing the position',
  'Weighing the risk',
  'Committing the trade',
];

interface ThinkingTickerProps {
  /** Stagger two tickers so opposing fighters don't cycle in lockstep. */
  startIndex?: number;
  intervalMs?: number;
  /** CSS color for the cycling phrase (defaults to the dim text token). */
  color?: string;
}

export const ThinkingTicker: React.FC<ThinkingTickerProps> = ({
  startIndex = 0,
  intervalMs = 1700,
  color = 'var(--text-dim)',
}) => {
  const [i, setI] = React.useState(startIndex % PHRASES.length);

  React.useEffect(() => {
    const t = setInterval(() => setI((p) => (p + 1) % PHRASES.length), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  return (
    <span className="t-dim">
      {'> '}
      <span
        key={i}
        style={{ color, display: 'inline-block', animation: 'fadeIn 0.4s ease-out' }}
      >
        {PHRASES[i]}…
      </span>
    </span>
  );
};
