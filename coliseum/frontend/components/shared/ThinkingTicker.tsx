'use client';

import React from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';

// Trader-phase status lines shown while an agent is deciding its move (the
// on-chain LLM inference step). Each persona gets its own voice so the wait
// reads like *that* fighter working the market, not a generic spinner.
const GENERIC = [
  'Reading the order book',
  'Checking the spread',
  'Finding the breakpoint',
  'Sizing the position',
  'Weighing the risk',
  'Committing the trade',
];

const BY_FIGHTER: Record<string, string[]> = {
  // Aggressive momentum — "Send it. Always."
  degen: [
    'Smelling momentum',
    'Is it pumping?',
    'Loading max size',
    'Stops are for cowards',
    'Aping the breakout',
    'Sending it',
  ],
  // Patient size, conviction — "I'll wait for it."
  whale: [
    'Waiting for my level',
    'Letting it come to me',
    'Sizing the conviction play',
    'Ignoring the noise',
    'Building the position',
    'Pressing the edge',
  ],
  // Tight spreads, high frequency — "Sip the spread."
  scalper: [
    'Reading the spread',
    'Skimming the bid/ask',
    'Timing the micro-move',
    'Grabbing a few ticks',
    'In and out',
    'Booking the scalp',
  ],
  // Mean-reversion systematic — "Mean reversion or nothing."
  quant: [
    'Computing the mean',
    'Measuring the deviation',
    'Checking the z-score',
    'Waiting for reversion',
    'Running the model',
    'Signal confirmed',
  ],
  // Long-only accumulator — "Never sell. Buy the dip."
  diamond: [
    'Scanning for a dip',
    'Not selling. Ever.',
    'Averaging down',
    'Stacking more',
    'Buying the fear',
    'Diamond grip engaged',
  ],
  // Sentiment fade — "Against the herd."
  contrarian: [
    'Reading the crowd',
    'Fading the hype',
    'Hunting the overreaction',
    'Zigging while they zag',
    'Betting against the herd',
    'Taking the other side',
  ],
};

interface ThinkingTickerProps {
  /** Fighter persona id (degen/whale/scalper/quant/diamond/contrarian). */
  fighterId?: string;
  /** Stagger two tickers so opposing fighters don't cycle in lockstep. */
  startIndex?: number;
  intervalMs?: number;
  /** CSS color for the cycling phrase (defaults to the dim text token). */
  color?: string;
}

export const ThinkingTicker: React.FC<ThinkingTickerProps> = ({
  fighterId,
  startIndex = 0,
  intervalMs = 1700,
  color = 'var(--text-dim)',
}) => {
  const phrases = (fighterId && BY_FIGHTER[fighterId.toLowerCase()]) || GENERIC;
  const [i, setI] = React.useState(startIndex % phrases.length);
  const still = useReducedMotion();

  React.useEffect(() => {
    // A CSS media query cannot reach a setInterval, so the check has to happen
    // here. Someone who asked the OS for less motion gets the first phrase and
    // no cycling, rather than text that rewrites itself every 1.7 seconds.
    if (still) return;
    const t = setInterval(() => setI((p) => (p + 1) % phrases.length), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, phrases.length, still]);

  return (
    // HIDDEN FROM ASSISTIVE TECH, on purpose. These phrases are flavour — they
    // are not read off the chain and say nothing about what the agent is really
    // doing. The label beside this one already announces "DECIDING…", which is
    // the fact. Left visible to a screen reader inside a live region, this
    // announced a new sentence every 1.7 seconds for the whole fight.
    <span className="t-dim" aria-hidden="true">
      {'> '}
      <span
        key={i}
        style={{
          color,
          display: 'inline-block',
          animation: still ? undefined : 'fadeIn 0.4s ease-out',
        }}
      >
        {phrases[i % phrases.length]}…
      </span>
    </span>
  );
};
