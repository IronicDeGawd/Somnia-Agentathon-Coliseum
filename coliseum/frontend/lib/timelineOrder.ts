/**
 * Putting a fight's timeline in order, when its rows do not all measure time the
 * same way.
 *
 * THE TRAP THIS REPLACES. The first version gave every row one number to sort on
 * — its wall-clock time if it had one, and its BLOCK NUMBER if it did not — and
 * then sorted on that. Those are not the same unit. A block height counts blocks
 * since the chain began; a timestamp counts seconds since 1970, and is far the
 * larger of the two. So any row still waiting for its clock sank underneath
 * every row that had one, regardless of when it actually happened: a move from
 * round twelve could appear below round one, and a margin sighting always floated
 * to the very top because a sighting is stamped in seconds from the start.
 *
 * WHAT THE TWO KINDS OF ROW ACTUALLY KNOW. A move or a liquidation is a chain
 * event: its block is known immediately and permanently, and its wall-clock time
 * has to be fetched afterwards and may never arrive. A margin sighting is the
 * reverse — it never had a block, because nothing recorded it; all it has is the
 * moment a browser noticed it.
 *
 * SO THEY ARE ORDERED SEPARATELY AND THEN MERGED. Chain rows are ordered by
 * block, which is the true sequence and is never missing. Sightings are ordered
 * among themselves by when they were seen, then slotted against the chain rows
 * whose clocks HAVE arrived. Where no clock has arrived yet, a sighting sits at
 * the newest end — which is where it belongs, because a sighting can only ever
 * be made by a page that is open right now.
 */

/** A row that came off the chain: block always known, clock maybe. */
export interface ChainRow {
  block: bigint;
  timestamp?: number;
}

/** A row a browser witnessed: clock always known, no block, ever. */
export interface SeenRow {
  seenAt: number;
}

/**
 * Order a fight's rows newest-first.
 *
 * Generic over the caller's own row type so the page keeps its discriminated
 * union and this file needs to know nothing about moves, margin or liquidations.
 *
 * @param rows every row to place.
 * @param keyOf what each row knows about when it happened.
 * @returns a new array, newest first. Stable: rows that cannot be told apart
 *          keep the order they came in, so a repaint never shuffles them.
 */
export function newestFirst<T>(
  rows: readonly T[],
  keyOf: (row: T) => ChainRow | SeenRow,
): T[] {
  const isSeen = (k: ChainRow | SeenRow): k is SeenRow =>
    (k as SeenRow).seenAt !== undefined;

  const chain: { row: T; k: ChainRow; i: number }[] = [];
  const seen: { row: T; k: SeenRow; i: number }[] = [];
  rows.forEach((row, i) => {
    const k = keyOf(row);
    if (isSeen(k)) seen.push({ row, k, i });
    else chain.push({ row, k, i });
  });

  // Chain rows: by block, newest first. The index breaks ties so two events in
  // one block hold the order the caller supplied them in — which is the order
  // they were logged in, and therefore the order they happened.
  chain.sort((a, b) => (a.k.block === b.k.block ? a.i - b.i : a.k.block < b.k.block ? 1 : -1));
  // Sightings: newest first among themselves.
  seen.sort((a, b) => (b.k.seenAt - a.k.seenAt) || (a.i - b.i));

  // Merge. Walking the chain rows newest-first, a sighting is emitted as soon as
  // we reach a chain row that is OLDER than it. A chain row with no clock yet
  // cannot be compared, so it is treated as older — which keeps the sighting
  // above it, the correct side for something witnessed live.
  const out: T[] = [];
  let s = 0;
  for (const c of chain) {
    while (s < seen.length && isOlder(c.k, seen[s].k.seenAt)) {
      out.push(seen[s].row);
      s += 1;
    }
    out.push(c.row);
  }
  // Anything left is older than every chain row, so it lands at the bottom.
  for (; s < seen.length; s += 1) out.push(seen[s].row);
  return out;
}

/**
 * Is this chain row older than the given moment?
 *
 * A row whose clock has not arrived answers YES — not because it is known to be
 * older, but because a sighting is made live and belongs above the history. The
 * alternative, comparing against a number that isn't there, is what produced the
 * original mis-ordering.
 */
function isOlder(k: ChainRow, moment: number): boolean {
  return k.timestamp === undefined ? true : k.timestamp < moment;
}
