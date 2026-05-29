'use client';

import React from 'react';
import Link from 'next/link';

interface TopBarProps {
  showNavigation?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({ showNavigation = true }) => {
  return (
    <header className="topbar">
      {/* Brand + version pill */}
      <div className="row gap-16 ai-c">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>COLISEUM</Link>
        <span
          className="t-mono t-faint"
          style={{ fontSize: 11, letterSpacing: '0.24em' }}
        >
          v0.4.2 · TESTNET
        </span>
      </div>

      {/* Nav anchors */}
      {showNavigation && (
        <div className="row gap-16 ai-c">
          <a className="nav-link" href="#fight">TONIGHT</a>
          <a className="nav-link" href="#tape">TAPE</a>
          <a className="nav-link" href="#roster">ROSTER</a>
          <a className="nav-link" href="#ledger">LEDGER</a>
        </div>
      )}

      <div className="grow" />

      {/* Live pill + ENTER */}
      <div className="row gap-12 ai-c">
        <span className="chip">
          <span className="dot dot-a pulse" />
          ROUND #341 LIVE · 89 watching
        </span>
        <Link href="/duel">
          <button className="bk bk-primary">ENTER →</button>
        </Link>
      </div>
    </header>
  );
};
