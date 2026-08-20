export interface MarginObservation {
  fighterId: number;
  /** 0 healthy · 1 margin call · 2 partial liquidation · 3 close-out. */
  status: number;
  /** Wall-clock seconds when this change was first seen by a browser. */
  seenAt: number;
}

/**
 * Which margin sightings are NEW, given what has already been recorded.
 *
 * Pure, and separate from the hook that calls it, for one reason: this is the only
 * logic in the margin timeline that can be got wrong quietly. A ten-second poll
 * that records every sample instead of every CHANGE writes six identical lines a
 * minute and buries the fight; one that records nothing on the first sighting of
 * trouble loses the only copy of a moment nothing else stores. Both failures look
 * fine on screen until the moment matters, so both are tested — without adding a
 * React test framework to do it.
 *
 * @param recorded what has already been kept, oldest first.
 * @param statuses fighterId → status right now, from the poll the page already runs.
 * @param now      wall-clock seconds, passed in rather than read, so a test can pin it.
 */
export function newObservations(
  recorded: readonly MarginObservation[],
  statuses: ReadonlyMap<number, number>,
  now: number,
): MarginObservation[] {
  const latest = new Map<number, number>();
  for (const o of recorded) latest.set(o.fighterId, o.status);

  const fresh: MarginObservation[] = [];
  for (const [fighterId, status] of statuses) {
    const prev = latest.get(fighterId);
    if (prev === status) continue;
    // A FIRST sighting of "healthy" is not news — it is the normal state of every
    // fighter in every fight, and recording it would put a meaningless line at the
    // top of the timeline before anything had happened. A LATER return to healthy
    // is news: it is the fighter climbing back off the line.
    if (prev === undefined && status === 0) continue;
    fresh.push({ fighterId, status, seenAt: now });
  }
  return fresh;
}

/**
 * The statuses a fresh batch leaves behind, for seeding the next comparison.
 * Includes the first-sighting-of-healthy that `newObservations` deliberately does
 * not record, so it is not re-examined every poll.
 */
export function settledStatuses(
  recorded: readonly MarginObservation[],
  statuses: ReadonlyMap<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const o of recorded) out.set(o.fighterId, o.status);
  for (const [fighterId, status] of statuses) {
    if (!out.has(fighterId)) out.set(fighterId, status);
  }
  return out;
}
