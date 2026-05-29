'use client';

import React, { useEffect, useState, useRef } from 'react';

interface TypewriterProps {
  text: string;
  speed?: number; // characters per second
  onDone?: () => void;
  className?: string;
}

export const Typewriter: React.FC<TypewriterProps> = ({
  text,
  speed = 40,
  onDone,
  className = '',
}) => {
  const [displayText, setDisplayText] = useState<string>('');
  const textRef = useRef<string>(text);
  const onDoneRef = useRef<(() => void) | undefined>(onDone);

  // Sync refs to avoid re-triggering effects on callback shifts
  useEffect(() => {
    textRef.current = text;
    onDoneRef.current = onDone;
  }, [text, onDone]);

  useEffect(() => {
    setDisplayText('');
    const target = textRef.current;
    if (!target) {
      if (onDoneRef.current) onDoneRef.current();
      return;
    }

    const intervalMs = 1000 / speed;
    let startTime = performance.now();
    let index = 0;
    let animationFrameId: number;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const count = Math.floor(elapsed / intervalMs);
      
      if (count > index) {
        index = Math.min(count, target.length);
        setDisplayText(target.slice(0, index));
      }

      if (index < target.length) {
        animationFrameId = requestAnimationFrame(tick);
      } else {
        if (onDoneRef.current) {
          onDoneRef.current();
        }
      }
    };

    animationFrameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [text, speed]);

  return (
    <span className={`${className} cursor-blink inline-block`}>
      {displayText}
    </span>
  );
};
