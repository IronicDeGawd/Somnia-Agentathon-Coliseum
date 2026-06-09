'use client';

import { useCallback } from 'react';
import { useReadContract, useWatchContractEvent } from 'wagmi';
import { CONTRACT_ADDRESSES, ABIS, DuelData } from '@/lib/contracts';
import { config } from '@/lib/chain';

export interface UseActiveDuelResult {
  activeDuelId: bigint | null;
  duel: DuelData | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useActiveDuel(): UseActiveDuelResult {
  // ── Step 1: read the active duel id ──────────────────────────────────────
  const {
    data: rawActiveDuelId,
    isLoading: isLoadingId,
    refetch: refetchId,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'activeDuelId',
    config,
  });

  // A duel id of 0n means no active duel.
  const activeDuelId: bigint | null =
    rawActiveDuelId !== undefined && rawActiveDuelId > BigInt(0) ? rawActiveDuelId : null;

  // ── Step 2: read duel details when there is an active id ─────────────────
  const {
    data: rawDuel,
    isLoading: isLoadingDuel,
    refetch: refetchDuel,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'duels',
    args: activeDuelId !== null ? [activeDuelId] : undefined,
    query: {
      enabled: activeDuelId !== null,
    },
    config,
  });

  // Map the tuple to a named DuelData object.
  // duels() tuple indices: 0 fighterA, 1 fighterB, 2 creator, 3 startBlock,
  // 4 lastTurnBlock, 5 completedCallbacks, 6 turns, 7 poolMask, 8 status,
  // 9 initialUsdsoPerFighter, 10 fundsRecovered, 11 winnerSlot, 12 simulated
  let duel: DuelData | null = null;
  if (rawDuel !== undefined && activeDuelId !== null) {
    const [
      fighterA,
      fighterB,
      creator,
      startBlock,
      lastTurnBlock,
      completedCallbacks,
      turns,
      poolMask,
      status,
      initialUsdsoPerFighter,
      fundsRecovered,
      winnerSlot,
      simulated,
    ] = rawDuel as [
      number,
      number,
      `0x${string}`,
      bigint,
      bigint,
      number,
      number,
      number,
      number,
      bigint,
      boolean,
      number,
      boolean,
    ];
    duel = {
      fighterA,
      fighterB,
      creator,
      startBlock,
      lastTurnBlock,
      completedCallbacks,
      turns,
      poolMask,
      status,
      initialUsdsoPerFighter,
      fundsRecovered,
      winnerSlot,
      simulated: Boolean(simulated),
    };
  }

  // ── Step 3: combined refetch ──────────────────────────────────────────────
  const refetch = useCallback(() => {
    refetchId();
    if (activeDuelId !== null) refetchDuel();
  }, [refetchId, refetchDuel, activeDuelId]);

  // ── Step 4: watch events and refetch ─────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'DuelStarted',
    config,
    onLogs: () => refetch(),
  });

  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'DuelResolved',
    config,
    onLogs: () => refetch(),
  });

  return {
    activeDuelId,
    duel,
    isLoading: isLoadingId || (activeDuelId !== null && isLoadingDuel),
    refetch,
  };
}
