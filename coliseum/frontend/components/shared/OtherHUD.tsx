'use client';

import React from 'react';
import { useUIStore } from '@/store/ui';
import { fmtUsd, fmtPct } from '@/lib/format';

// ------------------------------------------------------------
// BracketButton Component
// ------------------------------------------------------------
interface BracketButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'a' | 'b' | 'ghost' | 'gold';
  children: React.ReactNode;
}

export const BracketButton: React.FC<BracketButtonProps> = ({
  variant = 'primary',
  children,
  className = '',
  ...props
}) => {
  const variantClass = {
    primary: 'bk-primary',
    a: 'bk-a',
    b: 'bk-b',
    ghost: 'bk-ghost',
    gold: 'bk-gold',
  }[variant];

  return (
    <button className={`bk ${variantClass} ${className}`} {...props}>
      {children}
    </button>
  );
};

// ------------------------------------------------------------
// Chip Component
// ------------------------------------------------------------
interface ChipProps {
  variant?: 'default' | 'a' | 'b' | 'live' | 'win' | 'loss' | 'warn' | 'gold';
  children: React.ReactNode;
  className?: string;
}

export const Chip: React.FC<ChipProps> = ({
  variant = 'default',
  children,
  className = '',
}) => {
  const variantClass = variant === 'default' ? '' : `chip-${variant}`;
  return (
    <span className={`chip ${variantClass} ${className}`}>
      {children}
    </span>
  );
};

// ------------------------------------------------------------
// Dot Component
// ------------------------------------------------------------
interface DotProps {
  variant?: 'default' | 'a' | 'b' | 'win' | 'loss' | 'warn' | 'gold';
  pulse?: boolean;
  className?: string;
}

export const Dot: React.FC<DotProps> = ({
  variant = 'default',
  pulse = false,
  className = '',
}) => {
  const variantClass = variant === 'default' ? '' : `dot-${variant}`;
  const pulseClass = pulse ? 'pulse' : '';

  return (
    <span className={`dot ${variantClass} ${pulseClass} ${className}`} />
  );
};

// ------------------------------------------------------------
// SectionHead Component
// ------------------------------------------------------------
interface SectionHeadProps {
  num: string;
  title: string;
  meta?: string;
  className?: string;
}

export const SectionHead: React.FC<SectionHeadProps> = ({
  num,
  title,
  meta,
  className = '',
}) => {
  return (
    <div className={`sect-head ${className}`}>
      <span className="sect-head-num">{num}</span>
      <span className="sect-head-title">{title}</span>
      {meta && <span className="sect-head-meta">{meta}</span>}
    </div>
  );
};

// ------------------------------------------------------------
// Ticker Component (Scrolling Marquee)
// ------------------------------------------------------------
interface TickerProps {
  items: string[];
  speed?: number; // seconds for full scroll
  className?: string;
}

export const Ticker: React.FC<TickerProps> = ({
  items,
  speed = 50,
  className = '',
}) => {
  const tickerItems = [...items, ...items];

  return (
    <div className={`relative overflow-hidden w-full border-y border-[var(--border)] bg-[var(--bg-stage)] py-2 select-none z-10 ${className}`}>
      <div 
        className="ticker flex gap-12 whitespace-nowrap text-xs font-mono text-[var(--text-dim)] uppercase tracking-wider items-center"
        style={{ animationDuration: `${speed}s` }}
      >
        {tickerItems.map((item, idx) => (
          <div key={idx} className="flex items-center gap-3">
            <span className="text-[var(--fighter-a)] font-bold">§</span>
            <span>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ------------------------------------------------------------
// CrtBg Component (CRT vignette and scanlines)
// ------------------------------------------------------------
export const CrtBg: React.FC = () => {
  const showCrtScanlines = useUIStore((state) => state.showCrtScanlines);

  if (!showCrtScanlines) return null;

  return (
    <>
      {/* Scanline layer overlay */}
      <div className="fixed inset-0 pointer-events-none z-[999] opacity-[0.06] bg-[linear-gradient(rgba(18,10,40,0)_50%,rgba(0,0,0,0.8)_50%)] bg-[size:100%_4px]" />
      {/* CRT screen distortion / vignette */}
      <div className="fixed inset-0 pointer-events-none z-[998] shadow-[inset_0_0_100px_rgba(0,0,0,0.6)] bg-radial-vignette" />
      {/* Dynamic grain texture filter */}
      <div className="grain" />
    </>
  );
};

// ------------------------------------------------------------
// PnLBlock Component
// ------------------------------------------------------------
interface PnLBlockProps {
  pnl: number;
  pct: number;
  className?: string;
  size?: 'sm' | 'lg';
}

export const PnLBlock: React.FC<PnLBlockProps> = ({
  pnl,
  pct,
  className = '',
  size = 'sm',
}) => {
  const isPositive = pnl >= 0;
  const colorClass = isPositive ? 'text-[var(--win)]' : 'text-[var(--loss)]';
  const arrow = isPositive ? '▲' : '▼';

  return (
    <div className={`flex flex-col ${className}`}>
      <div className={`font-mono leading-none flex items-baseline gap-1.5 ${colorClass}`}>
        <span className={size === 'lg' ? 'text-3xl font-bold tracking-tight' : 'text-lg font-bold'}>
          {fmtUsd(pnl)}
        </span>
        <span className="text-xs font-bold leading-none">
          {arrow}
        </span>
      </div>
      <div className="text-[10px] text-[var(--text-faint)] mt-1 font-bold">
        {fmtPct(pct)} RETURN
      </div>
    </div>
  );
};
