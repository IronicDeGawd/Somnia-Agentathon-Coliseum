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
 * Upper-bound block for a duel's events. Normally a duel resolves within
 * startBlock + turns×600 + tail. But a duel can advance slower than the nominal
 * cadence (e.g. a stalled duel only driven once a referee picks it up), pushing
 * its DuelResolved/last FighterMove far past the scheduled bound. When the duel's
 * real lastTurnBlock is known, bound from THAT instead so delayed duels don't
 * come back blank.
 */
export function duelToBlock(startBlock: bigint, turns: number, lastTurnBlock?: bigint): bigint {
  const scheduled = startBlock + BigInt(turns) * TURN_INTERVAL_BLOCKS + LIFESPAN_TAIL_BLOCKS;
  if (lastTurnBlock !== undefined && lastTurnBlock > BigInt(0)) {
    const actual = lastTurnBlock + LIFESPAN_TAIL_BLOCKS;
    return actual > scheduled ? actual : scheduled;
  }
  return scheduled;
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
