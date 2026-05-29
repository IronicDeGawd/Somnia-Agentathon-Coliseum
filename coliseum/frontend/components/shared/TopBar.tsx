'use client';

import React from 'react';
import Link from 'next/link';

interface TopBarProps {
  showNavigation?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({ showNavigation = true }) => {
  return (
    <header
      className="flex items-center justify-between sticky top-0 z-50"
      style={{
        padding: '14px 32px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(10,6,18,0.85)',
        backdropFilter: 'blur(10px)',
      }}
    >
      {/* Brand + version pill */}
      <div className="flex items-center gap-8">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>COLISEUM</Link>
        <span
          className="t-mono text-[11px] text-[var(--text-faint)] whitespace-nowrap"
          style={{ letterSpacing: '0.24em' }}
        >
          v0.4.2 · TESTNET
        </span>
      </div>

      {/* Nav anchors */}
      {showNavigation && (
        <div className="hidden md:flex items-center gap-5">
          <a className="nav-link t-mono text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]" href="#fight">TONIGHT</a>
          <a className="nav-link t-mono text-[11px] text-[var(--text-dim)] hover:text-[var(--text)] whitespace-nowrap" href="#tape">TAPE</a>
          <a className="nav-link t-mono text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]" href="#roster">ROSTER</a>
          <a className="nav-link t-mono text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]" href="#ledger">LEDGER</a>
        </div>
      )}

      {/* Live pill + ENTER */}
      <div className="flex items-center gap-3">
        <span className="t-mono text-[11px] text-[var(--text-dim)] whitespace-nowrap flex items-center">
          <span className="dot dot-a pulse" style={{ marginRight: 6 }} />
          ROUND #341 LIVE · 89 watching
        </span>
        <Link href="/duel">
          <button className="bk bk-primary">ENTER →</button>
        </Link>
      </div>
    </header>
  );
};
