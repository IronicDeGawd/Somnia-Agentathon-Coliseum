// portraits.jsx — ONE Avatar component for all fighter portraits.
// Single source of truth. Imported everywhere. Auto-scales chrome by size.

const FIGHTERS = {
  degen: {
    id: "degen",
    name: "THE DEGEN",
    tagline: "Send it. Always.",
    side: "a",
    color: "var(--fighter-a)",
    hex: "#ff3366",
    style: "Aggressive momentum trader",
    risk: 5, aggression: 5, patience: 1,
    record: { w: 12, l: 8 },
    pnl: 340.5,
    bestRound: { id: 287, pnl: 67.2 },
    worstRound: { id: 310, pnl: -45.0 },
    quote: "Send it.",
    bio: "Born in a Discord trench, raised on perp pumps. The Degen has one philosophy: green candles are bullish, red candles are buying opportunities. Has never met a leverage trade it didn't like.",
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
    color: "var(--fighter-b)",
    hex: "#00d9ff",
    style: "Patient size, conviction trades",
    risk: 2, aggression: 1, patience: 5,
    record: { w: 12, l: 4 },
    pnl: 340.5,
    bestRound: { id: 287, pnl: 67.2 },
    worstRound: { id: 310, pnl: -45.0 },
    quote: "I'll wait for it.",
    bio: "Years on the desk, decades on the chart. The Whale doesn't chase. The Whale lets price come to it, then takes size that moves the book.",
    initials: "WH",
    rank: "A",
    tier: "TACTICIAN",
    seedBottts: "whale-deep-22",
    seedPixel: "whale-pixel-4",
    seedAdventurer: "whale-mage-1",
  },
};

const ROSTER = [
  { id: "whale",      name: "THE WHALE",      record: "12W-4L",  pnl: 340.5, hex: "#00d9ff", seedBottts: "whale-deep-22", initials: "WH", tier: "TACTICIAN", rank: "S" },
  { id: "degen",      name: "THE DEGEN",      record: "9W-7L",   pnl: 120.0, hex: "#ff3366", seedBottts: "degen-fury-9", initials: "DG", tier: "AGGRESSOR", rank: "S" },
  { id: "scalper",    name: "THE SCALPER",    record: "8W-8L",   pnl: 45.0,  hex: "#fcd34d", seedBottts: "scalper-edge-12", initials: "SC", tier: "SCALPER", rank: "A" },
  { id: "reverter",   name: "THE REVERTER",   record: "7W-9L",   pnl: -28.5, hex: "#58e898", seedBottts: "reverter-tide-2", initials: "RV", tier: "ORACLE", rank: "A" },
  { id: "surfer",     name: "THE SURFER",     record: "6W-10L",  pnl: -64.2, hex: "#7af0c6", seedBottts: "surfer-wave-8", initials: "SF", tier: "RIDER", rank: "B" },
  { id: "contrarian", name: "THE CONTRARIAN", record: "5W-11L",  pnl: -110.7, hex: "#b78bff", seedBottts: "contrarian-rev-5", initials: "CN", tier: "REBEL", rank: "B" },
];

// DiceBear (free, open-source) avatar service
const DICEBEAR_STYLES = {
  bottts:     (seed) => `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}&backgroundType=solid&backgroundColor=transparent&radius=0`,
  pixel:      (seed) => `https://api.dicebear.com/9.x/pixel-art-neutral/svg?seed=${encodeURIComponent(seed)}&backgroundColor=transparent&radius=0`,
  adventurer: (seed) => `https://api.dicebear.com/9.x/adventurer-neutral/svg?seed=${encodeURIComponent(seed)}&backgroundColor=transparent&radius=0`,
};
const STYLE_SEED_KEY = { bottts: "seedBottts", pixel: "seedPixel", adventurer: "seedAdventurer" };

// Shield silhouettes (used for ALL avatar sizes — brand consistency)
const FRAME_VARIANTS = {
  shield: { aspect: 260 / 220, clip: "polygon(12.7% 6.2%, 87.3% 6.2%, 96.4% 15.4%, 96.4% 79.2%, 87.3% 90%, 69% 93.8%, 31% 93.8%, 12.7% 90%, 3.6% 79.2%, 3.6% 15.4%)" },
  tarot:  { aspect: 300 / 220, clip: "polygon(7% 4%, 93% 4%, 93% 96%, 7% 96%)" },
  helm:   { aspect: 260 / 220, clip: "polygon(14.5% 10.8%, 85.5% 10.8%, 94.5% 30.8%, 94.5% 69.2%, 79% 89.2%, 21% 89.2%, 5.5% 69.2%, 5.5% 30.8%)" },
};

