'use client';

import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES, POOLS, SIM_POOLS } from '@/lib/contracts';
import { marketOf, type MarketName } from '@/lib/marketKind';

/**
 * Which market each of many fights is playing, in a fixed number of calls.
 *
 * WHY NOT `useDuelSlots` PER CARD. That hook answers a richer question — what each
 * individual slot holds, needed to name a move — and costs seven reads per fight.
 * A lobby showing four cards would pay twenty-eight, and the all-live page could
 * ask for hundreds. Naming the market needs far less.
 *
 * So this batches across fights and DEDUPES the pools: one `duelPoolsOf` per fight,
 * then one `isPerpPool` per DISTINCT address. There are only about a dozen distinct
 * pools in existence at any moment, so the second batch stays roughly constant
 * however many fights are running — a hundred live duels cost a hundred and twelve
 * reads rather than seven hundred, and wagmi coalesces each batch into few requests.
 *
 * Returns a map keyed by duel id as a string, because a bigint is a poor Map key
 * across renders. A fight still being read is simply absent, and callers draw no
 * badge rather than a guessed one.
 */
export function useDuelMarkets(
  duels: readonly { duelId: bigint; simulated: boolean }[],
): Map<string, MarketName> {
  const ids = duels.map((d) => d.duelId);

  const { data: poolReads } = useReadContracts({
    contracts: ids.map((id) => ({
      address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
      abi: ABIS.Arena,
      functionName: 'duelPoolsOf' as const,
      args: [id] as [bigint],
    })),
    query: { enabled: ids.length > 0 },
  });

  // Every distinct pool across every fight, so the perp question is asked once per
  // address rather than once per fight that happens to use it.
  const distinct = useMemo(() => {
    const set = new Set<string>();
    for (const r of poolReads ?? []) {
      for (const a of (r?.result as readonly string[] | undefined) ?? []) {
        if (a && a !== '0x0000000000000000000000000000000000000000') set.add(a.toLowerCase());
      }
    }
    return Array.from(set);
  }, [poolReads]);

  const { data: perpReads } = useReadContracts({
    contracts: distinct.map((addr) => ({
      address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
      abi: ABIS.Arena,
      functionName: 'isPerpPool' as const,
      args: [addr as `0x${string}`] as [`0x${string}`],
    })),
    query: { enabled: distinct.length > 0 },
  });

  return useMemo(() => {
    const isPerp = perpReads
      ? new Map(distinct.map((a, i) => [a, perpReads[i]?.result === true]))
      : undefined;

    const out = new Map<string, MarketName>();
    duels.forEach((d, i) => {
      const pools = poolReads?.[i]?.result as readonly string[] | undefined;
      const name = marketOf(
        pools, isPerp, d.simulated,
        POOLS.map((p) => p.address), SIM_POOLS.map((p) => p.address),
      );
      if (name) out.set(d.duelId.toString(), name);
    });
    return out;
    // `duels` is rebuilt every render by its caller, so depend on the ids rather
    // than the array identity or this recomputes forever.
  }, [poolReads, perpReads, distinct, duels.map((d) => d.duelId.toString()).join(',')]);
}
