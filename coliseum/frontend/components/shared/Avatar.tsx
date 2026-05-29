'use client';

import React from 'react';
import { FIGHTERS, Fighter } from '@/lib/fighters';

interface AvatarProps {
  fighter: string | Partial<Fighter>;
  size?: number;
  state?: 'idle' | 'winning' | 'losing' | 'victory' | 'thinking';
  variant?: 'shield' | 'tarot' | 'helm';
  showChrome?: boolean | null;
}

export const Avatar: React.FC<AvatarProps> = ({
  fighter,
  size = 120,
  state = 'idle',
  variant = 'shield',
  showChrome = null,
}) => {
  // Resolve fighter data
  let fData: Partial<Fighter> = {};
  if (typeof fighter === 'string') {
    fData = FIGHTERS[fighter.toLowerCase()] || { id: fighter, name: fighter.toUpperCase(), hex: '#ff3366' };
  } else {
    fData = fighter || {};
  }

  const hex = fData.hex || '#ff3366';
  const name = fData.name || 'UNKNOWN';
  const rank = fData.rank || 'S';
  const tier = fData.tier || 'AGGRESSOR';

  // Determine seed for DiceBear based on fighter variant style
  let avatarSeed = fData.seedBottts || 'default-seed-1';
  let avatarStyle = 'bottts-neutral';

  if (variant === 'tarot') {
    avatarSeed = fData.seedPixel || 'pixel-seed-1';
    avatarStyle = 'pixel-art-neutral';
  } else if (variant === 'helm') {
    avatarSeed = fData.seedAdventurer || 'adventurer-seed-1';
    avatarStyle = 'adventurer-neutral';
  }

  const avatarUrl = `https://api.dicebear.com/9.x/${avatarStyle}/svg?seed=${avatarSeed}&backgroundColor=transparent&radius=0`;

  // Clip path polygon strings
  const polygons = {
    shield: 'polygon(12.7% 6.2%, 87.3% 6.2%, 96.4% 15.4%, 96.4% 79.2%, 87.3% 90%, 69% 93.8%, 31% 93.8%, 12.7% 90%, 3.6% 79.2%, 3.6% 15.4%)',
    tarot: 'polygon(7% 4%, 93% 4%, 93% 96%, 7% 96%)',
    helm: 'polygon(14.5% 10.8%, 85.5% 10.8%, 94.5% 30.8%, 94.5% 69.2%, 79% 89.2%, 21% 89.2%, 5.5% 69.2%, 5.5% 30.8%)',
  };

  const currentPolygon = polygons[variant];

  // Decide whether to show chrome details (banners, rank badges)
  const isChromeVisible = showChrome !== null ? showChrome : size >= 80;

  // Visual state filter logic
  let filterStyle: React.CSSProperties = {};
  if (state === 'victory') {
    filterStyle = {
      filter: `brightness(1.12) saturate(1.25) drop-shadow(0 0 12px ${hex})`,
    };
  } else if (state === 'winning') {
    filterStyle = {
      filter: 'brightness(1.06) saturate(1.15)',
    };
  } else if (state === 'losing') {
    // Reverted dimming as per design chat notes to preserve readability,
    // but applying a subtle styling variant
    filterStyle = {
      opacity: 0.9,
    };
  }

  return (
    <div
      className="relative flex items-center justify-center select-none"
      style={{
        width: size,
        height: size,
        ...filterStyle,
      }}
    >
      {/* 2. Glow blur layer (for winning/victory) */}
      {(state === 'winning' || state === 'victory') && (
        <div
          className="absolute inset-0 blur-md opacity-60 scale-105"
          style={{
            clipPath: currentPolygon,
            backgroundColor: hex,
          }}
        />
      )}

      {/* 1. Outer colored shield (Outer border ring) */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{
          clipPath: currentPolygon,
          backgroundColor: hex,
        }}
      >
        {/* 3. Inner stage (inset 2px, radial gradient bg + hatch lines) */}
        <div
          className="absolute inset-[2px] overflow-hidden"
          style={{
            clipPath: currentPolygon,
            background: `radial-gradient(circle at center, var(--bg-card) 30%, var(--bg-deep) 100%)`,
          }}
        >
          {/* Subtle hatch lines overlay */}
          <div className="absolute inset-0 opacity-15 pointer-events-none bg-[linear-gradient(45deg,rgba(255,255,255,0.1)_25%,transparent_25%,transparent_50%,rgba(255,255,255,0.1)_50%,rgba(255,255,255,0.1)_75%,transparent_75%,transparent)] bg-[size:8px_8px]" />

          {/* 4. Avatar Image (DiceBear, inset 8%) */}
          <div className="absolute inset-[8%] flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={avatarUrl}
              alt={name}
              className="w-full h-full object-contain"
              draggable={false}
            />
          </div>

          {/* 5. CRT scanlines (hidden at size < 48) */}
          {size >= 48 && (
            <div className="absolute inset-0 pointer-events-none opacity-[0.08] bg-[linear-gradient(rgba(18,10,40,0)_50%,rgba(0,0,0,0.8)_50%)] bg-[size:100%_4px]" />
          )}

          {/* 8. Inner accent ring (inset 5px, 1px border) */}
          <div
            className="absolute inset-[5px] pointer-events-none rounded-[1px] border"
            style={{
              clipPath: currentPolygon,
              borderColor: `${hex}40`,
            }}
          />
        </div>
      </div>

      {/* 10. Victory stars (5 ★ at top, visible when victory) */}
      {state === 'victory' && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex gap-1 z-30 drop-shadow-[0_0_4px_var(--gold)]">
          {[...Array(5)].map((_, i) => (
            <span key={i} className="text-[10px] text-yellow-400 font-bold">★</span>
          ))}
        </div>
      )}

      {/* 9. Thinking dots (3 pulsing dots) */}
      {state === 'thinking' && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center gap-1.5 z-20" style={{ clipPath: currentPolygon }}>
          <span className="w-2.5 h-2.5 bg-cyan-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
          <span className="w-2.5 h-2.5 bg-cyan-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
          <span className="w-2.5 h-2.5 bg-cyan-400 rounded-full animate-bounce" />
        </div>
      )}

      {/* 6. Rank chip (top-left, hidden at size < 80) */}
      {isChromeVisible && (
        <div
          className="absolute -top-1 -left-1 px-1.5 py-0.5 border text-[9px] font-bold z-20 text-black leading-none"
          style={{
            borderColor: hex,
            backgroundColor: hex,
          }}
        >
          {rank}
        </div>
      )}

      {/* 7. Name/tier banner (bottom center, hidden at size < 80) */}
      {isChromeVisible && (
        <div
          className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 border px-2 py-0.5 text-[8px] font-bold z-20 text-center uppercase tracking-widest whitespace-nowrap"
          style={{
            borderColor: hex,
            backgroundColor: 'var(--bg-deep)',
            color: hex,
          }}
        >
          {name.split(' ')[1] || name} · {tier}
        </div>
      )}
    </div>
  );
};