// ─────────────────────────────────────────────────────────────────────────────
// <Avatar /> — the only avatar component in the app
//
// Props:
//   fighter        Fighter id string ("degen" | "whale" | …) OR a fighter object.
//   size           Pixel width. Aspect ratio is fixed by the frame variant.
//                  Heuristic: <56 hides chrome (rank chip, name banner).
//   state          "idle" | "winning" | "losing" | "victory" | "thinking"
//   variant        "shield" (default) | "tarot" | "helm"
//   showChrome     null (auto by size) | true | false. Force rank chip + banner.
//   className      Optional extra class.
// ─────────────────────────────────────────────────────────────────────────────
function Avatar({
  fighter,
  size = 96,
  state = "idle",
  variant = "shield",
  showChrome = null,
  className = "",
  style = {},
}) {
  // Resolve fighter
  const f = typeof fighter === "string"
    ? (FIGHTERS[fighter] || ROSTER.find(r => r.id === fighter) || FIGHTERS.degen)
    : (fighter || FIGHTERS.degen);
  const c = f.hex || "#ff3366";

  // Frame
  const v = FRAME_VARIANTS[variant] || FRAME_VARIANTS.shield;
  const W = size;
  const H = size * v.aspect;
  const clip = v.clip;

  // Avatar source
  const dbStyle = variant === "tarot" ? "adventurer" : variant === "helm" ? "pixel" : "bottts";
  const seedKey = STYLE_SEED_KEY[dbStyle];
  const seed = f[seedKey] || f.id || "default";
  const avatarUrl = DICEBEAR_STYLES[dbStyle](seed);

  // State derivatives
  const isVictory = state === "victory";
  const isLosing  = state === "losing";
  const isWinning = state === "winning";
  const isThinking = state === "thinking";

  // Show chrome (rank chip + bottom banner) auto-by-size unless overridden
  const chrome = showChrome === null ? size >= 80 : showChrome;
  const showScanlines = size >= 48;

  // Avatar filter (state)
  const avatarFilter =
    isVictory ? `brightness(1.12) saturate(1.25) drop-shadow(0 0 12px ${c})` :
    isWinning ? `brightness(1.06) saturate(1.15)` :
    isLosing  ? `grayscale(0.55) brightness(0.72) opacity(0.7)` :
    "none";

  // Chrome sizes scale with overall
  const rankChipW = Math.max(18, Math.round(size * 0.13));
  const rankChipH = Math.max(14, Math.round(size * 0.1));
  const rankFontSize = Math.max(10, Math.round(size * 0.064));
  const bannerFontSize = Math.max(8, Math.round(size * 0.046));
  const bannerPad = Math.max(2, Math.round(size * 0.015));

  // Inner border thickness scales but stays crisp at small sizes
  const outerBorder = size < 60 ? 1.5 : 2;
  const innerBorderInset = size < 60 ? 3 : 5;

  return (
    <div
      className={className}
      style={{
        width: W, height: H, position: "relative",
        display: "inline-block", flexShrink: 0,
        ...style,
      }}
    >
      {/* OUTER colored shield — the visible primary border */}
      <div style={{
        position: "absolute", inset: 0,
        clipPath: clip,
        background: c,
      }} />

      {/* Frame glow — only when winning/victory */}
      {(isWinning || isVictory) && (
        <div style={{
          position: "absolute", inset: -6,
          clipPath: clip,
          background: c,
          filter: `blur(${isVictory ? 18 : 10}px)`,
          opacity: 0.55,
          pointerEvents: "none",
        }} />
      )}

      {/* Inner stage — inset to reveal the outer color as a border ring */}
      <div style={{
        position: "absolute", inset: outerBorder,
        clipPath: clip,
        background: `
          radial-gradient(circle at 50% 40%, ${c}55, transparent 65%),
          linear-gradient(180deg, ${c}28 0%, ${c}10 55%, rgba(0,0,0,0.35) 100%),
          repeating-linear-gradient(45deg, ${c}22 0px, ${c}22 1px, transparent 1px, transparent 9px),
          var(--bg-stage)
        `,
        opacity: isLosing ? 0.7 : 1,
      }} />

      {/* Avatar image */}
      <div style={{
        position: "absolute",
        left: "8%", right: "8%",
        top: variant === "tarot" ? "6%" : (chrome ? "10%" : "8%"),
        bottom: variant === "tarot" ? "18%" : (chrome ? "20%" : "8%"),
        clipPath: clip,
      }}>
        <img
          src={avatarUrl}
          alt={f.name || f.id || "avatar"}
          style={{
            width: "100%", height: "100%",
            objectFit: "contain",
            display: "block",
            filter: avatarFilter,
          }}
        />
      </div>

      {/* Scanlines — hidden at tiny sizes to keep mini avatars clean */}
      {showScanlines && (
        <div style={{
          position: "absolute", inset: 0,
          clipPath: clip,
          background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)",
          pointerEvents: "none",
          opacity: 0.5,
        }} />
      )}

      {/* Rank chip — only when chrome enabled */}
      {chrome && (
        <div style={{
          position: "absolute",
          left: variant === "tarot" ? "12%" : "9%",
          top: variant === "tarot" ? "7%" : "9%",
          width: rankChipW, height: rankChipH,
          background: c,
          color: "#0a0612",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "Pixelify Sans", fontWeight: 700,
          fontSize: rankFontSize,
          opacity: isLosing ? 0.65 : 1,
        }}>{f.rank || "A"}</div>
      )}

      {/* Bottom name banner — only when chrome enabled */}
      {chrome && (
        <div style={{
          position: "absolute",
          left: "50%", transform: "translateX(-50%)",
          bottom: variant === "tarot" ? "8%" : "9%",
          background: "var(--bg-deep)",
          border: `1px solid ${c}`,
          padding: `${bannerPad}px ${bannerPad * 3}px`,
          fontFamily: "JetBrains Mono",
          fontWeight: 700,
          fontSize: bannerFontSize,
          letterSpacing: "0.16em",
          color: c,
          whiteSpace: "nowrap",
          opacity: isLosing ? 0.7 : 1,
        }}>
          {(f.initials || (f.name || "").slice(0, 2).toUpperCase())}
          {f.tier ? ` · ${f.tier}` : ""}
        </div>
      )}

      {/* THINKING dots */}
      {isThinking && (
        <div style={{
          position: "absolute",
          left: "50%", transform: "translateX(-50%)",
          bottom: "20%",
          display: "flex", gap: 6,
          pointerEvents: "none",
        }}>
          {[0, 1, 2].map(i => (
            <span key={i} style={{
              width: 6, height: 6, borderRadius: "50%",
              background: c,
              animation: `pulse 1.2s ease-in-out infinite ${i * 0.3}s`,
            }} />
          ))}
        </div>
      )}

      {/* Victory stars */}
      {isVictory && (
        <div style={{
          position: "absolute", top: 4, left: 0, right: 0,
          display: "flex", justifyContent: "space-around",
          pointerEvents: "none",
        }}>
          {[0,1,2,3,4].map(i => (
            <span key={i} style={{ fontFamily: "Pixelify Sans", fontSize: 20, color: "var(--gold)" }}>★</span>
          ))}
        </div>
      )}

      {/* Inner accent line — second concentric ring */}
      <div style={{
        position: "absolute", inset: innerBorderInset,
        clipPath: clip,
        boxShadow: `inset 0 0 0 1px ${c}`,
        opacity: 0.9,
        pointerEvents: "none",
      }} />
    </div>
  );
}

// Back-compat aliases — every existing call site keeps working.
// `ShieldPortrait` accepted (fighter, state, size, styleName);
// `MiniPortrait`   accepted (id, color, size).
function ShieldPortrait({ fighter, state, size, styleName, ...rest }) {
  return <Avatar fighter={fighter} state={state} size={size} variant={styleName} {...rest} />;
}
function MiniPortrait({ id, color, size, ...rest }) {
  return <Avatar fighter={id} size={size} variant="shield" {...rest} />;
}

const GLYPHS = {
  degen: "△", whale: "◇", scalper: "✕", reverter: "○", surfer: "≋", contrarian: "▽",
};

Object.assign(window, { FIGHTERS, ROSTER, GLYPHS, Avatar, ShieldPortrait, MiniPortrait, DICEBEAR_STYLES });
