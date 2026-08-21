import { formatUnits } from 'viem';

/**
 * How much of a number to show.
 *
 * THE RULE IS "ENOUGH DIGITS TO SEE IT", NOT A FIXED TWO, and it was learned the
 * hard way. Duel 74 was won by 0.000000800524579414 — at two decimals both
 * fighters printed $0.03 and the difference between them printed as zero, so a
 * correct result read as a draw the arena had botched. It had not: a draw here
 * means equal to the wei, and these were not equal.
 *
 * So the width follows the magnitude — widen until the number stops rounding away,
 * and never let something non-zero print as nothing. Below the last step, say so
 * in words rather than lying with a zero.
 *
 * This ladder used to live in the settlement panel alone, which is why duel 74
 * stayed half-fixed: the settlement card showed the difference while the two big
 * figures at the top of the same page still rounded it away. One rule now, so a
 * fix reaches every place a number is shown.
 */
const STEPS = [2, 4, 6, 8] as const;

const widthFor = (abs: number): number | null => {
  for (const d of STEPS) if (abs >= 0.5 / 10 ** d) return d;
  return null;
};

/** The number at whatever width shows it, unsigned, no currency mark. */
export const fmtAmount = (n: number): string => {
  if (n === 0) return '0.00';
  const d = widthFor(Math.abs(n));
  if (d === null) return n > 0 ? '<0.00000001' : '>-0.00000001';
  return n.toFixed(d);
};

/** A signed figure, for a change: `+$1.20`, `-$0.0004`. */
export const fmtUsd = (n: number): string => {
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  const abs = Math.abs(n);
  const d = widthFor(abs);
  if (d === null) return `${sign}$0.00`;
  return `${sign}$${abs.toFixed(d)}`;
};

/** A quantity, not a change — so no leading sign. */
export const fmtUsdNoSign = (n: number): string => {
  const abs = Math.abs(n);
  const d = widthFor(abs);
  if (d === null) return abs > 0 ? '$<0.00000001' : '$0.00';
  return `$${abs.toFixed(d)}`;
};

/** A wei-denominated balance as money. The chain speaks in 18 decimals. */
export const fmtUsdsoRaw = (raw: bigint): string =>
  fmtUsdNoSign(Number(formatUnits(raw, 18)));

/** The same, without the currency mark, for a line that names the unit itself. */
export const fmtAmountRaw = (raw: bigint): string =>
  fmtAmount(Number(formatUnits(raw, 18)));

/**
 * The number exactly as the chain holds it, trailing zeros trimmed and nothing
 * rounded.
 *
 * FOR THE ONE LINE THAT JUSTIFIES A RESULT, and nowhere else. A scoreboard being
 * scanned should round — eighteen decimals in a table is unreadable. But where the
 * page is making the case for who won, the evidence does not round.
 */
export const fmtExactRaw = (raw: bigint): string => {
  const s = formatUnits(raw, 18);
  if (!s.includes('.')) return `${s}.00`;
  const trimmed = s.replace(/0+$/, '');
  const [whole, frac = ''] = trimmed.split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
};

export const fmtPct = (n: number): string => {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
};

export const fmtTime = (s: number): string => {
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};
