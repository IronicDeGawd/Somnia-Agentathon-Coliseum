export const fmtUsd = (n: number): string => {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
};

export const fmtUsdNoSign = (n: number): string => {
  return `$${Math.abs(n).toFixed(2)}`;
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
