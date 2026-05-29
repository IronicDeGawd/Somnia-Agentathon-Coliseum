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
    hex: "#fcd34d",
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
    hex: "#b78bff",
    color: "#b78bff",
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
  }
};

export const ROSTER = [
  { id: "whale",      name: "THE WHALE",      record: "12W-4L",  pnl: 340.5,  hex: "#00d9ff", seedBottts: "whale-deep-22",     initials: "WH", tier: "TACTICIAN", rank: "S" },
  { id: "degen",      name: "THE DEGEN",      record: "9W-7L",   pnl: 120.0,  hex: "#ff3366", seedBottts: "degen-fury-9",      initials: "DG", tier: "AGGRESSOR", rank: "S" },
  { id: "scalper",    name: "THE SCALPER",    record: "8W-8L",   pnl: 45.0,   hex: "#fcd34d", seedBottts: "scalper-edge-12",   initials: "SC", tier: "SCALPER",   rank: "A" },
  { id: "reverter",   name: "THE REVERTER",   record: "7W-9L",   pnl: -28.5,  hex: "#58e898", seedBottts: "reverter-tide-2",   initials: "RV", tier: "ORACLE",    rank: "A" },
  { id: "surfer",     name: "THE SURFER",     record: "6W-10L",  pnl: -64.2,  hex: "#7af0c6", seedBottts: "surfer-wave-8",     initials: "SF", tier: "RIDER",     rank: "B" },
  { id: "contrarian", name: "THE CONTRARIAN", record: "5W-11L",  pnl: -110.7, hex: "#b78bff", seedBottts: "contrarian-rev-5",  initials: "CN", tier: "REBEL",     rank: "B" },
];

export const GLYPHS: Record<string, string> = { 
  degen: "△", 
  whale: "◇", 
  scalper: "✕", 
  reverter: "○", 
  surfer: "≋", 
  contrarian: "▽" 
};
