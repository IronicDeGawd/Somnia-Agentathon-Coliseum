'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useUIStore } from '@/store/ui';

/**
 * In-app top bar (Lobby / Arena / Profile).
 *
 * Mirrors the design's `TopBar` in `Coliseum.html` (components.jsx:121-152)
 * VERBATIM, using the design's own CSS utility classes (.row, .col, .ai-c,
 * .gap-16, .grow, .nav-link, .brand, .chip, .dot, .bk).
 *
 * DO NOT mix Tailwind utilities into this component — the design CSS is the
 * single source of truth.
 */
export const AppTopBar: React.FC = () => {
  const audioOn = useUIStore((s) => s.audioOn);
  const toggleAudio = useUIStore((s) => s.toggleAudio);

  const pathname = usePathname() || '';
  const [walletConnected, setWalletConnected] = useState(false);
  const [balance] = useState(25);

  const onLobby = pathname === '/duel';
  const onArena =
    pathname.startsWith('/duel/') &&
    !pathname.endsWith('/preduel') &&
    !pathname.endsWith('/result');
  const onProfile = pathname.startsWith('/fighters/');

  return (
    <div className="topbar">
      <Link
        href="/"
        className="brand"
        style={{ cursor: 'pointer', textDecoration: 'none' }}
      >
        COLISEUM
      </Link>

      <div className="row gap-16 ai-c">
        <Link
          href="/duel"
          className={`nav-link ${onLobby ? 'active' : ''}`}
          style={{ textDecoration: 'none' }}
        >
          Lobby
        </Link>
        <Link
          href="/duel/1"
          className={`nav-link ${onArena ? 'active' : ''}`}
          style={{ textDecoration: 'none' }}
        >
          Arena
        </Link>
        <Link
          href="/fighters/degen"
          className={`nav-link ${onProfile ? 'active' : ''}`}
          style={{ textDecoration: 'none' }}
        >
          Fighters
        </Link>
        <Link href="/" className="nav-link" style={{ textDecoration: 'none' }}>
          ← Landing
        </Link>
      </div>

      <div className="grow" />

      <div className="row gap-12 ai-c">
        <span className="chip">
          <span className="dot dot-warn pulse" /> TESTNET
        </span>
        {walletConnected ? (
          <span className="chip">
            <span className="dot dot-win" /> 0x4F…A1c2 ·{' '}
            <span className="t-num text-gold" style={{ marginLeft: 6 }}>
              ${balance.toFixed(2)}
            </span>
          </span>
        ) : (
          <button className="bk" onClick={() => setWalletConnected(true)}>
            CONNECT WALLET
          </button>
        )}
        <button
          className="bk bk-ghost"
          onClick={toggleAudio}
          title={audioOn ? 'Mute' : 'Unmute'}
        >
          {audioOn ? '♪ ON' : '♪ OFF'}
        </button>
      </div>
    </div>
  );
};
