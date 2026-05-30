'use client';

import React from 'react';
import { FIGHTERS, Fighter } from '@/lib/fighters';

const FRAME_VARIANTS = {
  shield: { aspect: 260 / 220, clip: 'polygon(12.7% 6.2%, 87.3% 6.2%, 96.4% 15.4%, 96.4% 79.2%, 87.3% 90%, 69% 93.8%, 31% 93.8%, 12.7% 90%, 3.6% 79.2%, 3.6% 15.4%)' },
  tarot:  { aspect: 300 / 220, clip: 'polygon(7% 4%, 93% 4%, 93% 96%, 7% 96%)' },
  helm:   { aspect: 260 / 220, clip: 'polygon(14.5% 10.8%, 85.5% 10.8%, 94.5% 30.8%, 94.5% 69.2%, 79% 89.2%, 21% 89.2%, 5.5% 69.2%, 5.5% 30.8%)' },
};

interface AvatarProps {
  fighter: string | Partial<Fighter>;
  size?: number;
  state?: 'idle' | 'winning' | 'losing' | 'victory' | 'thinking';
  variant?: 'shield' | 'tarot' | 'helm';
  showChrome?: boolean | null;
}

export type { AvatarProps };

export const Avatar: React.FC<AvatarProps> = ({
  fighter,
  size = 96,
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
  const initials = fData.initials || name.slice(0, 2).toUpperCase();

  // Frame geometry
  const v = FRAME_VARIANTS[variant] || FRAME_VARIANTS.shield;
  const W = size;
  const H = size * v.aspect;
  const clip = v.clip;

  // DiceBear avatar URL
  let avatarUrl: string;
  if (variant === 'helm') {
    const seed = fData.seedPixel || 'pixel-seed-1';
    avatarUrl = `https://api.dicebear.com/9.x/pixel-art-neutral/svg?seed=${encodeURIComponent(seed)}&backgroundColor=transparent&radius=0`;
  } else if (variant === 'tarot') {
    const seed = fData.seedAdventurer || 'adventurer-seed-1';
    avatarUrl = `https://api.dicebear.com/9.x/adventurer-neutral/svg?seed=${encodeURIComponent(seed)}&backgroundColor=transparent&radius=0`;
  } else {
    const seed = fData.seedBottts || 'default-seed-1';
    avatarUrl = `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}&backgroundType=solid&backgroundColor=transparent&radius=0`;
  }

  // State booleans
  const isVictory = state === 'victory';
  const isLosing = state === 'losing';
  const isWinning = state === 'winning';
  const isThinking = state === 'thinking';

  // Chrome visibility
  const chrome = showChrome !== null ? showChrome : size >= 80;
  const showScanlines = size >= 48;

  // Avatar filter — applied only to the <img>
  const avatarFilter =
    isVictory ? `brightness(1.12) saturate(1.25) drop-shadow(0 0 12px ${hex})` :
    isWinning ? 'brightness(1.06) saturate(1.15)' :
    isLosing  ? 'grayscale(0.55) brightness(0.72) opacity(0.7)' :
    'none';

  // Chrome sizes scale with overall size
  const rankChipW = Math.max(18, Math.round(size * 0.13));
  const rankChipH = Math.max(14, Math.round(size * 0.1));
  const rankFontSize = Math.max(10, Math.round(size * 0.064));
  const bannerFontSize = Math.max(8, Math.round(size * 0.046));
  const bannerPad = Math.max(2, Math.round(size * 0.015));

  // Border thickness scales
  const outerBorder = size < 60 ? 1.5 : 2;
  const innerBorderInset = size < 60 ? 3 : 5;

  // Inner-stage top/bottom offsets for avatar image
  const imgTop = variant === 'tarot' ? '6%' : (chrome ? '10%' : '8%');
  const imgBottom = variant === 'tarot' ? '18%' : (chrome ? '20%' : '8%');

  return (
    <div
      style={{
        width: W,
        height: H,
        position: 'relative',
        display: 'inline-block',
        flexShrink: 0,
      }}
    >
      {/* OUTER colored shield — the visible primary border */}
      <div style={{
        position: 'absolute',
        inset: 0,
        clipPath: clip,
        background: hex,
      }} />

      {/* Frame glow — only when winning/victory */}
      {(isWinning || isVictory) && (
        <div style={{
          position: 'absolute',
          inset: -6,
          clipPath: clip,
          background: hex,
          filter: `blur(${isVictory ? 18 : 10}px)`,
          opacity: 0.55,
          pointerEvents: 'none',
        }} />
      )}

      {/* Inner stage — inset to reveal the outer color as a border ring */}
      <div style={{
        position: 'absolute',
        inset: outerBorder,
        clipPath: clip,
        background: [
          `radial-gradient(circle at 50% 40%, ${hex}55, transparent 65%)`,
          `linear-gradient(180deg, ${hex}28 0%, ${hex}10 55%, rgba(0,0,0,0.35) 100%)`,
          `repeating-linear-gradient(45deg, ${hex}22 0px, ${hex}22 1px, transparent 1px, transparent 9px)`,
          'var(--bg-stage)',
        ].join(', '),
        opacity: isLosing ? 0.7 : 1,
      }} />

      {/* Avatar image */}
      <div style={{
        position: 'absolute',
        left: '8%',
        right: '8%',
        top: imgTop,
        bottom: imgBottom,
        clipPath: clip,
      }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl}
          alt={name}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            filter: avatarFilter,
          }}
          draggable={false}
        />
      </div>

      {/* Scanlines — hidden at tiny sizes */}
      {showScanlines && (
        <div style={{
          position: 'absolute',
          inset: 0,
          clipPath: clip,
          background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)',
          pointerEvents: 'none',
          opacity: 0.5,
        }} />
      )}

      {/* Rank chip — only when chrome enabled */}
      {chrome && (
        <div style={{
          position: 'absolute',
          left: variant === 'tarot' ? '12%' : '9%',
          top: variant === 'tarot' ? '7%' : '9%',
          width: rankChipW,
          height: rankChipH,
          background: hex,
          color: '#0a0612',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Pixelify Sans',
          fontWeight: 700,
          fontSize: rankFontSize,
          opacity: isLosing ? 0.65 : 1,
        }}>{rank}</div>
      )}

      {/* Bottom name banner — only when chrome enabled */}
      {chrome && (
        <div style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: variant === 'tarot' ? '8%' : '9%',
          background: 'var(--bg-deep)',
          border: `1px solid ${hex}`,
          padding: `${bannerPad}px ${bannerPad * 3}px`,
          fontFamily: 'JetBrains Mono',
          fontWeight: 700,
          fontSize: bannerFontSize,
          letterSpacing: '0.16em',
          color: hex,
          whiteSpace: 'nowrap',
          opacity: isLosing ? 0.7 : 1,
        }}>
          {initials}{tier ? ` · ${tier}` : ''}
        </div>
      )}

      {/* Thinking dots */}
      {isThinking && (
        <div style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: '20%',
          display: 'flex',
          gap: 6,
          pointerEvents: 'none',
        }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: hex,
              animation: `pulse 1.2s ease-in-out infinite ${i * 0.3}s`,
            }} />
          ))}
        </div>
      )}

      {/* Victory stars */}
      {isVictory && (
        <div style={{
          position: 'absolute',
          top: 4,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'space-around',
          pointerEvents: 'none',
        }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} style={{ fontFamily: 'Pixelify Sans', fontSize: 20, color: 'var(--gold)' }}>★</span>
          ))}
        </div>
      )}

      {/* Inner accent ring — second concentric band */}
      <div style={{
        position: 'absolute',
        inset: innerBorderInset,
        clipPath: clip,
        boxShadow: `inset 0 0 0 1px ${hex}`,
        opacity: 0.9,
        pointerEvents: 'none',
      }} />
    </div>
  );
};

// Back-compat aliases
export const ShieldPortrait: React.FC<{ fighter: string | Partial<Fighter>; state?: AvatarProps['state']; size?: number; styleName?: AvatarProps['variant'] }> = ({ fighter, state, size, styleName }) => (
  <Avatar fighter={fighter} state={state} size={size} variant={styleName} />
);

export const MiniPortrait: React.FC<{ id: string; size?: number }> = ({ id, size }) => (
  <Avatar fighter={id} variant="shield" size={size} showChrome={false} />
);
