'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useUIStore } from '@/store/ui';

/**
 * In-app top bar (Lobby / Arena / Profile).
 *
 * Mirrors the design's `TopBar` in `Coliseum.html` (components.jsx:121-152):
 *   COLISEUM brand → /  (returns to landing)
 *   Nav: Lobby / Arena / Fighters + ← Landing
 *   Right: TESTNET warn-pulse chip + Connect Wallet / wallet pill + ♪ audio toggle
 *
 * Active-screen highlighting via pathname.
 *
 * Note: wallet here is a local-state stub. Real wagmi/RainbowKit wiring is
 * tracked as a separate backend wiring task — see
 * context/plan/design-audit-issues.md.
 */
export const AppTopBar: React.FC = () => {
  const audioOn = useUIStore((s) => s.audioOn);
  const toggleAudio = useUIStore((s) => s.toggleAudio);

  const pathname = usePathname() || '';
  const [walletConnected, setWalletConnected] = useState(false);
  const [balance] = useState(25);

  const onLobby = pathname === '/duel';
  const onArena = pathname.startsWith('/duel/') && !pathname.endsWith('/preduel') && !pathname.endsWith('/result');
  const onProfile = pathname.startsWith('/fighters/');

  const navClass = (active: boolean) => `nav-link ${active ? 'active' : ''}`;

  return (
    <div className="topbar">
      <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
        COLISEUM
      </Link>

      <div className="flex items-center gap-4">
        <Link href="/duel" className={navClass(onLobby)} style={{ textDecoration: 'none' }}>
          Lobby
        </Link>
        <Link href="/duel/1" className={navClass(onArena)} style={{ textDecoration: 'none' }}>
          Arena
        </Link>
        <Link href="/fighters/degen" className={navClass(onProfile)} style={{ textDecoration: 'none' }}>
          Fighters
        </Link>
        <Link href="/" className="nav-link" style={{ textDecoration: 'none' }}>
          ← Landing
        </Link>
      </div>

      <div className="grow" />

      <div className="flex items-center gap-3">
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
