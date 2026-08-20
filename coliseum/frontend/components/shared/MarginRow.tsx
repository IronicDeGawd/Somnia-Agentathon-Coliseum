import { liquidationWord, type LiquidationRecord } from '@/lib/liquidations';
import { marginStatusCopy } from '@/lib/marginStatus';

/**
 * The two ways a fighter's margin trouble can be described — worded once, so the
 * live page and the finished-fight page cannot drift apart the way the move rows
 * did.
 *
 * THEY ARE NOT THE SAME KIND OF CLAIM, and the wording is what carries that. A
 * margin state is a live calculation nobody records, read off an account whose
 * link to its fighter is deleted at the final bell — so it exists only if a
 * browser happened to be open and wrote it down. A liquidation is an act the
 * venue performs and records, and can be read back for any fight however old.
 * Both end with a qualifier saying which it is: "· seen" against "· on-chain".
 * Without that a spectator has no way to tell a witness statement from a receipt.
 */

/**
 * A liquidation the venue performed.
 *
 * Reports the status found BEFORE it acted — "the venue found this account in
 * close-out and did something about it". The after-status is usually healthy,
 * which is true and useless as a headline.
 */
export function LiquidationRow({ record }: { record: LiquidationRecord }) {
  const before = marginStatusCopy(record.statusBefore);
  return (
    <span style={{ color: 'var(--loss)', minWidth: 0 }}>
      <span aria-hidden="true">⚡ </span>{liquidationWord(record)}
      {before && <span className="t-dim"> · was {before.word.toLowerCase()}</span>}
      <span className="t-faint t-xs"> · on-chain</span>
    </span>
  );
}

/**
 * A margin state a page witnessed. Only ever rendered for a live fight — after
 * the final bell the account link is gone and the registry answers "healthy"
 * forever, so a finished fight has no honest way to show one it did not see.
 */
export function MarginLine({ status }: { status: number }) {
  if (status === 0) {
    return (
      <span style={{ color: 'var(--win)' }}>
        <span aria-hidden="true">✓ </span>RECOVERED<span className="t-faint t-xs"> · seen</span>
      </span>
    );
  }
  const copy = marginStatusCopy(status);
  return (
    <span style={{ color: 'var(--loss)' }}>
      <span aria-hidden="true">⚠ </span>{copy?.word ?? 'UNKNOWN STATUS'}
      <span className="t-faint t-xs"> · seen</span>
    </span>
  );
}
