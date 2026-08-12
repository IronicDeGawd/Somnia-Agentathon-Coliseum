'use client';

import { DuelData } from '@/lib/contracts';
import { useActiveDuels } from '@/hooks/useActiveDuels';

export interface UseActiveDuelResult {
  activeDuelId: bigint | null;
  duel: DuelData | null;
  isLoading: boolean;
  /** Set when the lobby could not read the arena at all. */
  error: Error | null;
  refetch: () => void;
}

/**
 * The headline duel — the first one the arena is running.
 *
 * A convenience wrapper over {@link useActiveDuels} for places that show one
 * fight, like the homepage hero. Anywhere that should show ALL live fights
 * (the lobby) must use useActiveDuels instead, or the second and third duels
 * are simply invisible.
 */
export function useActiveDuel(): UseActiveDuelResult {
  const { duels, isLoading, error, refetch } = useActiveDuels();
  const first = duels[0];
  return {
    activeDuelId: first?.duelId ?? null,
    duel: first?.duel ?? null,
    isLoading,
    error,
    refetch,
  };
}
