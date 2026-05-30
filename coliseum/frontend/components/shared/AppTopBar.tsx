'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useUIStore } from '@/store/ui';
import { useUSDsoBalance } from '@/hooks/useUSDsoBalance';
import { SwapModal } from '@/components/shared/SwapModal';

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
  const [swapOpen, setSwapOpen] = useState(false);

  const pathname = usePathname() || '';

  const { address } = useAccount();
  const { formatted: usdsoBalance } = useUSDsoBalance(address);

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
        className="brand row ai-c"
        style={{ cursor: 'pointer', textDecoration: 'none', gap: 10 }}
      >
        <img
          src="/logo.png"
          alt=""
          width={24}
          height={24}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
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
        <ConnectButton.Custom>
          {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
            const ready = mounted;
            const connected = ready && account && chain;
            return (
              <div
                aria-hidden={!ready}
                style={!ready ? { opacity: 0, pointerEvents: 'none', userSelect: 'none' } : undefined}
              >
                {!connected ? (
                  <button className="bk" onClick={openConnectModal} type="button">
                    CONNECT WALLET
                  </button>
                ) : chain.unsupported ? (
                  <button className="bk" onClick={openChainModal} type="button" style={{ color: 'var(--loss)', borderColor: 'var(--loss)' }}>
                    ⚠ SWITCH NETWORK
                  </button>
                ) : (
                  <div className="row gap-8 ai-c">
                    <button
                      className="chip"
                      onClick={openAccountModal}
                      type="button"
                      title="Account"
                      style={{ cursor: 'pointer', background: 'none', border: 'none' }}
                    >
                      <span className="dot dot-win" /> {account.displayName} ·{' '}
                      <span className="t-num text-gold" style={{ marginLeft: 6 }}>
                        {usdsoBalance} USDso
                      </span>
                    </button>
                    <button
                      className="bk bk-ghost"
                      onClick={() => setSwapOpen(true)}
                      type="button"
                      title="Swap STT → USDso"
                      style={{ padding: '4px 10px' }}
                    >
                      + USDso
                    </button>
                  </div>
                )}
              </div>
            );
          }}
        </ConnectButton.Custom>
        <button
          className="bk bk-ghost"
          onClick={toggleAudio}
          title={audioOn ? 'Mute' : 'Unmute'}
        >
          {audioOn ? '♪ ON' : '♪ OFF'}
        </button>
      </div>
      <SwapModal open={swapOpen} onClose={() => setSwapOpen(false)} />
    </div>
  );
};
