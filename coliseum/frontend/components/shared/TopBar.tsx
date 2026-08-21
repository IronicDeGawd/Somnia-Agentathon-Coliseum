'use client';

import React from 'react';
import Link from 'next/link';
import { useActiveDuels } from '@/hooks/useActiveDuels';

interface TopBarProps {
  showNavigation?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({ showNavigation = true }) => {
  const { duels, isLoading } = useActiveDuels();
  const liveCount = duels.length;

  return (
    <header className="topbar">
      {/* Brand */}
      <div className="row gap-16 ai-c">
        <Link href="/" className="brand row ai-c" style={{ textDecoration: 'none', gap: 10 }}>
          <img src="/logo.png" alt="" width={24} height={24} style={{ display: 'block', imageRendering: 'pixelated' }} />
          COLISEUM
        </Link>
        {/* The version number that used to sit here was written by hand and
            nothing updated it, so it aged into a claim about a build that no
            longer existed. What matters — that this is not real money — stays. */}
        <span className="t-mono t-faint" style={{ fontSize: 11, letterSpacing: '0.24em' }}>
          TESTNET
        </span>
      </div>

      {/* Nav. These are DESTINATIONS, not scroll positions. The four links here
          used to jump to sections of this same page, which meant the landing
          page had no route to the two places somebody arriving actually wants:
          the fights running right now, and the roster. The page's own sections
          are still reachable from the footer. */}
      {showNavigation && (
        <div className="row gap-16 ai-c">
          <Link className="nav-link" href="/duel/live" style={{ textDecoration: 'none' }}>
            LIVE{liveCount > 0 ? ` (${liveCount})` : ''}
          </Link>
          <Link className="nav-link" href="/duel" style={{ textDecoration: 'none' }}>
            LOBBY
          </Link>
          <Link className="nav-link" href="/fighters" style={{ textDecoration: 'none' }}>
            FIGHTERS
          </Link>
        </div>
      )}

      <div className="grow" />

      {/* Live pill + ENTER.
          This pill used to read `ROUND #341 LIVE · 89 watching`, both numbers
          written into the source. On a site whose whole claim is that every move
          is on-chain and checkable, an invented figure in the masthead is the
          most expensive kind of decoration. It is now the arena's own count, and
          it says ARENA DARK when nothing is running rather than inventing
          something to fill the space. */}
      <div className="row gap-12 ai-c">
        <span className="chip">
          {isLoading ? (
            <>
              <span className="dot" /> READING ARENA…
            </>
          ) : liveCount > 0 ? (
            <>
              <span className="dot dot-a pulse" />
              {liveCount} {liveCount === 1 ? 'FIGHT' : 'FIGHTS'} LIVE
            </>
          ) : (
            <>
              <span className="dot dot-warn" /> ARENA DARK
            </>
          )}
        </span>
        <Link href="/duel">
          <button className="bk bk-primary">ENTER →</button>
        </Link>
      </div>
    </header>
  );
};
