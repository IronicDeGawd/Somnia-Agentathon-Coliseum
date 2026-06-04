import type { PublicClient } from 'viem';

// Turn cadence on-chain (Arena.TURN_INTERVAL_BLOCKS). Used to bound how far past
// a duel's startBlock its events can possibly land.
const TURN_INTERVAL_BLOCKS = BigInt(600);
// Tail after the final turn to cover finalizeDuel (which emits DuelResolved and
// the last MarkPriceSnapshot). Turn moves all land within turns×600.
const LIFESPAN_TAIL_BLOCKS = BigInt(1500);
// The public Somnia RPCs reject getLogs ranges wider than ~1000 blocks ("unknown
// RPC error"). Scanning startBlock→'latest' (or even a few thousand blocks)
// silently failed — that's why older duels came back blank. Keep each window
// at the cap and fan the windows out in parallel (the batch transport coalesces).
const MAX_RANGE = BigInt(1000);

/**
 * Upper-bound block for a duel's events. Every MarkPriceSnapshot / FighterMove /
 * DuelResolved for a duel lands within [startBlock, startBlock + turns×600 + tail],
 * so we never need to scan to chain head — which keeps getLogs inside the RPC's
 * range limit no matter how long ago the duel ran.
 */
export function duelToBlock(startBlock: bigint, turns: number): bigint {
  return startBlock + BigInt(turns) * TURN_INTERVAL_BLOCKS + LIFESPAN_TAIL_BLOCKS;
}

/**
 * getLogs across [fromBlock, toBlock] in ≤MAX_RANGE windows, capped at chain head.
 * Tolerates per-window failures (returns whatever windows succeeded) so one
 * throttled chunk can't blank the whole result.
 */
export async function getLogsChunked(
  client: PublicClient,
  params: {
    address: `0x${string}`;
    // viem AbiEvent — kept loose to avoid leaking the generic through callers.
    event: Parameters<PublicClient['getLogs']>[0] extends { event?: infer E } ? E : unknown;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  },
): Promise<unknown[]> {
  const { address, event, args, fromBlock } = params;
  let toBlock = params.toBlock;
  try {
    const head = await client.getBlockNumber();
    if (toBlock > head) toBlock = head;
  } catch {
    // If head is unavailable, fall back to the requested toBlock.
  }

  const ONE = BigInt(1);

  // Build the ≤MAX_RANGE windows up front, then fetch them concurrently. The
  // wagmi batch transport coalesces the concurrent getLogs into few HTTP POSTs.
  const windows: { from: bigint; to: bigint }[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const windowEnd = start + MAX_RANGE - ONE;
    windows.push({ from: start, to: windowEnd <= toBlock ? windowEnd : toBlock });
    start = windowEnd + ONE;
  }

  const results = await Promise.all(
    windows.map((w) =>
      client
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .getLogs({ address, event, args, fromBlock: w.from, toBlock: w.to } as any)
        .catch(() => [] as unknown[]), // one bad window must not blank the rest
    ),
  );
  return results.flat();
}
