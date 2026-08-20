'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';

interface TypewriterProps {
  text: string;
  speed?: number; // characters per second
  onDone?: () => void;
  className?: string;
  showCursor?: boolean;
}

export const Typewriter: React.FC<TypewriterProps> = ({
  text,
  speed = 28,
  onDone,
  className = '',
  showCursor = true,
}) => {
  const [n, setN] = useState(0);
  const onDoneRef = useRef<(() => void) | undefined>(onDone);
  const still = useReducedMotion();

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    setN(0);
    if (!text) {
      if (onDoneRef.current) onDoneRef.current();
      return;
    }
    // Asked for less motion: hand over the whole line at once. Text that
    // rewrites itself is the single most common complaint behind that setting,
    // and the reasoning it reveals is worth reading either way.
    if (still) {
      setN(text.length);
      if (onDoneRef.current) onDoneRef.current();
      return;
    }
    const start = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const elapsed = now - start;
      const next = Math.min(text.length, Math.floor(elapsed / (1000 / speed)));
      setN(next);
      if (next < text.length) {
        raf = requestAnimationFrame(tick);
      } else if (onDoneRef.current) {
        onDoneRef.current();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, speed, still]);

  const done = n >= (text?.length ?? 0);

  return (
    <span className={className}>
      {(text || '').slice(0, n)}
      {showCursor && !done && <span className="cursor-blink" />}
    </span>
  );
};
