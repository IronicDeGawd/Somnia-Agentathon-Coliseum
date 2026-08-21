'use client';

import { useEffect, useState } from 'react';

/**
 * Whether the viewer has asked their system for less motion.
 *
 * WHY THIS EXISTS AT ALL, given the design layer already has a
 * `prefers-reduced-motion` block. That block can only reach CSS animations and
 * transitions. Several of this app's most active pieces of motion are driven by
 * JavaScript instead — the thinking ticker's phrase cycling, the typewriter that
 * reveals an agent's reasoning a character at a time, the counters that roll a
 * PnL figure to its new value. A media query cannot touch a `setInterval` or a
 * `requestAnimationFrame` loop, so every one of them kept running for a viewer
 * who had explicitly asked them not to.
 *
 * Returns false during server render and the first client paint, then settles to
 * the real answer. That ordering is deliberate: the alternative is guessing
 * "reduced" on the server and having motion snap on afterwards, which is itself
 * a jolt.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(q.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    // addEventListener over the deprecated addListener, with no fallback: every
    // browser that ships the CSS media query also ships this.
    q.addEventListener('change', onChange);
    return () => q.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
