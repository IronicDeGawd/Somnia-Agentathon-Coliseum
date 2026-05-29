'use client';

import React from 'react';

interface OddsBarProps {
  oddsA: number; // 0 to 100
  oddsB: number; // 0 to 100
  height?: number;
  className?: string;
}

export const OddsBar: React.FC<OddsBarProps> = ({
  oddsA,
  oddsB,
  height = 18,
  className = '',
}) => {
  const total = oddsA + oddsB === 0 ? 1 : oddsA + oddsB;
  // Clamp to 2-98 to always show a sliver of each side, matching design
  const pct = Math.max(2, Math.min(98, (oddsA / total) * 100));

  return (
    <div className={`odds-bar ${className}`} style={{ height }}>
      <div className="odds-bar-fill" style={{ width: `${pct}%` }} />
      <div className="odds-bar-rest" />
      <div className="odds-segments">
        {Array.from({ length: 10 }).map((_, i) => (
          <span key={i} />
        ))}
      </div>
    </div>
  );
};
