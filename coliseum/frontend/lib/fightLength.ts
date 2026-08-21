/**
 * Roughly how long a fight of N rounds takes, in wall-clock minutes.
 *
 * WHY THIS IS A GUESS AND MUST READ LIKE ONE. Nothing schedules a round. A round
 * happens when the caretaker notices a fight is waiting, asks the model for both
 * fighters' moves, and writes them back — and the round only closes once BOTH
 * fighters have moved. So the pace is whatever that loop costs, not a setting.
 *
 * WHERE THE NUMBERS COME FROM. Measured, not assumed: with three fights running
 * at once, each one gained exactly one round across a seventy-five second
 * sample. A fight running alone is quicker than that; six rings busy is slower,
 * because the caretaker advances one fight at a time and they queue behind each
 * other. Fifty to a hundred seconds a round brackets what has actually been
 * seen, so the answer is always a RANGE and always carries a tilde.
 *
 * DELIBERATELY IMPORTS NOTHING, so the test runner can load it directly — it
 * does not resolve the bundler's path aliases.
 */

/** Seconds per round, the fast and slow ends of what has been observed. */
const FAST_SECONDS = 50;
const SLOW_SECONDS = 100;

/** The bracket in whole minutes, low end first. */
export function fightMinutes(turns: number): { low: number; high: number } {
  const round = (s: number) => Math.max(1, Math.round((turns * s) / 60));
  return { low: round(FAST_SECONDS), high: round(SLOW_SECONDS) };
}

/**
 * The same bracket as a label for a card — e.g. `~5–10 MIN`.
 *
 * An en dash, not a hyphen, because a hyphen between two numbers reads as minus.
 * The two ends can never collapse to the same figure — the slow end is twice the
 * fast one, so any fight at all spans at least one minute to two — which is why
 * there is no single-figure form to fall back to.
 */
export function fightLengthLabel(turns: number): string {
  const { low, high } = fightMinutes(turns);
  return `~${low}–${high} MIN`;
}
