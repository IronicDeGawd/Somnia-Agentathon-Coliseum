/**
 * A liquidation the venue actually performed — and the one kind of margin drama
 * that survives the fight it happened in.
 *
 * WHY THIS IS A DIFFERENT SORT OF FACT FROM A SIGHTING. A margin state is a live
 * calculation: the venue is asked what an account's state is right now and answers
 * from current equity. Nobody writes it down, and the link from a fighter to its
 * rented trading account is deleted at the final bell — so after the bell the
 * registry answers "healthy" forever, whatever happened during the fight. That is
 * why the page's ten-second poll is only ever a witness statement.
 *
 * A LIQUIDATION IS NOT LIKE THAT, because it is an action rather than a threshold.
 * The venue does it, and records that it did: `AccountLiquidated` is indexed by the
 * account and carries the margin status before and after — the same two numbers the
 * warning cards render. So a fight finished months ago can still be asked what the
 * venue did to a fighter, and answer.
 *
 * What is NOT recoverable this way is a plain margin call. Equity crossing the
 * maintenance line is a fact about a number, not an act by a contract, and nothing
 * emits it. Measured on the real venue, duel 83: equity 0.0627, initial requirement
 * 0.0618, maintenance 0.0309, close-out 0.0155 — a call fires below maintenance,
 * and every lever we control caps out above initial. Only the market can trip it.
 */
export interface LiquidationRecord {
  fighterId: number;
  /** Margin status the venue saw before it acted. 0-3, as the cards render. */
  statusBefore: number;
  /** And after. A successful close-out usually returns the account to healthy. */
  statusAfter: number;
  /** How many of the fighter's positions the venue closed. */
  positions: number;
  /** How far the venue's liquidation ladder had to go. */
  stage: number;
  block: bigint;
  /** Wall-clock seconds, once the block has been asked. Never guessed. */
  timestamp?: number;
}

/** One `AccountLiquidated` log, loosely typed so callers need no viem generics. */
export interface RawLiquidationLog {
  blockNumber: bigint | null;
  args: {
    account?: string;
    positionsProcessed?: bigint;
    stageReached?: number;
    marginStatusBefore?: number;
    marginStatusAfter?: number;
  };
}

/**
 * Turn the venue's logs into timeline records, attributing each to a fighter.
 *
 * @param accountOf lowercased account address → fighterId, from the fight's own
 *        lease records. An account we cannot attribute is DROPPED rather than
 *        guessed at: these accounts are reused across fights, so a liquidation
 *        belonging to somebody else's fight must never be shown in this one.
 */
export function liquidationRecords(
  logs: readonly RawLiquidationLog[],
  accountOf: ReadonlyMap<string, number>,
): LiquidationRecord[] {
  const out: LiquidationRecord[] = [];
  for (const l of logs) {
    const account = (l.args.account ?? '').toLowerCase();
    const fighterId = accountOf.get(account);
    if (fighterId === undefined) continue;
    out.push({
      fighterId,
      statusBefore: Number(l.args.marginStatusBefore ?? 0),
      statusAfter: Number(l.args.marginStatusAfter ?? 0),
      positions: Number(l.args.positionsProcessed ?? 0),
      stage: Number(l.args.stageReached ?? 0),
      block: l.blockNumber ?? BigInt(0),
    });
  }
  out.sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));
  return out;
}

/**
 * What a liquidation reads as on the timeline.
 *
 * The status it reports is the one the venue saw BEFORE it acted, because that is
 * the state being described — "the venue found this account in close-out and did
 * something about it". Reporting the after-status would announce a liquidation as
 * "healthy", which is true and useless.
 */
export const liquidationWord = (r: LiquidationRecord): string =>
  r.positions > 1
    ? `LIQUIDATED · ${r.positions} positions closed`
    : 'LIQUIDATED · position closed';
