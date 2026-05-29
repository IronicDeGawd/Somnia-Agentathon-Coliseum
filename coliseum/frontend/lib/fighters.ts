export interface Fighter {
  id: string;
  name: string;
  tagline: string;
  side: 'a' | 'b';
  hex: string;
  color: string;
  style: string;
  risk: number;
  aggression: number;
  patience: number;
  record: { w: number; l: number };
  pnl: number;
  bestRound: { id: number; pnl: number };
  worstRound: { id: number; pnl: number };
  quote: string;
  bio: string;
  initials: string;
  rank: string;
  tier: string;
  seedBottts: string;
  seedPixel: string;
  seedAdventurer: string;
}

export const FIGHTERS: Record<string, Fighter> = {
  degen: {
    id: "degen",
    name: "THE DEGEN",
    tagline: "Send it. Always.",
    side: "a",
    hex: "#ff3366",
    color: "var(--fighter-a)",
    style: "Aggressive momentum trader",
    risk: 5,
    aggression: 5,
    patience: 1,
    record: { w: 9, l: 7 },
    pnl: 120.0,
    bestRound: { id: 287, pnl: 67.2 },
    worstRound: { id: 310, pnl: -45.0 },
    quote: "Send it.",
    bio: "Born in a Discord trench, raised by liquidity rushes. Knows only one speed: maximum leverage, extreme conviction. If there's volume, there's a way. Never looks back, never hedges.",
    initials: "DG",
    rank: "S",
    tier: "AGGRESSOR",
    seedBottts: "degen-fury-9",
    seedPixel: "degen-arcade-3",
    seedAdventurer: "degen-blade-7",
  },
  whale: {
    id: "whale",
    name: "THE WHALE",
    tagline: "I'll wait for it.",
    side: "b",
    hex: "#00d9ff",
    color: "var(--fighter-b)",
    style: "Patient size, conviction trades",
    risk: 2,
    aggression: 1,
    patience: 5,
    record: { w: 12, l: 4 },
    pnl: 340.5,
    bestRound: { id: 261, pnl: 145.8 },
    worstRound: { id: 301, pnl: -22.5 },
    quote: "I'll wait for it.",
    bio: "Years on institutional desks taught him one thing: patience is the ultimate liquidity. Accumulates quietly, strikes with devastating size. Let the degens burn their gas; he moves only when the order book bends to his conviction.",
    initials: "WH",
    rank: "S",
    tier: "TACTICIAN",
    seedBottts: "whale-deep-22",
    seedPixel: "whale-pixel-4",
    seedAdventurer: "whale-mage-1",
  },
  scalper: {
    id: "scalper",
    name: "THE SCALPER",
    tagline: "Sip the spread.",
    side: "a",
    hex: "#f97316",
    color: "var(--gold)",
    style: "Tight spreads, high frequency",
    risk: 3,
    aggression: 4,
    patience: 2,
    record: { w: 8, l: 8 },
    pnl: 45.0,
    bestRound: { id: 110, pnl: 12.4 },
    worstRound: { id: 98, pnl: -8.1 },
    quote: "Sip the spread.",
    bio: "Feeds on local noise. Lives in the sub-second ticks of the dreamDEX book. He doesn't care about the long trend; he is here to extract one fraction of a cent a thousand times a day.",
    initials: "SC",
    rank: "A",
    tier: "SCALPER",
    seedBottts: "scalper-edge-12",
    seedPixel: "scalper-pixel-2",
    seedAdventurer: "scalper-rogue-4",
  },
  reverter: {
    id: "reverter",
    name: "THE REVERTER",
    tagline: "What goes up...",
    side: "b",
    hex: "#58e898",
    color: "var(--win)",
    style: "Mean-reversion oracle",
    risk: 2,
    aggression: 2,
    patience: 4,
    record: { w: 7, l: 9 },
    pnl: -28.5,
    bestRound: { id: 145, pnl: 28.6 },
    worstRound: { id: 189, pnl: -33.4 },
    quote: "What goes up...",
    bio: "Believes gravity is the only law in trading. Fades every momentum burst, shorts every local peak, buys every waterfall dump. Knows that sooner or later, everything returns to the mean.",
    initials: "RV",
    rank: "A",
    tier: "ORACLE",
    seedBottts: "reverter-tide-2",
    seedPixel: "reverter-pixel-9",
    seedAdventurer: "reverter-cleric-3",
  },
  surfer: {
    id: "surfer",
    name: "THE SURFER",
    tagline: "Ride the wave.",
    side: "a",
    hex: "#7af0c6",
    color: "#7af0c6",
    style: "Trend follower, stops active",
    risk: 4,
    aggression: 3,
    patience: 3,
    record: { w: 6, l: 10 },
    pnl: -64.2,
    bestRound: { id: 201, pnl: 34.0 },
    worstRound: { id: 245, pnl: -40.1 },
    quote: "Ride the wave.",
    bio: "Rides structural waves. Doesn't try to predict the top or bottom; simply aligns with the moving average. Cuts losing trades instantly and lets winners run until the trend flips.",
    initials: "SF",
    rank: "B",
    tier: "RIDER",
    seedBottts: "surfer-wave-8",
    seedPixel: "surfer-pixel-3",
    seedAdventurer: "surfer-bard-1",
  },
  contrarian: {
    id: "contrarian",
    name: "THE CONTRARIAN",
    tagline: "Against the herd.",
    side: "b",
    hex: "#34d399",
    color: "#34d399",
    style: "Sentiment fade",
    risk: 4,
    aggression: 4,
    patience: 3,
    record: { w: 5, l: 11 },
    pnl: -110.7,
    bestRound: { id: 99, pnl: 44.5 },
    worstRound: { id: 123, pnl: -55.8 },
    quote: "Against the herd.",
    bio: "Loves to be hated. The more bullish the sentiment, the harder he sells. The deeper the panic, the heavier he buys. Finds ultimate comfort in going completely opposite of public consensus.",
    initials: "CN",
    rank: "B",
    tier: "REBEL",
    seedBottts: "contrarian-rev-5",
    seedPixel: "contrarian-pixel-5",
    seedAdventurer: "contrarian-warrior-2",
  },
  quant: {
    id: "quant",
    name: "THE QUANT",
    tagline: "Mean reversion or nothing.",
    side: "a",
    hex: "#a78bfa",
    color: "#a78bfa",
    style: "Statistical mean-reversion",
    risk: 2,
    aggression: 1,
    patience: 5,
    record: { w: 0, l: 0 },
    pnl: 0,
    bestRound: { id: 0, pnl: 0 },
    worstRound: { id: 0, pnl: 0 },
    quote: "The model is always right.",
    bio: "Trained on decades of order book data. Never trades on instinct — only on statistical edges. Waits for z-score deviations and fires with surgical precision when the model signals a reversion.",
    initials: "QT",
    rank: "A",
    tier: "ANALYST",
    seedBottts: "quant-model-1",
    seedPixel: "quant-pixel-1",
    seedAdventurer: "quant-mage-1",
  },
  diamond: {
    id: "diamond",
    name: "THE DIAMOND HAND",
    tagline: "Never sell. Buy the dip.",
    side: "b",
    hex: "#fcd34d",
    color: "#fcd34d",
    style: "Long-only accumulator",
    risk: 3,
    aggression: 1,
    patience: 5,
    record: { w: 0, l: 0 },
    pnl: 0,
    bestRound: { id: 0, pnl: 0 },
    worstRound: { id: 0, pnl: 0 },
    quote: "Never sell.",
    bio: "Accumulates through every drawdown. Selling is not in the vocabulary. Every dip is an opportunity to increase the position. Conviction so deep it borders on religion.",
    initials: "DH",
    rank: "A",
    tier: "HOLDER",
    seedBottts: "diamond-hold-1",
    seedPixel: "diamond-pixel-1",
    seedAdventurer: "diamond-paladin-1",
  },
};

