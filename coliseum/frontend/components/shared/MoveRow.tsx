import type { TranscriptEntry } from '@/hooks/useDuelTranscript';

/**
 * How a fighter's move is worded, wherever it appears.
 *
 * WHY THIS IS SHARED AND THE LAYOUTS ARE NOT. A fight is shown twice: live, as a
 * column per corner with the newest line on top, and once it is over, as a
 * scorecard with a row per round. Those two shapes are both deliberate — a
 * spectator follows one fighter down a column while a fight is running, and
 * compares the two across a round once it is settled.
 *
 * What was NOT deliberate is that the two pages had grown two different
 * vocabularies for the same events. The same refusal read `> refused — no route`
 * on one page and `— no route` on the other; an empty slot was "Nothing recorded
 * yet" in one place and a lone `·` in the other; and the direction colouring —
 * the whole point of which is that a long and a short look identical until you
 * read the word — applied only while the fight was live, then quietly stopped
 * once it ended, because the component that did it was defined inside the live
 * page's own file where nothing else could reach it.
 *
 * So the words and the colours live here, and each page keeps its own shape.
 */

/** Directions that mean the fighter went long of something. */
const UP = new Set(['LONG', 'BUY', 'BACK']);
/** And short of it. DROP is the prediction market's word for selling a question. */
const DOWN = new Set(['SHORT', 'SELL', 'DROP']);

/**
 * A move, with its direction visible before it is read.
 *
 * Every move is a direction and a market — LONG ETH, SELL WBTC, DROP BTCUP — and
 * the direction is what a spectator is scanning for. As one flat string it is a
 * wall of identical text, and on perps especially a long and a short are the same
 * shape. So the first word carries the colour and the market keeps plain weight.
 *
 * @param prefix the `> ` lead-in. Wanted in a feed, where each line is an
 *        utterance; unwanted in a table cell, where the column already says what
 *        the value is and a chevron in every cell is noise.
 */
export function MoveText({ move, prefix = true }: { move: string; prefix?: boolean }) {
  const [word, ...rest] = move.split(' ');
  return (
    <span>
      {prefix && <span className="t-dim">{'> '}</span>}
      <span style={{ color: UP.has(word) ? 'var(--win)' : DOWN.has(word) ? 'var(--loss)' : 'var(--text-dim)' }}>
        {word}
      </span>
      {rest.length > 0 && ` ${rest.join(' ')}`}
    </span>
  );
}

/**
 * A move the venue would not take.
 *
 * ALWAYS CARRIES ITS REASON, and never reads as the fighter choosing to wait. A
 * refusal is the most informative line in a transcript — it is the market saying
 * no — and rendering it as a blank or a "HOLD" loses the only record of why a
 * round went nowhere.
 */
export function RefusalText({ reason, prefix = true }: { reason?: string | null; prefix?: boolean }) {
  return (
    <span className="t-dim">
      {prefix ? '> ' : ''}refused — {reason || 'no reason given'}
    </span>
  );
}

/**
 * A round this fighter has no entry for at all — not a refusal, not a hold:
 * nothing was logged. Distinct from a refusal on purpose, because "the venue
 * said no" and "we have no record" are different claims.
 */
export function NoEntry({ prefix = true }: { prefix?: boolean }) {
  return (
    <span className="t-faint">
      {prefix ? '> ' : ''}no record
    </span>
  );
}

/**
 * One transcript entry, worded. The single place that decides which of the three
 * readings above an entry gets, so the two pages cannot disagree about it.
 */
export function MoveEntry({ entry, prefix = true }: { entry?: TranscriptEntry; prefix?: boolean }) {
  if (!entry) return <NoEntry prefix={prefix} />;
  if (entry.failed) return <RefusalText reason={entry.reason} prefix={prefix} />;
  return <MoveText move={entry.action ?? 'HOLD'} prefix={prefix} />;
}

/** What a list with nothing in it says. Same words on every page. */
export const NOTHING_RECORDED = 'Nothing recorded yet';
