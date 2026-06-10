// Adaptive precision: sub-cent (but non-zero) values show 4 decimals so they
// don't all collapse to "0.00"; everything else stays at 2 decimals.
const usdDecimals = (abs: number): number => (abs > 0 && abs < 0.01 ? 4 : 2);

export const fmtUsd = (n: number): string => {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(usdDecimals(abs))}`;
};

export const fmtUsdNoSign = (n: number): string => {
  const abs = Math.abs(n);
  return `$${abs.toFixed(usdDecimals(abs))}`;
};

export const fmtPct = (n: number): string => {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
};

export const fmtTime = (s: number): string => {
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};
