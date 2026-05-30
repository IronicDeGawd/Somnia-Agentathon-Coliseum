'use client';

import React, { useEffect, useState, useRef } from 'react';

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

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    setN(0);
    if (!text) {
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
  }, [text, speed]);

  const done = n >= (text?.length ?? 0);

  return (
    <span className={className}>
      {(text || '').slice(0, n)}
      {showCursor && !done && <span className="cursor-blink" />}
    </span>
  );
};
