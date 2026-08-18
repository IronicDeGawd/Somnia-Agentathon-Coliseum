'use client';

import { useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';
import { config } from '@/lib/chain';

const ARENA = CONTRACT_ADDRESSES.Arena as Address;

/**
 * The three questions the events market is currently asking, in slot order.
 *
 * They are read from the chain rather than written into the UI because a
 * prediction window closes every few minutes and the desks are re-pointed at
 * fresh questions between fights. A hard-coded "ETH / BTC" label would go stale
 * the moment that happens, and would also hide that two slots can hold the same
 * asset over different horizons.
 *
 * Returns short names like BTCUP or BTCSOON — the same words the fighters read.
 */
export function useEventQuestions(): { questions: string[]; isLoading: boolean } {
  const slots = ['EVENT_POOL_WETH', 'EVENT_POOL_WBTC', 'EVENT_POOL_SOMI'] as const;

  const { data: pools, isLoading: poolsLoading } = useReadContracts({
    contracts: slots.map((functionName) => ({ address: ARENA, abi: ABIS.Arena, functionName })),
    config,
  });

  const addresses = (pools ?? []).map((r) =>
    r?.status === 'success' ? (r.result as Address) : undefined,
  );

  const { data: labels, isLoading: labelsLoading } = useReadContracts({
    contracts: addresses.filter(Boolean).map((pool) => ({
      address: ARENA, abi: ABIS.Arena, functionName: 'poolQuestion' as const, args: [pool as Address],
    })),
    config,
    query: { enabled: addresses.filter(Boolean).length > 0 },
  });

  const questions = (labels ?? [])
    .map((r) => (r?.status === 'success' ? decodeLabel(r.result as `0x${string}`) : ''))
    .filter(Boolean);

  return { questions, isLoading: poolsLoading || labelsLoading };
}

/** bytes8 of ASCII, zero-padded on the right. */
function decodeLabel(raw: `0x${string}`): string {
  if (!raw || raw === '0x0000000000000000') return '';
  const hex = raw.slice(2);
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}
