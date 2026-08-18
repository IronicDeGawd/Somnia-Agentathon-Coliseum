'use client';

import { useReadContracts } from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES, POOL_SLOTS, slotLabel } from '@/lib/contracts';
import type { SlotKind } from '@/lib/contracts';

/**
 * What a fight's three slots hold — a coin book, a prediction question, or a
 * perpetual futures market.
 *
 * Needed because a fighter's move arrives as a bare number from 1 to 6, and what
 * that number MEANS depends entirely on the markets behind it: id 1 is buying
 * Bitcoin on a spot fight, backing a question on an events fight, and going long
 * on a perps fight. Anything that shows a move has to know which.
 *
 * Returned in slot order and NOT filtered by the fight's pool mask, because the
 * ids are numbered against slots rather than against the markets a fight uses.
 * Undefined while the reads are in flight, so a caller can fall back to the plain
 * coin-book names rather than confidently showing the wrong market.
 */
export function useDuelSlots(duelId: bigint): SlotKind[] | undefined {
  const { data: poolReads } = useReadContracts({
    contracts: [{
      address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
      abi: ABIS.Arena,
      functionName: 'duelPoolsOf' as const,
      args: [duelId] as [bigint],
    }],
    query: { enabled: duelId > BigInt(0) },
  });

  const pools = poolReads?.[0]?.result as readonly `0x${string}`[] | undefined;

  const { data: kindReads } = useReadContracts({
    contracts: (pools ?? []).flatMap((addr) => [
      {
        address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
        abi: ABIS.Arena,
        functionName: 'poolQuestion' as const,
        args: [addr] as [`0x${string}`],
      },
      {
        address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
        abi: ABIS.Arena,
        functionName: 'isPerpPool' as const,
        args: [addr] as [`0x${string}`],
      },
    ]),
    query: { enabled: !!pools },
  });

  if (!pools || !kindReads) return undefined;

  return POOL_SLOTS.map((_, i) => ({
    label: slotLabel(kindReads[i * 2]?.result as `0x${string}` | undefined),
    isPerp: kindReads[i * 2 + 1]?.result === true,
  }));
}
