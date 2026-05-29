'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Volume2, VolumeX, Monitor, LayoutGrid, Palette, ShieldAlert } from 'lucide-react';
import { useUIStore } from '@/store/ui';

interface TopBarProps {
  showNavigation?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({ showNavigation = true }) => {
  const {
    palette,
    layout,
    showCrtScanlines,
    audioOn,
    setPalette,
    setLayout,
    toggleCrtScanlines,
    toggleAudio,
  } = useUIStore();

  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);

  return (
    <header className="topbar w-full bg-[var(--bg-deep)] border-b border-[var(--border)] relative z-50 flex items-center justify-between text-xs font-mono uppercase tracking-wider">
      {/* Brand logo & underlying gradient rule */}
      <div className="flex items-center gap-6">
        <Link href="/" className="brand text-lg tracking-widest text-[var(--text)] font-bold font-sans">
          COLISEUM
        </Link>
        <span className="h-4 w-[1px] bg-[var(--border)]" />
        <div className="hidden lg:flex items-center gap-2.5 text-[10px] text-[var(--fighter-a)] font-bold">
          <span className="w-1.5 h-1.5 bg-[var(--fighter-a)] animate-ping" />
          <span className="w-1.5 h-1.5 bg-[var(--fighter-a)] absolute" />
          <span>BOUT #342 LIVE · 89 SPECTATING</span>
        </div>
      </div>

      {/* Navigation anchors (Landing page scroll sections) */}
      {showNavigation && (
        <nav className="hidden md:flex items-center gap-8 text-[var(--text-dim)]">
          <a href="#fight" className="hover:text-[var(--text)] transition-colors py-1">TONIGHT</a>
          <a href="#tape" className="hover:text-[var(--text)] transition-colors py-1">TAPE</a>
          <a href="#roster" className="hover:text-[var(--text)] transition-colors py-1">ROSTER</a>
          <a href="#ledger" className="hover:text-[var(--text)] transition-colors py-1">LEDGER</a>
        </nav>
      )}

      {/* Interactive HUD HUD controller parameters */}
      <div className="flex items-center gap-4">
        {/* Theme select palette menu */}
        <div className="relative">
          <button
            onClick={() => {
              setShowThemeMenu(!showThemeMenu);
              setShowLayoutMenu(false);
            }}
            className="p-2 border border-[var(--border)] rounded-[2px] hover:border-[var(--text-dim)] text-[var(--text-dim)] hover:text-[var(--text)] transition-all flex items-center gap-1.5 cursor-pointer"
            title="Switch Theme Palette"
          >
            <Palette className="w-3.5 h-3.5" />
            <span className="hidden sm:inline text-[10px]">{palette}</span>
          </button>
          {showThemeMenu && (
            <div className="absolute right-0 mt-2 py-1.5 w-32 border border-[var(--border)] bg-[var(--bg-card)] rounded-[2px] shadow-xl flex flex-col z-50">
              {(['violet', 'noir', 'amber'] as const).map((theme) => (
                <button
                  key={theme}
                  onClick={() => {
                    setPalette(theme);
                    setShowThemeMenu(false);
                  }}
                  className={`px-3 py-1.5 text-left text-[10px] hover:bg-[var(--bg-stage)] cursor-pointer ${
                    palette === theme ? 'text-[var(--fighter-a)] font-bold' : 'text-[var(--text-dim)]'
                  }`}
                >
                  {theme}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Layout mode switcher (Arena only) */}
        <div className="relative">
          <button
            onClick={() => {
              setShowLayoutMenu(!showLayoutMenu);
              setShowThemeMenu(false);
            }}
            className="p-2 border border-[var(--border)] rounded-[2px] hover:border-[var(--text-dim)] text-[var(--text-dim)] hover:text-[var(--text)] transition-all flex items-center gap-1.5 cursor-pointer"
            title="Fighter Layout Options"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span className="hidden sm:inline text-[10px]">{layout}</span>
          </button>
          {showLayoutMenu && (
            <div className="absolute right-0 mt-2 py-1.5 w-32 border border-[var(--border)] bg-[var(--bg-card)] rounded-[2px] shadow-xl flex flex-col z-50">
              {(['split', 'oneUp', 'stacked'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    setLayout(mode);
                    setShowLayoutMenu(false);
                  }}
                  className={`px-3 py-1.5 text-left text-[10px] hover:bg-[var(--bg-stage)] cursor-pointer ${
                    layout === mode ? 'text-[var(--fighter-b)] font-bold' : 'text-[var(--text-dim)]'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* CRT Scanline toggler */}
        <button
          onClick={toggleCrtScanlines}
          className={`p-2 border rounded-[2px] transition-all cursor-pointer ${
            showCrtScanlines
              ? 'border-[var(--fighter-a)] text-[var(--fighter-a)] bg-[var(--fighter-a-soft)]'
              : 'border-[var(--border)] text-[var(--text-faint)] hover:border-[var(--text-dim)]'
          }`}
          title="Toggle CRT Scanline HUD Effect"
        >
          <Monitor className="w-3.5 h-3.5" />
        </button>

        {/* Audio Mute controller */}
        <button
          onClick={toggleAudio}
          className={`p-2 border rounded-[2px] transition-all cursor-pointer ${
            audioOn
              ? 'border-[var(--fighter-b)] text-[var(--fighter-b)] bg-[var(--fighter-b-soft)]'
              : 'border-[var(--border)] text-[var(--text-faint)] hover:border-[var(--text-dim)]'
          }`}
          title="Mute Ambient Sound"
        >
          {audioOn ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
        </button>

        <span className="h-4 w-[1px] bg-[var(--border)]" />

        {/* Wallet connect action button placeholder */}
        <Link href="/duel">
          <button className="bk bk-primary cursor-pointer text-[10px] py-1.5 px-3 leading-none rounded-[2px]">
            ENTER ARENA →
          </button>
        </Link>
      </div>
    </header>
  );
};
