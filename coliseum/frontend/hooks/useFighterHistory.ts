'use client';

import { useReadContracts } from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES, DUEL_HISTORY_DEPLOYED } from '@/lib/contracts';

export interface HistoryEntry {
  duelId: bigint;
  fighterA: number;
  fighterB: number;
  winnerSlot: number;
  winnerFighter: number;
  valueA: bigint;
  valueB: bigint;
  pnlA: bigint;
  pnlB: bigint;
  blockNumber: bigint;
}

export interface FighterRecord {
  wins: number;
  losses: number;
  duels: number;
  pnl: bigint;
}

type RawRecord = {
  wins: number;
  losses: number;
  duels: number;
  cumulativePnl: bigint;
};

type RawEntry = {
  duelId: bigint;
  fighterA: number;
  fighterB: number;
  winnerSlot: number;
  winnerFighter: number;
  valueA: bigint;
  valueB: bigint;
  pnlA: bigint;
  pnlB: bigint;
  blockNumber: bigint;
};

export function useFighterHistory(index: number): {
  record: FighterRecord | null;
  entries: HistoryEntry[];
  isEmpty: boolean;
  isLoading: boolean;
} {
  const { data, isLoading } = useReadContracts({
    contracts: [
      {
        address: CONTRACT_ADDRESSES.DuelHistory,
        abi: ABIS.DuelHistory,
        functionName: 'getFighterRecord',
        args: [index],
      },
      {
        address: CONTRACT_ADDRESSES.DuelHistory,
        abi: ABIS.DuelHistory,
        functionName: 'getFighterEntries',
        args: [index, BigInt(0), BigInt(20)],
      },
    ],
    query: { enabled: DUEL_HISTORY_DEPLOYED },
  });

  if (!DUEL_HISTORY_DEPLOYED) {
    return { record: null, entries: [], isEmpty: true, isLoading: false };
  }

  if (!data) {
    return { record: null, entries: [], isEmpty: true, isLoading };
  }

  const recordResult = data[0];
  const entriesResult = data[1];

  let record: FighterRecord | null = null;
  if (recordResult?.status === 'success' && recordResult.result) {
    const raw = recordResult.result as unknown as RawRecord;
    record = {
      wins: Number(raw.wins),
      losses: Number(raw.losses),
      duels: Number(raw.duels),
      pnl: BigInt(raw.cumulativePnl),
    };
  }

  let entries: HistoryEntry[] = [];
  if (entriesResult?.status === 'success' && Array.isArray(entriesResult.result)) {
    entries = (entriesResult.result as unknown as RawEntry[]).map((e) => ({
      duelId: BigInt(e.duelId),
      fighterA: Number(e.fighterA),
      fighterB: Number(e.fighterB),
      winnerSlot: Number(e.winnerSlot),
      winnerFighter: Number(e.winnerFighter),
      valueA: BigInt(e.valueA),
      valueB: BigInt(e.valueB),
      pnlA: BigInt(e.pnlA),
      pnlB: BigInt(e.pnlB),
      blockNumber: BigInt(e.blockNumber),
    }));
  }

  const isEmpty = record === null || record.duels === 0;

  return { record, entries, isEmpty, isLoading };
}
