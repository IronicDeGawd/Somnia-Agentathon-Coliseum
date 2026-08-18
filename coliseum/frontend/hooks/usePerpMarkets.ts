'use client';

import { useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import { CONTRACT_ADDRESSES, ABIS, slotLabel } from '@/lib/contracts';
import { config } from '@/lib/chain';

const ARENA = CONTRACT_ADDRESSES.Arena as Address;

/** The four fight lengths, in the order the lobby offers them. */
const TIERS = [3, 6, 9, 15] as const;

export interface PerpTierOffer {
  turns: number;
  /** Asset names, e.g. ["XRP", "ADA", "SOL"], or empty when the tier cannot start. */
  markets: string[];
  /**
   * True when fewer than three markets currently qualify, so a fight at this
   * length would be refused. Worth surfacing before a player pays rather than
   * after — the refusal reaches them as a failed queue with no explanation.
   */
  unavailable: boolean;
}

/**
 * Which three assets each perps tier would trade if a fight started right now.
 *
 * Read from the chain and never written down, for the same reason the event
 * questions are: the set is not fixed. The margin a market costs scales with how
 * much open interest it carries, so an asset drops out of the cheap tiers on its
 * own when it gets busy and walks back in when it quietens. Bitcoin only appears
 * at the longest length, and only while its margin stays inside that budget.
 */
export function usePerpMarkets(): { offers: PerpTierOffer[]; isLoading: boolean } {
  const { data: picks, isLoading: picksLoading } = useReadContracts({
    contracts: TIERS.map((turns) => ({
      address: ARENA,
      abi: ABIS.Arena,
      functionName: 'perpMarketsFor' as const,
      args: [turns] as [number],
    })),
    config,
  });

  // Every address across every tier, deduped — the same market usually appears in
  // several tiers, and one label read each is plenty.
  const addresses = Array.from(new Set(
    (picks ?? []).flatMap((r) =>
      r?.status === 'success' ? (r.result as readonly Address[]) : [],
    ).filter((a) => a && !/^0x0+$/.test(a)).map((a) => a.toLowerCase()),
  )) as Address[];

  const { data: labels, isLoading: labelsLoading } = useReadContracts({
    contracts: addresses.map((pool) => ({
      address: ARENA, abi: ABIS.Arena, functionName: 'poolQuestion' as const, args: [pool],
    })),
    config,
    query: { enabled: addresses.length > 0 },
  });

  const nameOf = new Map<string, string>();
  addresses.forEach((addr, i) => {
    const r = labels?.[i];
    const name = r?.status === 'success' ? slotLabel(r.result as `0x${string}`) : null;
    if (name) nameOf.set(addr, name);
  });

  const offers = TIERS.map((turns, i) => {
    const r = picks?.[i];
    // A reverting read is the honest answer, not an error to hide: the selection
    // refuses when fewer than three markets qualify, which is exactly what
    // starting a fight at this length would do.
    if (r?.status !== 'success') return { turns, markets: [], unavailable: !picksLoading };
    const markets = (r.result as readonly Address[])
      .map((a) => nameOf.get(a.toLowerCase()))
      .filter(Boolean) as string[];
    return { turns, markets, unavailable: false };
  });

  return { offers, isLoading: picksLoading || labelsLoading };
}
