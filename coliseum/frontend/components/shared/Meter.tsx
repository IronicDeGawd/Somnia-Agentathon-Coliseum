'use client';

import React from 'react';

interface MeterProps {
  value: number; // 1 to 5
  side?: 'a' | 'b';
  max?: number;
  className?: string;
}

export const Meter: React.FC<MeterProps> = ({
  value,
  side = 'a',
  max = 5,
  className = '',
}) => {
  const roundedVal = Math.max(0, Math.min(max, Math.round(value)));

  return (
    <span className={`meter ${side} ${className}`}>
      {Array.from({ length: max }).map((_, i) => (
        <span key={i} className={i < roundedVal ? 'on' : ''} />
      ))}
    </span>
  );
};
