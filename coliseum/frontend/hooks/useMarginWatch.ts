'use client';

import { useEffect, useRef, useState } from 'react';

import { newObservations, settledStatuses, type MarginObservation } from '@/lib/marginWatch';

/**
 * A record of the margin states a fighter was SEEN in.
 *
 * WHY THIS HAS TO EXIST AT ALL. A margin state is a live calculation, not a
 * recorded fact: the venue is asked "what is this account's state right now" and
 * answers from current equity. Nothing — not our contracts, not the venue's —
 * writes down that a fighter went on margin call. Worse, the link from a fighter
 * to its rented trading account is torn up at the final bell, so a finished fight
 * answers "healthy" forever, whatever happened during it.
 *
 * And the state is fleeting: equity dips under the line, the fighter recovers, and
 * the moment is gone. The duel page has been polling this every ten seconds for
 * months and discarding every sample, which is why the three warning states have
 * never once appeared on screen despite being written, styled and unit-tested.
 *
 * So this keeps what we see. It is a WITNESS STATEMENT, not a ledger — the times
 * are when a change was observed, not when it occurred, and a state that appears
 * and clears inside one polling interval is missed entirely. Every caller must say
 * so rather than presenting these as chain facts.
 *
 * Kept in localStorage per duel so a page refresh mid-fight does not lose the one
 * copy of a moment that cannot be re-read.
 */
export type { MarginObservation } from '@/lib/marginWatch';

const cacheKey = (duelId: bigint) => `coliseum:marginwatch:v1:${duelId.toString()}`;

/**
 * Watch two fighters' margin status and record every change.
 *
 * @param statuses fighterId → current status, from the poll the page already runs.
 *        A fighter absent from the map is not watched, so a spot fight records
 *        nothing rather than a stream of zeroes.
 */
export function useMarginWatch(
  duelId: bigint,
  statuses: Map<number, number>,
): MarginObservation[] {
  const [seen, setSeen] = useState<MarginObservation[]>([]);
  // The last status recorded per fighter, so only CHANGES are appended. Without
  // this a ten-second poll would write six identical entries a minute.
  const last = useRef<Map<number, number>>(new Map());
  const hydrated = useRef<bigint>(BigInt(0));

  // ── Restore, and reset when the duel changes ──────────────────────────────
  useEffect(() => {
    last.current = new Map();
    hydrated.current = duelId;
    if (typeof window === 'undefined' || duelId <= BigInt(0)) { setSeen([]); return; }
    try {
      const raw = window.localStorage.getItem(cacheKey(duelId));
      const restored = raw ? (JSON.parse(raw) as MarginObservation[]) : [];
      setSeen(restored);
      // Seed the change-detector from what was restored, or the first poll after a
      // refresh would re-record a state that is simply still true.
      for (const o of restored) last.current.set(o.fighterId, o.status);
    } catch {
      setSeen([]);
    }
  }, [duelId]);

  // ── Record changes ────────────────────────────────────────────────────────
  // What counts as NEW lives in lib/marginWatch, which is pure and unit-tested.
  // This effect is only the plumbing: when to ask, and where the answer is kept.
  useEffect(() => {
    if (duelId <= BigInt(0) || hydrated.current !== duelId) return;
    const asRecorded: MarginObservation[] = Array.from(last.current.entries())
      .map(([fighterId, status]) => ({ fighterId, status, seenAt: 0 }));
    const fresh = newObservations(asRecorded, statuses, Math.floor(Date.now() / 1000));
    last.current = settledStatuses(asRecorded, statuses);
    for (const o of fresh) last.current.set(o.fighterId, o.status);
    if (fresh.length === 0) return;
    setSeen((prevSeen) => {
      const next = [...prevSeen, ...fresh];
      try {
        window.localStorage.setItem(cacheKey(duelId), JSON.stringify(next));
      } catch {
        // Quota or private mode — the record still lives in memory for this view.
      }
      return next;
    });
  }, [duelId, statuses]);

  return seen;
}
