'use client';

import { useCallback, useEffect } from 'react';
import { useReadContracts } from 'wagmi';
import { zeroAddress, parseAbiItem, type Address } from 'viem';
import { CONTRACT_ADDRESSES, ABIS, LOBBY_MENU, MarketKind } from '@/lib/contracts';
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

/**
 * A waiting line is identified by round count AND market, not by round count
 * alone. Two players only match if both chose the same pair, so a nine-round
 * spot player and a nine-round events player wait in different lines.
 */
export function queueKey(turns: number, market: MarketKind): string {
  return `${turns}:${market}`;
}

export interface QueueState {
  /** Keyed by `queueKey(turns, market)`. */
  slots: Record<string, QueueSlot | null>;
  /**
   * Pairs waiting to start, per line. Matched players who could not start
   * because every ring was full sit in a FIFO queue and begin as duels finish;
   * this is how deep that queue is.
   */
  pendingCounts: Record<string, number>;
  isLoading: boolean;
  refetch: () => void;
}

export function useQueueState(): QueueState {
  const contracts = [
    // getSlot for every line the lobby offers, then pendingCount for each, in
    // the same order — the two halves are read back by offset below.
    ...LOBBY_MENU.map(({ turns, market }) => ({
      address: MATCHMAKER_ADDRESS,
      abi: ABIS.Matchmaker,
      functionName: 'getSlot' as const,
      args: [turns, market] as [number, number],
    })),
    ...LOBBY_MENU.map(({ turns, market }) => ({
      address: MATCHMAKER_ADDRESS,
      abi: ABIS.Matchmaker,
      functionName: 'pendingCount' as const,
      args: [turns, market] as [number, number],
    })),
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

  // First half of the results are the slots, second half the pending counts.
  const slots: Record<string, QueueSlot | null> = {};
  const pendingCounts: Record<string, number> = {};

  LOBBY_MENU.forEach(({ turns, market }, i) => {
    const key = queueKey(turns, market);

    const slotResult = data?.[i];
    if (slotResult?.status === 'success' && slotResult.result) {
      const [player, fighter, deposit] = slotResult.result as unknown as [Address, bigint | number, bigint];
      slots[key] = player === zeroAddress
        ? null
        : { player, fighter: Number(fighter), deposit };
    } else {
      slots[key] = null;
    }

    const pendingResult = data?.[LOBBY_MENU.length + i];
    pendingCounts[key] =
      pendingResult?.status === 'success' ? Number(pendingResult.result as bigint) : 0;
  });

  return { slots, pendingCounts, isLoading, refetch };
}
