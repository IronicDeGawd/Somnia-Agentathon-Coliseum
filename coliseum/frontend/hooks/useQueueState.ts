'use client';

import { useCallback, useEffect } from 'react';
import { useReadContracts } from 'wagmi';
import { zeroAddress, parseAbiItem, type Address } from 'viem';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';
import { config } from '@/lib/chain';
import { getWsClient } from '@/lib/wsClient';

const MATCHMAKER_ADDRESS = CONTRACT_ADDRESSES.Matchmaker as Address;

// Queue lifecycle events streamed over the dedicated WebSocket (eth_subscribe).
// wagmi's useWatchContractEvent is silent here because the app's HTTP transport
// can't subscribe — so the queue board only refreshed on manual reload.
const QUEUED_EVENT = parseAbiItem(
  'event Queued(address indexed player, uint8 indexed fighter, uint16 turns, uint256 deposit)',
);
const QUEUE_CANCELLED_EVENT = parseAbiItem(
  'event QueueCancelled(address indexed player, uint16 turns, uint256 refund)',
);
const MATCH_STARTED_EVENT = parseAbiItem(
  'event MatchStarted(uint256 indexed duelId, address indexed playerA, address indexed playerB, uint8 fighterA, uint8 fighterB, uint16 turns)',
);

export type QueueTier = 3 | 6 | 9 | 15;

export interface QueueSlot {
  player: string;
  fighter: number;
  deposit: bigint;
}

export interface PendingMatch {
  playerA: string;
  playerB: string;
  fighterA: number;
  fighterB: number;
  turns: number;
  totalPot: bigint;
  exists: boolean;
}

export interface QueueState {
  slots: Record<QueueTier, QueueSlot | null>;
  pendingMatch: PendingMatch | null;
  isLoading: boolean;
  refetch: () => void;
}

const TIERS: QueueTier[] = [3, 6, 9, 15];

export function useQueueState(): QueueState {
  const contracts = [
    // getSlot for each tier — indices 0-3
    ...TIERS.map((turns) => ({
      address: MATCHMAKER_ADDRESS,
      abi: ABIS.Matchmaker,
      functionName: 'getSlot' as const,
      args: [turns] as [number],
    })),
    // pending() — index 4
    {
      address: MATCHMAKER_ADDRESS,
      abi: ABIS.Matchmaker,
      functionName: 'pending' as const,
      args: [] as [],
    },
  ];

  const { data, isLoading, refetch: wagmiRefetch } = useReadContracts({
    contracts,
    config,
  });

  const refetch = useCallback(() => {
    wagmiRefetch();
  }, [wagmiRefetch]);

  // Stream all three queue events over the WS client and refetch on any of them.
  useEffect(() => {
    const client = getWsClient();
    if (!client) return;
    const unwatchers: (() => void)[] = [];
    try {
      for (const event of [QUEUED_EVENT, QUEUE_CANCELLED_EVENT, MATCH_STARTED_EVENT]) {
        unwatchers.push(
          client.watchEvent({
            address: MATCHMAKER_ADDRESS,
            event,
            onLogs: () => refetch(),
            onError: () => {},
          }),
        );
      }
    } catch {
      // WS unavailable — manual refetch / reload still works.
    }
    return () => {
      for (const u of unwatchers) { try { u(); } catch { /* already torn down */ } }
    };
  }, [refetch]);

  // Parse slot results (indices 0-3)
  const slots = {} as Record<QueueTier, QueueSlot | null>;
  TIERS.forEach((tier, i) => {
    const result = data?.[i];
    if (result?.status === 'success' && result.result) {
      const [player, fighter, deposit] = result.result as [Address, bigint | number, bigint];
      slots[tier] = player === zeroAddress
        ? null
        : { player, fighter: Number(fighter), deposit };
    } else {
      slots[tier] = null;
    }
  });

  // Parse pending() result (index 4)
  // ABI: returns (address playerA, address playerB, uint8 fighterA, uint8 fighterB, uint16 turns, uint256 totalPot, bool exists)
  let pendingMatch: PendingMatch | null = null;
  const pendingResult = data?.[4];
  if (pendingResult?.status === 'success' && pendingResult.result) {
    const [playerA, playerB, fighterA, fighterB, turns, totalPot, exists] =
      pendingResult.result as [Address, Address, bigint | number, bigint | number, bigint | number, bigint, boolean];
    pendingMatch = {
      playerA,
      playerB,
      fighterA: Number(fighterA),
      fighterB: Number(fighterB),
      turns: Number(turns),
      totalPot,
      exists,
    };
  }

  return { slots, pendingMatch, isLoading, refetch };
}