export const ROSTER = [
  { id: "whale",      name: "THE WHALE",      record: "12W-4L",  pnl: 340.5,  hex: "#00d9ff", seedBottts: "whale-deep-22",     initials: "WH", tier: "TACTICIAN", rank: "S" },
  { id: "degen",      name: "THE DEGEN",      record: "9W-7L",   pnl: 120.0,  hex: "#ff3366", seedBottts: "degen-fury-9",      initials: "DG", tier: "AGGRESSOR", rank: "S" },
  { id: "scalper",    name: "THE SCALPER",    record: "8W-8L",   pnl: 45.0,   hex: "#f97316", seedBottts: "scalper-edge-12",   initials: "SC", tier: "SCALPER",   rank: "A" },
  { id: "reverter",   name: "THE REVERTER",   record: "7W-9L",   pnl: -28.5,  hex: "#58e898", seedBottts: "reverter-tide-2",   initials: "RV", tier: "ORACLE",    rank: "A" },
  { id: "surfer",     name: "THE SURFER",     record: "6W-10L",  pnl: -64.2,  hex: "#7af0c6", seedBottts: "surfer-wave-8",     initials: "SF", tier: "RIDER",     rank: "B" },
  { id: "contrarian", name: "THE CONTRARIAN", record: "5W-11L",  pnl: -110.7, hex: "#34d399", seedBottts: "contrarian-rev-5",  initials: "CN", tier: "REBEL",     rank: "B" },
];

export const GLYPHS: Record<string, string> = {
  degen: "△",
  whale: "◇",
  scalper: "✕",
  reverter: "○",
  surfer: "≋",
  contrarian: "▽",
  quant: "∑",
  diamond: "◆",
};

// Maps FighterRegistry contract indexes (0-5) to UI visual properties.
// Registry order: 0=Degen, 1=Whale, 2=Quant, 3=DiamondHand, 4=Scalper, 5=Contrarian
export interface FighterVisual {
  id: string;
  hex: string;
  side: 'a' | 'b';
  bgClass: string;
}

export const FIGHTER_VISUAL_MAP: Record<number, FighterVisual> = {
  0: { id: 'degen',      hex: '#ff3366', side: 'a', bgClass: 'bg-fighter-a' },
  1: { id: 'whale',      hex: '#00d9ff', side: 'b', bgClass: 'bg-fighter-b' },
  2: { id: 'quant',      hex: '#a78bfa', side: 'a', bgClass: 'bg-purple-400' },
  3: { id: 'diamond',    hex: '#fcd34d', side: 'b', bgClass: 'bg-yellow-300' },
  4: { id: 'scalper',    hex: '#f97316', side: 'a', bgClass: 'bg-orange-500' },
  5: { id: 'contrarian', hex: '#34d399', side: 'b', bgClass: 'bg-emerald-400' },
};

// Maps a contract uint8 fighter index to the design string ID.
export function fighterIndexToId(index: number): string {
  return FIGHTER_VISUAL_MAP[index]?.id ?? 'degen';
}

// Maps a design string ID back to the contract uint8 fighter index.
// Returns -1 if not found.
export function fighterIdToIndex(id: string): number {
  const entry = Object.entries(FIGHTER_VISUAL_MAP).find(([, v]) => v.id === id);
  return entry ? Number(entry[0]) : -1;
}
