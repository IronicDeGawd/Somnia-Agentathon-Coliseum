'use client';

import { useReadContracts } from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES, DUEL_HISTORY_DEPLOYED } from '@/lib/contracts';

export interface LedgerEntry {
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

export function useDuelLedger(limit = 20): {
  entries: LedgerEntry[];
  total: bigint;
  isEmpty: boolean;
  isLoading: boolean;
} {
  const { data, isLoading } = useReadContracts({
    contracts: [
      {
        address: CONTRACT_ADDRESSES.DuelHistory,
        abi: ABIS.DuelHistory,
        functionName: 'totalDuels',
      },
      {
        address: CONTRACT_ADDRESSES.DuelHistory,
        abi: ABIS.DuelHistory,
        functionName: 'getEntries',
        args: [BigInt(0), BigInt(limit)],
      },
    ],
    query: { enabled: DUEL_HISTORY_DEPLOYED },
  });

  if (!DUEL_HISTORY_DEPLOYED) {
    return { entries: [], total: BigInt(0), isEmpty: true, isLoading: false };
  }

  if (!data) {
    return { entries: [], total: BigInt(0), isEmpty: true, isLoading };
  }

  const totalResult = data[0];
  const entriesResult = data[1];

  const total =
    totalResult?.status === 'success' && totalResult.result !== undefined
      ? BigInt(totalResult.result as bigint)
      : BigInt(0);

  let entries: LedgerEntry[] = [];
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

  const isEmpty = total === BigInt(0);

  return { entries, total, isEmpty, isLoading };
}
