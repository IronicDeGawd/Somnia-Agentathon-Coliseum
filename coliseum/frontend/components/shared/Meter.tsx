'use client';

import React from 'react';

interface MeterProps {
  value: number; // 1 to 5
  side?: 'a' | 'b';
  className?: string;
}

export const Meter: React.FC<MeterProps> = ({
  value,
  side = 'a',
  className = '',
}) => {
  const roundedVal = Math.max(0, Math.min(5, Math.round(value)));

  return (
    <div className={`meter flex gap-1 items-center ${className}`}>
      {[...Array(5)].map((_, i) => {
        const isActive = i < roundedVal;
        return (
          <div
            key={i}
            className={`meter-dot w-[6px] h-[6px] border ${
              isActive
                ? side === 'a'
                  ? 'bg-[var(--fighter-a)] border-[var(--fighter-a)] shadow-[0_0_4px_var(--fighter-a)]'
                  : 'bg-[var(--fighter-b)] border-[var(--fighter-b)] shadow-[0_0_4px_var(--fighter-b)]'
                : 'bg-transparent border-[var(--border)]'
            }`}
          />
        );
      })}
    </div>
  );
};
