'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';

interface AnimatedNumberProps {
  value: number;
  duration?: number; // duration in ms
  formatter?: (val: number) => string;
  className?: string;
  prefix?: string;
  suffix?: string;
}

export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  duration = 600,
  formatter = (v) => v.toFixed(2),
  className = '',
  prefix = '',
  suffix = '',
}) => {
  const [displayValue, setDisplayValue] = useState<number>(value);
  const startValueRef = useRef<number>(value);
  const endValueRef = useRef<number>(value);
  const startTimeRef = useRef<number>(0);
  const still = useReducedMotion();

  useEffect(() => {
    // Asked for less motion: show the figure, don't roll to it. A PnL counting
    // itself up is decoration; the number is the information.
    if (still) {
      setDisplayValue(value);
      return;
    }
    startValueRef.current = displayValue;
    endValueRef.current = value;
    startTimeRef.current = performance.now();

    let animationFrameId: number;

    const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);

    const updateNumber = (now: number) => {
      const elapsed = now - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeOutCubic(progress);
      const nextVal = startValueRef.current + (endValueRef.current - startValueRef.current) * easedProgress;
      setDisplayValue(nextVal);
      if (progress < 1) {
        animationFrameId = requestAnimationFrame(updateNumber);
      } else {
        setDisplayValue(endValueRef.current);
      }
    };

    animationFrameId = requestAnimationFrame(updateNumber);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [value, duration, still]);

  return (
    <span className={`t-num ${className}`}>
      {prefix}{formatter(displayValue)}{suffix}
    </span>
  );
};
