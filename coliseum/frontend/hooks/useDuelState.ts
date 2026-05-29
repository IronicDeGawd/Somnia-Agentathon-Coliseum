'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useReadContract, useWatchContractEvent } from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES } from '@/lib/contracts';

// DuelStatus enum mirrors ArenaTypes.DuelStatus { None=0, Active=1, Finalizing=2, Resolved=3 }
const DUEL_STATUS_ACTIVE   = 1;
const DUEL_STATUS_RESOLVED = 3;

export interface DuelData {
  creator: `0x${string}`;
  turns: number;
  poolMask: number;
  currentTurn: number;
  status: number;
  winnerSlot: number;
  quoteBalanceA: bigint;
  quoteBalanceB: bigint;
}

export interface UseDuelStateResult {
  duel: DuelData | null;
  odds: { degenBps: number; whaleBps: number } | null;
  totalBetsA: bigint;
  totalBetsB: bigint;
  currentTurn: number;
  isActive: boolean;
  isResolved: boolean;
  winnerSlot: number | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useDuelState(duelId: bigint): UseDuelStateResult {
  const enabled = duelId > BigInt(0);  // eslint-disable-line @typescript-eslint/no-unnecessary-condition

  // ── Arena.duels(duelId) — polled every 10s ────────────────────────────────
  const {
    data: duelRaw,
    isLoading: duelLoading,
    refetch: refetchDuel,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'duels',
    args: [duelId],
    query: {
      enabled,
      refetchInterval: 10_000,
    },
  });

  // ── Bookmaker.currentOdds(duelId, index) — polled every 10s ─────────────────
  // The mapping is uint256 => uint16[2], exposed as currentOdds(duelId, index).
  // We read index 0 (fighterA) and index 1 (fighterB) separately.
  const {
    data: oddsARaw,
    refetch: refetchOddsA,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    functionName: 'currentOdds',
    args: [duelId, BigInt(0)],
    query: {
      enabled,
      refetchInterval: 10_000,
    },
  });

  const {
    data: oddsBRaw,
    refetch: refetchOddsB,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    functionName: 'currentOdds',
    args: [duelId, BigInt(1)],
    query: {
      enabled,
      refetchInterval: 10_000,
    },
  });

  // ── BetPlaced event accumulation for totalBetsA / totalBetsB ─────────────
  // Bookmaker has no totalBetsA/totalBetsB view; we tally from BetPlaced events.
  const [totalBetsA, setTotalBetsA] = useState<bigint>(BigInt(0));
  const [totalBetsB, setTotalBetsB] = useState<bigint>(BigInt(0));
  // Track whether we've seen at least one event (avoids premature 0 display).
  const betsInitialized = useRef(false);

  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    eventName: 'BetPlaced',
    onLogs(logs) {
      for (const log of logs) {
        const args = log.args as {
          duelId?: bigint;
          bettor?: `0x${string}`;
          slot?: number;
          amount?: bigint;
        };
        if (args.duelId !== duelId) continue;
        const amount = args.amount ?? BigInt(0);
        if (args.slot === 0) {
          setTotalBetsA((prev) => prev + amount);
        } else if (args.slot === 1) {
          setTotalBetsB((prev) => prev + amount);
        }
        betsInitialized.current = true;
      }
    },
    enabled,
  });

  // Reset bet totals whenever duelId changes.
  useEffect(() => {
    setTotalBetsA(BigInt(0));
    setTotalBetsB(BigInt(0));
    betsInitialized.current = false;
  }, [duelId]);

  // ── TurnAdvanced → refetch duel state ─────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'TurnAdvanced',
    onLogs(logs) {
      for (const log of logs) {
        const args = log.args as { duelId?: bigint };
        if (args.duelId === duelId) {
          refetchDuel();
        }
      }
    },
    enabled,
  });

  // ── OddsUpdated → refetch odds ────────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    eventName: 'OddsUpdated',
    onLogs(logs) {
      for (const log of logs) {
        const args = log.args as { duelId?: bigint };
        if (args.duelId === duelId) {
          refetchOddsA();
          refetchOddsB();
        }
      }
    },
    enabled,
  });

  // ── Derived values ─────────────────────────────────────────────────────────
  // ABI tuple: (fighterA, fighterB, creator, startBlock, lastTurnBlock,
  //             completedCallbacks, turns, poolMask, status,
  //             initialUsdsoPerFighter, lastAction, fundsRecovered, winnerSlot)
  const duel: DuelData | null = duelRaw
    ? {
        creator:       duelRaw[2] as unknown as `0x${string}`,
        turns:         Number(duelRaw[6]),
        poolMask:      Number(duelRaw[7]),
        currentTurn:   Number(duelRaw[5]),   // completedCallbacks
        status:        Number(duelRaw[8]),
        winnerSlot:    Number(duelRaw[12]),
        quoteBalanceA: duelRaw[9] as unknown as bigint,   // initialUsdsoPerFighter as proxy
        quoteBalanceB: duelRaw[9] as unknown as bigint,   // same; no live balance in this ABI
      }
    : null;

  // Combine the two separate currentOdds reads into one odds object.
  const odds = oddsARaw !== undefined && oddsBRaw !== undefined
    ? {
        degenBps: Number(oddsARaw),
        whaleBps: Number(oddsBRaw),
      }
    : null;

  const currentTurn  = duel?.currentTurn ?? 0;
  const status       = duel?.status ?? 0;
  const isActive     = status === DUEL_STATUS_ACTIVE;
  const isResolved   = status === DUEL_STATUS_RESOLVED;
  const winnerSlot   = isResolved && duel ? duel.winnerSlot : null;

  const refetch = useCallback(() => {
    refetchDuel();
    refetchOddsA();
    refetchOddsB();
  }, [refetchDuel, refetchOddsA, refetchOddsB]);

  return {
    duel,
    odds,
    totalBetsA,
    totalBetsB,
    currentTurn,
    isActive,
    isResolved,
    winnerSlot,
    isLoading: duelLoading,
    refetch,
  };
}
