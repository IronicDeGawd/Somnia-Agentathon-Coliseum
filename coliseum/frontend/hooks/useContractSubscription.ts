'use client';

import { useEffect, useRef } from 'react';
import { getAbiItem, type Abi, type AbiEvent } from 'viem';
import { getWsClient } from '@/lib/wsClient';

/**
 * A log as delivered by `watchEvent` when an `event` ABI item is supplied:
 * decoded, so `args` is populated. viem's bare `Log` type has no `args`, which
 * is why this is spelled out rather than reused.
 */
export interface SubscriptionLog {
  transactionHash: `0x${string}` | null;
  logIndex: number | null;
  args: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UseContractSubscriptionArgs {
  /** Contract to subscribe to. */
  address: `0x${string}`;
  /** Full contract ABI — the event is looked up by name. */
  abi: Abi | readonly unknown[];
  /** Event name as declared in the ABI. */
  eventName: string;
  /**
   * Indexed-argument filter, applied at the RPC level (e.g. `{ duelId }`).
   * Omit to receive every emission of the event.
   */
  args?: Record<string, unknown>;
  /** Called with each batch of matching logs. May be an inline closure. */
  onLogs: (logs: readonly SubscriptionLog[]) => void;
  /** Subscribe only while true. Defaults to true. */
  enabled?: boolean;
}

/**
 * Subscribe to a contract event over the dedicated WebSocket client.
 *
 * wagmi's `useWatchContractEvent` is silent in this app: `lib/chain.ts`
 * configures HTTP-only transports (batched, deliberately — batching is what
 * stops the public RPC throttling the read burst), and over HTTP viem degrades
 * `watchContractEvent` to filter polling, which this RPC does not serve.
 * Subscriptions therefore live on `lib/wsClient.ts` (`eth_subscribe`) while
 * reads stay on batched HTTP. This hook is that split, factored out of the
 * pattern proven in `useDuelLive.ts` and `useQueueState.ts`.
 */
export function useContractSubscription({
  address,
  abi,
  eventName,
  args,
  onLogs,
  enabled = true,
}: UseContractSubscriptionArgs): void {
  // Hold the callback in a ref so an inline closure doesn't tear down and
  // re-establish the subscription on every render.
  const onLogsRef = useRef(onLogs);
  onLogsRef.current = onLogs;

  // Same for the filter: compare by value, not identity, so a fresh object
  // literal (`args: { duelId }`) doesn't resubscribe each render.
  const argsKey = args ? JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : '';
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    if (!enabled) return;
    const client = getWsClient();
    if (!client) return;

    const event = getAbiItem({ abi: abi as Abi, name: eventName }) as AbiEvent | undefined;
    if (!event) return;

    let unwatch: (() => void) | undefined;
    try {
      unwatch = client.watchEvent({
        address,
        event,
        ...(argsRef.current ? { args: argsRef.current } : {}),
        onLogs: (logs) => onLogsRef.current(logs as unknown as readonly SubscriptionLog[]),
        // Swallow transport hiccups: the polling fallbacks in the calling hooks
        // keep state moving, and viem reconnects the socket on its own.
        onError: () => {},
      } as Parameters<typeof client.watchEvent>[0]);
    } catch {
      // WS unavailable — callers still have their refetchInterval fallback.
    }

    return () => {
      try { unwatch?.(); } catch { /* already torn down */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, address, eventName, argsKey, abi]);
}
