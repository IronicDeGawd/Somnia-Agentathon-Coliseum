export type MarginStatusCopy = { word: string; detail: string };

// Maps the on-chain margin status code to the copy shown on a fighter's card.
// Statuses <= 0 are "no warning" and return null — the caller (MarginWarning's
// only render site) already guards on `perp.marginStatus > 0`, but keeping the
// guard here too means this function is safe to call directly without
// re-deriving that rule elsewhere.
// Any status the page does not recognise (not 1, 2, or 3) gets its own honest
// "UNKNOWN STATUS" branch rather than silently falling through to the most
// alarming message (CLOSE-OUT), which would misinform a spectator about what
// is actually happening to a fighter's position.
export const marginStatusCopy = (status: number): MarginStatusCopy | null => {
  if (status <= 0) return null;
  if (status === 1) return { word: 'MARGIN CALL', detail: 'equity has fallen to the maintenance line' };
  if (status === 2) return { word: 'LIQUIDATING', detail: 'the venue is closing part of this position' };
  if (status === 3) return { word: 'CLOSE-OUT', detail: 'the position is being closed out entirely' };
  return { word: 'UNKNOWN STATUS', detail: 'this margin state is not recognised — treat with caution' };
};
