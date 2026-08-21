/**
 * Which game a fight is playing, named from the pools it recorded when it started.
 *
 * WHY IT HAS TO BE DERIVED AT ALL. A duel's stored record carries a `simulated`
 * flag and a pool mask, but no market kind — the flag is two-valued, so a spot
 * fight and an events fight both report false. The markets a fight actually trades
 * are the addresses in `duelPoolsOf(duelId)`, and those are the only honest source.
 *
 * WHY A FIXED ADDRESS TABLE IS NOT ENOUGH. Event desks are rebound to fresh
 * questions every fifteen minutes and move address when they are, so no table
 * shipped in a bundle can name them — they are identified by ELIMINATION, which is
 * sound here because the other three sets are all stable: the spot books are
 * permanent, the practice pools are permanent, and a perpetual never expires so its
 * desk is never rebound either.
 *
 * The perp answer still comes from the chain (`isPerpPool`) rather than a table,
 * because a desk set can be extended without this file being touched — and a
 * mislabelled market on a card is worse than an unlabelled one.
 */
export type MarketName = 'EVENTS' | 'PERPS' | 'SPOT' | 'PRACTICE';

const lower = (a: string) => a.toLowerCase();

/**
 * DELIBERATELY IMPORTS NOTHING. The address tables are passed in rather than read
 * from the contracts module, for two reasons: the decision does not depend on where
 * they live, and a module with no imports can be exercised directly by the test
 * runner, which does not resolve the bundler's path aliases. The wiring belongs to
 * the hook that has the tables to hand.
 *
 * @param pools     the fight's three pool addresses, from `duelPoolsOf`.
 * @param isPerp    address (lowercased) → whether the Arena calls it a perp desk.
 * @param simulated the duel record's own flag, used only as a fallback.
 * @param spotAddrs the permanent coin books.
 * @param simAddrs  the permanent practice books.
 * @returns the market, or undefined while the reads are still in flight — never a
 *          guess. A caller shows no badge rather than the wrong one.
 */
export function marketOf(
  pools: readonly string[] | undefined,
  isPerp: ReadonlyMap<string, boolean> | undefined,
  simulated: boolean,
  spotAddrs: readonly string[],
  simAddrs: readonly string[],
): MarketName | undefined {
  const SPOT_SET = new Set(spotAddrs.map(lower));
  const SIM_SET = new Set(simAddrs.map(lower));
  if (!pools || pools.length === 0) {
    // Nothing read yet. `simulated` is knowable without any call, so a practice
    // fight can still be named; anything else waits rather than guessing.
    return simulated ? 'PRACTICE' : undefined;
  }
  const addrs = pools.map(lower);

  // Perps first: it is the only one answered directly rather than by elimination.
  if (isPerp === undefined) return simulated ? 'PRACTICE' : undefined;
  if (addrs.some((a) => isPerp.get(a) === true)) return 'PERPS';

  if (addrs.every((a) => SIM_SET.has(a))) return 'PRACTICE';
  if (addrs.every((a) => SPOT_SET.has(a))) return 'SPOT';

  // Not perps, not the practice books, not the spot books. An events desk is what
  // is left — and it is the one set whose addresses cannot be known in advance.
  return 'EVENTS';
}

/**
 * The colour a market is drawn in, matching the lobby's own market picker so a
 * badge on a card and the button that starts that game are the same colour.
 */
export const MARKET_ACCENT: Record<MarketName, string> = {
  EVENTS: 'var(--gold)',
  PERPS: 'var(--market-perps)',
  SPOT: 'var(--market-spot)',
  PRACTICE: 'var(--market-practice)',
};

/** The glyph each market carries in the picker, repeated here for recognition. */
export const MARKET_GLYPH: Record<MarketName, string> = {
  EVENTS: '◆',
  PERPS: '◇',
  SPOT: '⚡',
  PRACTICE: '🧪',
};
