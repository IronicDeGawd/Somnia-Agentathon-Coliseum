'use client';

import React from 'react';
import { Avatar, AvatarProps } from './Avatar';

// Contexts where a FighterAvatar can appear. Each context picks the visual
// variant + sensible defaults so callers never guess. The design uses
// `shield` (DiceBear bottts) everywhere on landing/lobby/arena — helm and
// tarot exist for special-case ceremonial use only.
export type AvatarContext =
  | 'hero'        // Landing/Lobby oversized bleeding portraits
  | 'card'        // Tale-of-the-tape, tonight's card, fighter-profile hero
  | 'roster'      // Roster strip
  | 'arena'       // Live arena fighter HUD
  | 'mini'        // Tables, bet history rows (≤32px, no chrome)
  | 'inline';     // Anything smaller, e.g. comparison strips

interface FighterAvatarProps {
  fighter: AvatarProps['fighter'];
  context?: AvatarContext;
  size?: number;
  state?: AvatarProps['state'];
  /** Hero-only: bleed off the left/right edge with rotation + low opacity. */
  bleed?: 'left' | 'right';
  /** Override the auto-chrome rule from base Avatar. */
  chrome?: boolean;
  className?: string;
}

interface ContextDefaults {
  variant: AvatarProps['variant'];
  size: number;
  chrome: boolean | null;
}

const CONTEXT_DEFAULTS: Record<AvatarContext, ContextDefaults> = {
  hero:   { variant: 'shield', size: 480, chrome: false },
  card:   { variant: 'shield', size: 140, chrome: null },
  roster: { variant: 'shield', size: 72,  chrome: null },
  arena:  { variant: 'shield', size: 80,  chrome: null },
  mini:   { variant: 'shield', size: 28,  chrome: false },
  inline: { variant: 'shield', size: 48,  chrome: false },
};

const BLEED_STYLES: Record<'left' | 'right', React.CSSProperties> = {
  left:  { position: 'absolute', left: -60,  top: 80, opacity: 0.32, transform: 'rotate(-3deg)', filter: 'blur(0.3px)', pointerEvents: 'none' },
  right: { position: 'absolute', right: -60, top: 80, opacity: 0.32, transform: 'rotate(3deg)',  filter: 'blur(0.3px)', pointerEvents: 'none' },
};

export const FighterAvatar: React.FC<FighterAvatarProps> = ({
  fighter,
  context = 'card',
  size,
  state = 'idle',
  bleed,
  chrome,
  className,
}) => {
  const defaults = CONTEXT_DEFAULTS[context];
  const resolvedSize = size ?? defaults.size;
  const resolvedChrome = chrome !== undefined ? chrome : defaults.chrome;

  const node = (
    <Avatar
      fighter={fighter}
      size={resolvedSize}
      state={state}
      variant={defaults.variant}
      showChrome={resolvedChrome}
    />
  );

  if (bleed) {
    return (
      <div
        className={`hidden md:block ${className ?? ''}`}
        style={BLEED_STYLES[bleed]}
      >
        {node}
      </div>
    );
  }

  if (className) {
    return <div className={className}>{node}</div>;
  }

  return node;
};
