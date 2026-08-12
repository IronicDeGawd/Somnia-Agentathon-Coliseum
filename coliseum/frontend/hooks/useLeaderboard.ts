'use client';

import { useReadContract } from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES, DUEL_HISTORY_DEPLOYED } from '@/lib/contracts';
import { useFighters } from '@/hooks/useFighters';
import { useContractSubscription } from '@/hooks/useContractSubscription';

export interface LeaderboardRow {
  index: number;
  name: string;
  hex: string;
  wins: number;
  losses: number;
  draws: number;
  duels: number;
  pnl: bigint;
}

type RawRecord = {
  wins: number;
  losses: number;
  draws: number;
  duels: number;
  cumulativePnl: bigint;
};

export function useLeaderboard(): {
  rows: LeaderboardRow[];
  isEmpty: boolean;
  isLoading: boolean;
} {
  const { fighters, isLoading: fightersLoading } = useFighters();

  const { data: rawRows, isLoading: contractLoading, refetch } = useReadContract({
    address: CONTRACT_ADDRESSES.DuelHistory,
    abi: ABIS.DuelHistory,
    functionName: 'leaderboard',
    query: { enabled: DUEL_HISTORY_DEPLOYED },
  });

  // Standings only change when a duel resolves, so refetch on that rather than
  // polling. Without this the board is stale from mount until a navigation.
  useContractSubscription({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'DuelResolved',
    enabled: DUEL_HISTORY_DEPLOYED,
    onLogs: () => { void refetch(); },
  });

  if (!DUEL_HISTORY_DEPLOYED) {
    return { rows: [], isEmpty: true, isLoading: false };
  }

  const isLoading = fightersLoading || contractLoading;

  if (!rawRows || !fighters.length) {
    // While the registry/leaderboard reads are still resolving, report not-empty
    // so the consumer doesn't flash the "no duels yet" banner mid-load.
    return { rows: [], isEmpty: !isLoading, isLoading };
  }

  const rows: LeaderboardRow[] = (rawRows as unknown as RawRecord[]).map((rec, i) => {
    const fighter = fighters.find((f) => f.index === i);
    return {
      index: i,
      name: fighter?.name ?? `FIGHTER #${i}`,
      hex: fighter?.hex ?? '#ffffff',
      wins: Number(rec.wins),
      losses: Number(rec.losses),
      draws: Number(rec.draws),
      duels: Number(rec.duels),
      pnl: BigInt(rec.cumulativePnl),
    };
  });

  rows.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const bPnl = b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0;
    return bPnl;
  });

  const isEmpty = rows.every((r) => r.duels === 0);

  return { rows, isEmpty, isLoading };
}
