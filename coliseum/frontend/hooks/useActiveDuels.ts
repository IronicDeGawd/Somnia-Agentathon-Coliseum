'use client';

import { useCallback, useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { CONTRACT_ADDRESSES, ABIS, DuelData } from '@/lib/contracts';
import { config } from '@/lib/chain';
import { useContractSubscription } from '@/hooks/useContractSubscription';

export interface LiveDuel {
  duelId: bigint;
  duel: DuelData;
}

export interface UseActiveDuelsResult {
  /** Every duel currently running, in the arena's own order. */
  duels: LiveDuel[];
  /** True while the arena can start another duel. */
  hasCapacity: boolean;
  /** How many duels may run at once. */
  maxActiveDuels: number;
  isLoading: boolean;
  /** Set when the lobby could not read the arena at all. */
  error: Error | null;
  refetch: () => void;
}

// duels() tuple indices: 0 fighterA, 1 fighterB, 2 creator, 3 startBlock,
// 4 lastTurnBlock, 5 completedCallbacks, 6 turns, 7 poolMask, 8 status,
// 9 initialUsdsoPerFighter, 10 fundsRecovered, 11 winnerSlot, 12 simulated
type DuelTuple = readonly [
  number, number, `0x${string}`, bigint, bigint, number, number,
  number, number, bigint, boolean, number, boolean,
];

function toDuelData(raw: DuelTuple): DuelData {
  return {
    fighterA: raw[0],
    fighterB: raw[1],
    creator: raw[2],
    startBlock: raw[3],
    lastTurnBlock: raw[4],
    completedCallbacks: raw[5],
    turns: raw[6],
    poolMask: raw[7],
    status: raw[8],
    initialUsdsoPerFighter: raw[9],
    fundsRecovered: raw[10],
    winnerSlot: raw[11],
    simulated: Boolean(raw[12]),
  };
}

// Polling settings shared by every read here. refetchIntervalInBackground
// matters: React Query pauses polling on blur by default, which is exactly when
// a spectator looks away mid-duel and comes back to a stale lobby.
const POLL = { refetchInterval: 10_000, refetchIntervalInBackground: true } as const;

/**
 * Every duel the arena is currently running.
 *
 * The arena used to hold one duel at a time, so the lobby read a single
 * activeDuelId. It now runs several, and that view only ever returns the first
 * of them — so a second live fight would be invisible here.
 */
export function useActiveDuels(): UseActiveDuelsResult {
  const {
    data: rawIds,
    isLoading: isLoadingIds,
    error: idsError,
    refetch: refetchIds,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'getActiveDuelIds',
    query: POLL,
    config,
  });

  const { data: capacity, refetch: refetchCapacity } = useReadContracts({
    contracts: [
      { address: CONTRACT_ADDRESSES.Arena, abi: ABIS.Arena, functionName: 'hasCapacity' },
      { address: CONTRACT_ADDRESSES.Arena, abi: ABIS.Arena, functionName: 'maxActiveDuels' },
    ],
    query: POLL,
    config,
  });

  const ids = useMemo(() => (rawIds as readonly bigint[] | undefined) ?? [], [rawIds]);

  const {
    data: rawDuels,
    isLoading: isLoadingDuels,
    refetch: refetchDuels,
  } = useReadContracts({
    contracts: ids.map((id) => ({
      address: CONTRACT_ADDRESSES.Arena,
      abi: ABIS.Arena,
      functionName: 'duels' as const,
      args: [id] as const,
    })),
    query: { ...POLL, enabled: ids.length > 0 },
    config,
  });

  const duels = useMemo<LiveDuel[]>(() => {
    if (!rawDuels) return [];
    const out: LiveDuel[] = [];
    ids.forEach((duelId, i) => {
      const r = rawDuels[i];
      if (r?.status !== 'success' || r.result === undefined) return;
      out.push({ duelId, duel: toDuelData(r.result as unknown as DuelTuple) });
    });
    return out;
  }, [ids, rawDuels]);

  const refetch = useCallback(() => {
    refetchIds();
    refetchCapacity();
    if (ids.length > 0) refetchDuels();
  }, [refetchIds, refetchCapacity, refetchDuels, ids.length]);

  // No duelId filter here by design: the point is to notice a duel this hook
  // does not know about yet.
  useContractSubscription({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'DuelStarted',
    onLogs: () => refetch(),
  });

  useContractSubscription({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'DuelResolved',
    onLogs: () => refetch(),
  });

  const hasCapacityResult = capacity?.[0];
  const maxActiveResult = capacity?.[1];

  return {
    duels,
    // Assume there is room until told otherwise, so the queue CTA is not
    // disabled by a read that has not landed yet.
    hasCapacity:
      hasCapacityResult?.status === 'success' ? Boolean(hasCapacityResult.result) : true,
    maxActiveDuels:
      maxActiveResult?.status === 'success' ? Number(maxActiveResult.result) : 0,
    isLoading: isLoadingIds || (ids.length > 0 && isLoadingDuels),
    error: (idsError as Error | null) ?? null,
    refetch,
  };
}
