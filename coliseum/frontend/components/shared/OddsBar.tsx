'use client';

import React from 'react';

interface OddsBarProps {
  oddsA: number; // 0 to 100
  oddsB: number; // 0 to 100
  className?: string;
}

export const OddsBar: React.FC<OddsBarProps> = ({
  oddsA,
  oddsB,
  className = '',
}) => {
  const total = oddsA + oddsB === 0 ? 1 : oddsA + oddsB;
  const pctA = (oddsA / total) * 100;

  return (
    <div className={`odds-bar relative w-full h-[18px] bg-slate-900 border border-slate-800 overflow-hidden flex ${className}`}>
      {/* Fighter A Fill (Left Side) */}
      <div
        className="h-full bg-[var(--fighter-a)] transition-all duration-[600ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{ width: `${pctA}%` }}
      />

      {/* Fighter B Fill (Right Side) */}
      <div
        className="h-full bg-[var(--fighter-b)] flex-1 transition-all duration-[600ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
      />

      {/* 10 Segment overlays */}
      <div className="absolute inset-0 flex justify-between pointer-events-none z-10">
        {[...Array(9)].map((_, i) => (
          <div
            key={i}
            className="h-full w-[1px] bg-black/45"
            style={{ left: `${(i + 1) * 10}%` }}
          />
        ))}
      </div>
    </div>
  );
};
