import type { PublicClient } from 'viem';

/**
 * When a block happened, in wall-clock seconds.
 *
 * NOT DERIVED FROM ARITHMETIC. The obvious shortcut — take the fight's start
 * time and add the block delta times the chain's nominal block time — is wrong in
 * exactly the case a spectator cares about: a fight that stalled. Turns are driven
 * by the chain's own scheduler and a stalled fight can sit for minutes between
 * rounds, so an invented timestamp would read as a smooth cadence that never
 * happened. On a page whose whole claim is "every move on-chain", a made-up time
 * is worse than no time at all.
 *
 * So each distinct block is asked directly, and the answers are cached for the
 * life of the tab. A fifteen-round fight's moves land in roughly thirty distinct
 * blocks, so this is about thirty calls, once — and every later render is free.
 */
const cache = new Map<string, number>();

/** Cache key. The block number alone would collide across chains. */
const keyFor = (chainId: number | undefined, block: bigint) => `${chainId ?? 0}:${block}`;

/**
 * Resolve many block numbers at once, de-duplicated.
 *
 * A block that cannot be fetched is simply absent from the result rather than
 * guessed at — the caller shows the move without a time instead of with a wrong
 * one. Failures are per-block, so one throttled request cannot blank the rest.
 */
export async function blockTimes(
  client: PublicClient,
  blocks: readonly bigint[],
): Promise<Map<string, number>> {
  const chainId = client.chain?.id;
  const wanted = Array.from(new Set(blocks.filter((b) => b > BigInt(0)).map(String)))
    .map((s) => BigInt(s))
    .filter((b) => !cache.has(keyFor(chainId, b)));

  if (wanted.length > 0) {
    const fetched = await Promise.all(
      wanted.map(async (b) => {
        try {
          const blk = await client.getBlock({ blockNumber: b });
          return [b, Number(blk.timestamp)] as const;
        } catch {
          return null;
        }
      }),
    );
    for (const hit of fetched) {
      if (hit) cache.set(keyFor(chainId, hit[0]), hit[1]);
    }
  }

  // Return the whole requested set from cache, so a caller gets one lookup table
  // covering everything it asked for — including blocks resolved by an earlier call.
  const out = new Map<string, number>();
  for (const b of blocks) {
    const t = cache.get(keyFor(chainId, b));
    if (t !== undefined) out.set(String(b), t);
  }
  return out;
}

/** One block, same rules. Undefined when it could not be read. */
export async function blockTime(
  client: PublicClient,
  block: bigint,
): Promise<number | undefined> {
  const m = await blockTimes(client, [block]);
  return m.get(String(block));
}

/**
 * Wall-clock time of day, to the second: `18:42:31`.
 *
 * Deliberately not a "3 minutes ago" relative time. The timeline's job is to let
 * two moves be compared, and a list of relative times all rounded to the same
 * minute cannot do that.
 */
export const clockOf = (seconds: number | undefined): string =>
  seconds === undefined
    ? '--:--:--'
    : new Date(seconds * 1000).toLocaleTimeString(undefined, { hour12: false });
