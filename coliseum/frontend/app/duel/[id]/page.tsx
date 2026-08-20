'use client';

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { formatUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { CONTRACT_ADDRESSES, ABIS, DRAW_SLOT } from '@/lib/contracts';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { OddsBar } from '@/components/shared/OddsBar';
import { AnimatedNumber } from '@/components/shared/AnimatedNumber';
import { BracketButton, Chip, Dot } from '@/components/shared/OtherHUD';
import BetPanel from '@/components/shared/BetPanel';
import { RoundClock } from '@/components/shared/RoundClock';
import { ThinkingTicker } from '@/components/shared/ThinkingTicker';
import { useUIStore } from '@/store/ui';
import { useDuelState } from '@/hooks/useDuelState';
import { useDuelLive } from '@/hooks/useDuelLive';
import { useDuelTranscript, type TranscriptEntry } from '@/hooks/useDuelTranscript';
import { useMarginWatch, type MarginObservation } from '@/hooks/useMarginWatch';
import { useLiquidations } from '@/hooks/useLiquidations';
import { liquidationWord, type LiquidationRecord } from '@/lib/liquidations';
import { clockOf } from '@/lib/blockTime';
import { newestFirst } from '@/lib/timelineOrder';
import type { FighterPerp } from '@/hooks/useDuelLive';
import { useFighters } from '@/hooks/useFighters';
import { FIGHTERS, FIGHTER_VISUAL_MAP as ROSTER_VISUALS } from '@/lib/fighters';
import { fmtUsd, fmtPct } from '@/lib/format';
import { marginStatusCopy } from '@/lib/marginStatus';

type Layout = 'split' | 'oneUp' | 'stacked';

interface Holding {
  token: string;
  amount: string | number;
  pct?: number;
  /** Plain-words explanation, shown on hover and to a screen reader. */
  hint?: string;
}

/**
 * What this page shows for each fighter index, beyond the roster itself.
 *
 * THE COLOUR IS NOT REPEATED HERE. It used to be — all six, as raw hex, which is
 * the same list that also lived in the roster file, the duel card and the
 * creator. Four copies of a colour is four places to change it and three of them
 * get forgotten. The ring name, rank and fallback portrait stay local because
 * they are this page's own wording and differ from the roster's on purpose.
 */
const RING_IDENTITY: Record<number, {
  side: 'a' | 'b';
  tier: string;
  rank: string;
  fallbackId: string;
}> = {
  0: { side: 'a', tier: 'AGGRESSOR', rank: 'S', fallbackId: 'degen' },
  1: { side: 'b', tier: 'TACTICIAN', rank: 'S', fallbackId: 'whale' },
  2: { side: 'a', tier: 'QUANT',     rank: 'A', fallbackId: 'quant' },
  3: { side: 'b', tier: 'HOLDER',    rank: 'A', fallbackId: 'diamond' },
  4: { side: 'a', tier: 'SCALPER',   rank: 'A', fallbackId: 'scalper' },
  5: { side: 'b', tier: 'REBEL',     rank: 'B', fallbackId: 'contrarian' },
};

/** Ring identity plus the roster's colour, which is the one that owns it. */
const visualOf = (index: number) => {
  const ring = RING_IDENTITY[index];
  if (!ring) return { hex: 'var(--text)', side: 'a' as const, tier: 'FIGHTER', rank: 'A', fallbackId: 'degen' };
  return { ...ring, hex: ROSTER_VISUALS[index]?.hex ?? 'var(--text)' };
};

const RIBBON = ({ hex, side, tier, rank, winning }: { hex: string; side: 'a' | 'b'; tier: string; rank: string; winning: boolean | null }) => {
  const isRight = side === 'b';
  // winning===null means tied — show no win/loss badge.
  const chipVariant = winning === true ? 'win' : winning === false ? 'loss' : ('neutral' as 'win' | 'loss' | 'neutral');
  return (
    <div
      className="row ai-c jc-sb"
      style={{
        padding: '8px 12px',
        background: `linear-gradient(${isRight ? 270 : 90}deg, ${hex}26, transparent 70%)`,
        borderBottom: `1px solid ${hex}55`,
      }}
    >
      <div className="row gap-8 ai-c">
        <span
          style={{
            width: 22, height: 22, background: hex, color: '#0a0612',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--fnt-display)', fontWeight: 700, fontSize: 14,
          }}
        >{rank}</span>
        <span className="t-display t-up" style={{ fontSize: 13, color: hex, letterSpacing: '0.18em', whiteSpace: 'nowrap' }}>
          FIGHTER {isRight ? 'B' : 'A'}
        </span>
      </div>
      {winning === null ? (
        <Chip variant="loss">
          <Dot variant="loss" />
          EVEN
        </Chip>
      ) : (
        <Chip variant={chipVariant === 'neutral' ? 'loss' : chipVariant}>
          <Dot variant={winning ? 'win' : 'loss'} pulse />
          {winning ? 'WINNING' : 'LOSING'}
        </Chip>
      )}
    </div>
  );
};

/**
 * A label that explains itself on hover, without the browser's help.
 *
 * The native `title` attribute was the first attempt and it is wrong twice over: it
 * drags a question-mark cursor across the text, and it waits about a second before
 * saying anything, by which time the pointer has usually moved on. Neither is
 * something a page can style away.
 *
 * So the tip is drawn here: instant, in the HUD's own colours, and reachable by
 * keyboard because the trigger takes focus. `role="tooltip"` with `aria-describedby`
 * means a screen reader announces the explanation as part of the label rather than as
 * a stray sentence floating nearby.
 *
 * No underline and no special cursor: the row is information, not a control, and
 * decorating every label with a dotted line made a holdings panel look like a form.
 */
function InfoTip({ id, text, children }: { id: string; text: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', minWidth: 0 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          id={id}
          role="tooltip"
          className="t-mono t-xs"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            zIndex: 40,
            width: 260,
            maxWidth: '70vw',
            padding: '8px 10px',
            background: 'var(--bg-stage)',
            border: '1px solid var(--border)',
            color: 'var(--text-dim)',
            lineHeight: 1.5,
            // The tip must never eat the pointer, or moving toward it would
            // re-trigger the leave handler and make it flicker.
            pointerEvents: 'none',
            whiteSpace: 'normal',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

function HoldingsBlock({ holdings, color }: { holdings: Holding[]; color: string }) {
  const totals = holdings.map((h) => {
    const num = typeof h.amount === 'number' ? h.amount : parseFloat(String(h.amount).replace(/[^0-9.-]/g, '')) || 0;
    return num;
  });
  const max = Math.max(...totals, 1);
  return (
    <div className="col gap-6">
      <span className="label-tiny">HOLDINGS</span>
      <div className="col gap-6">
        {holdings.map((h, i) => (
          // Keyed by position as well as name: the rows used to share a key when
          // several were called the same thing, which React cannot tell apart.
          <div key={`${h.token}-${i}`} className="col gap-2">
            <div className="row jc-sb ai-c" style={{ gap: 12 }}>
              <span className="row gap-8 ai-c" style={{ minWidth: 0 }}>
                <span style={{ width: 6, height: 6, background: color, display: 'inline-block', boxShadow: `0 0 6px ${color}`, flexShrink: 0 }} />
                {h.hint ? (
                  <InfoTip id={`hold-${i}-${h.token.replace(/\s+/g, '-')}`} text={h.hint}>
                    <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>
                      {h.token}
                    </span>
                  </InfoTip>
                ) : (
                  <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>
                    {h.token}
                  </span>
                )}
              </span>
              <span className="t-num t-sm" style={{ whiteSpace: 'nowrap' }}>{h.amount}</span>
            </div>
            <div style={{ height: 2, background: 'var(--bg-card-2)', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: 0, width: `${(totals[i] / max) * 100}%`, background: color, opacity: 0.7 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A move, with its direction visible at a glance.
 *
 * Every move reads as a direction and a market — LONG ETH, SELL WBTC, DROP BTCUP —
 * and the direction is the part a spectator is actually scanning for. Rendered as
 * one flat string it is a wall of identical text, and on perps in particular a
 * long and a short look the same until you read the word. So the first word is
 * coloured by which way the fighter went, and the market keeps the ordinary
 * weight.
 */
/**
 * One fighter's fight, in its own corner's colour.
 *
 * WHY PER FIGHTER RATHER THAN ONE INTERLEAVED LIST. The panel above it already
 * divides the fight into two corners, red on the left and blue on the right, and a
 * spectator reads it that way. A single merged list fought that: every row had to
 * carry a name to say whose it was, the eye zig-zagged to follow one fighter, and
 * the colour of a row was decoration rather than structure.
 *
 * Split into columns the name becomes redundant — the column IS the fighter — so
 * each row is just when, which round, and what it did. Reading one agent's whole
 * campaign is now a straight line down, and comparing the two is a glance across.
 *
 * Times come from the block each move was mined in, asked of the chain rather than
 * calculated from a nominal block interval: a fight can stall between rounds, and
 * an invented clock would show a cadence that never happened.
 *
 * MARGIN SIGHTINGS AND LIQUIDATIONS LAND IN THE FIGHTER THEY BELONG TO, and they
 * are different kinds of fact from the moves around them. A move is a permanent
 * on-chain event. A margin state is a live reading that nothing records, on an
 * account whose link to its fighter is deleted at the final bell — so it can only
 * ever be something a page that was open happened to witness. A liquidation, by
 * contrast, is an act the venue performs and records, so it can be read back for
 * any fight however old. The rows say which is which.
 */
function FighterTimeline({
  fighterId,
  side,
  story,
  marginSeen,
  liquidations,
  latestShown,
}: {
  fighterId: number;
  side: 'a' | 'b';
  story: TranscriptEntry[];
  marginSeen: MarginObservation[];
  liquidations: LiquidationRecord[];
  /**
   * The move the card above is currently displaying, or '' when it is showing a
   * thinking ticker instead.
   *
   * Without this the newest move appears twice — once as "ACTED · BUY WETH" and
   * again as the first line of EARLIER — which reads as the fighter having done it
   * twice. "Earlier" has to mean earlier.
   *
   * MATCHED, not merely counted. The card is fed by the live websocket and updates
   * the instant a move lands; the history is re-read from the chain once per turn.
   * So for up to a minute the card can be showing a move the history has not caught
   * up to — and blindly dropping the history's last row would then delete a
   * DIFFERENT, older move from the record for that whole minute.
   */
  latestShown: string;
}) {
  type Row =
    | { kind: 'move'; at?: number; e: TranscriptEntry }
    | { kind: 'margin'; at: number; o: MarginObservation }
    | { kind: 'liq'; at?: number; r: LiquidationRecord };

  // This fighter's moves, newest last. Drop the newest only when it is the very
  // move the card above is showing.
  const mine = story.filter((e) => e.fighterId === fighterId);
  const newest = mine[mine.length - 1];
  const earlier = latestShown && newest && !newest.failed && newest.action === latestShown
    ? mine.slice(0, -1)
    : mine;

  const unordered: Row[] = [
    ...earlier.map((e) => ({ kind: 'move' as const, at: e.timestamp, e })),
    ...marginSeen.filter((o) => o.fighterId === fighterId).map((o) => ({
      kind: 'margin' as const, at: o.seenAt, o,
    })),
    ...liquidations.filter((r) => r.fighterId === fighterId).map((r) => ({
      kind: 'liq' as const, at: r.timestamp, r,
    })),
  ];

  // Newest first: a live fight's next line is the one a spectator is waiting for,
  // and it should not require scrolling to a bottom that keeps moving.
  //
  // The ordering lives in its own tested file because it is not the one-line sort
  // it looks like: a chain event knows its BLOCK from the moment it lands but may
  // never learn its clock, while a margin sighting only ever knows a clock. The
  // first version compared the two directly, which put any move still waiting for
  // its timestamp underneath every move that had one.
  const rows = newestFirst(unordered, (r) =>
    r.kind === 'margin'
      ? { seenAt: r.o.seenAt }
      : r.kind === 'move'
        ? { block: r.e.block, timestamp: r.e.timestamp }
        : { block: r.r.block, timestamp: r.r.timestamp },
  );

  if (rows.length === 0) {
    return (
      <div className="t-mono t-sm t-dim" style={{ padding: '10px 14px' }}>
        {'> '}<span style={{ opacity: 0.5 }}>Nothing recorded yet</span>
      </div>
    );
  }

  return (
    <div className="col gap-2" style={{ maxHeight: 320, overflowY: 'auto', minWidth: 0 }}>
      {rows.map((r) => (
        <div
          // IDENTIFIED BY WHAT THE ROW IS, never by where it sits in the list.
          // The keys used to include the array index, and the list is ordered
          // newest-first — so one new move renumbered every row beneath it and
          // the browser rebuilt the whole history. A spectator scrolled back a
          // few rounds was thrown to the top each time a fighter acted.
          key={
            r.kind === 'move' ? `m-${r.e.round}-${r.e.block}-${r.e.failed ? 'x' : 'o'}`
              : r.kind === 'liq' ? `l-${r.r.block}-${r.r.stage}`
              : `g-${r.o.seenAt}-${r.o.status}`
          }
          className={`row ai-c t-mono t-sm tint-${side}`}
          // The same treatment as the corner card this sits under: a bar in the
          // fighter's colour and a wash of it behind, so the column reads as one
          // object rather than a table that happens to be nearby. The wash is a
          // design-layer class rather than an inline gradient because it also has
          // to lift the faint text tier — see `.tint-a` for the measurements.
          style={{ gap: 12, padding: '7px 14px', minWidth: 0 }}
        >
          <span className="t-num t-xs t-faint" style={{ width: 62, flexShrink: 0 }}>
            {clockOf(r.at)}
          </span>
          <span className="label-tiny" style={{ width: 26, flexShrink: 0 }}>
            {r.kind === 'move' ? `R${r.e.round}` : ''}
          </span>
          {r.kind === 'move' ? (
            r.e.failed ? (
              <span className="t-dim" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {'> '}refused — {r.e.reason || 'no reason given'}
              </span>
            ) : (
              <MoveText move={r.e.action ?? 'HOLD'} />
            )
          ) : r.kind === 'liq' ? (
            <LiquidationRow record={r.r} />
          ) : (
            <MarginLine status={r.o.status} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A liquidation, which is a CHAIN FACT rather than a sighting — marked so, because
 * the line above it might only be something a browser happened to see.
 *
 * Shows the status the venue found BEFORE it acted: "it found this account in
 * close-out and did something about it". The after-status is usually healthy, which
 * is true and useless as a headline.
 */
function LiquidationRow({ record }: { record: LiquidationRecord }) {
  const before = marginStatusCopy(record.statusBefore);
  return (
    <span style={{ color: 'var(--loss)', minWidth: 0 }}>
      <span aria-hidden="true">⚡ </span>{liquidationWord(record)}
      {before && <span className="t-dim"> · was {before.word.toLowerCase()}</span>}
      <span className="t-faint t-xs"> · on-chain</span>
    </span>
  );
}

/** One margin sighting, in the same words the fighter's card uses. */
function MarginLine({ status }: { status: number }) {
  if (status === 0) {
    return (
      <span style={{ color: 'var(--win)' }}>
        <span aria-hidden="true">✓ </span>RECOVERED<span className="t-faint t-xs"> · seen</span>
      </span>
    );
  }
  const copy = marginStatusCopy(status);
  return (
    <span style={{ color: 'var(--loss)' }}>
      <span aria-hidden="true">⚠ </span>{copy?.word ?? 'UNKNOWN STATUS'}
      <span className="t-faint t-xs"> · seen</span>
    </span>
  );
}

function MoveText({ move }: { move: string }) {
  const [word, ...rest] = move.split(' ');
  const up = word === 'LONG' || word === 'BUY' || word === 'BACK';
  const down = word === 'SHORT' || word === 'SELL' || word === 'DROP';
  return (
    <span>
      <span className="t-dim">{'> '}</span>
      <span style={{ color: up ? 'var(--win)' : down ? 'var(--loss)' : 'var(--text-dim)' }}>{word}</span>
      {rest.length > 0 && ` ${rest.join(' ')}`}
    </span>
  );
}

/**
 * What a perps fighter is holding, which is not the same question as what a spot
 * fighter is holding.
 *
 * A spot fighter owns tokens, so a quantity and a bar say everything. A perps
 * fighter owns nothing — it has posted margin for exposure — so the row has to
 * carry a DIRECTION, the price it got in at, the price now, and what the gap
 * between them is currently worth. A bar chart of quantities would say nothing at
 * all here, and a short would not even appear on one.
 */
function PositionsBlock({ perp, color }: { perp: FighterPerp; color: string }) {
  const fmtPrice = (v: bigint) => {
    const n = Number(formatUnits(v, 18));
    return n === 0 ? '—' : n.toLocaleString(undefined, {
      minimumFractionDigits: n < 10 ? 4 : 2,
      maximumFractionDigits: n < 10 ? 4 : 2,
    });
  };

  return (
    <div className="col gap-6">
      <span className="label-tiny">POSITIONS</span>
      {perp.positions.length === 0 ? (
        <span className="t-mono t-xs t-dim">FLAT — no market entered</span>
      ) : (
        <div className="col gap-6">
          {perp.positions.map((p) => {
            const long = p.size > BigInt(0);
            const unit = BigInt(10) ** BigInt(p.baseDecimals);
            // Unrealised is the gap between the entry and the mark across the
            // position, and the signed size carries the direction — so a short
            // gaining as the price falls needs no separate branch.
            const unrealised = p.markPrice > BigInt(0)
              ? (p.size * (p.markPrice - p.entryPrice)) / unit
              : BigInt(0);
            const up = unrealised >= BigInt(0);
            const qty = Number(formatUnits(p.size < BigInt(0) ? -p.size : p.size, p.baseDecimals));
            return (
              <div key={p.poolAddress} className="col gap-2">
                <div className="row jc-sb ai-c" style={{ gap: 12 }}>
                  <span className="row gap-8 ai-c" style={{ minWidth: 0 }}>
                    <span
                      className="t-mono t-xs"
                      style={{
                        color: long ? 'var(--win)' : 'var(--loss)',
                        border: `1px solid ${long ? 'var(--win)' : 'var(--loss)'}`,
                        padding: '0 4px',
                        flexShrink: 0,
                      }}
                    >
                      {long ? 'LONG' : 'SHORT'}
                    </span>
                    <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>{p.market}</span>
                  </span>
                  <span className="t-num t-sm" style={{ whiteSpace: 'nowrap' }}>
                    {qty.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </span>
                </div>
                <div className="row jc-sb ai-c t-mono t-xs t-dim" style={{ gap: 12 }}>
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {fmtPrice(p.entryPrice)} → {fmtPrice(p.markPrice)}
                  </span>
                  <span
                    className="t-num"
                    style={{ color: up ? 'var(--win)' : 'var(--loss)', whiteSpace: 'nowrap' }}
                  >
                    {/* fmtUsd carries its own sign, so prefixing one here printed
                        "-+$0.0010" on the first live position ever rendered. */}
                    {fmtUsd(Number(formatUnits(unrealised, 18)))}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="row jc-sb ai-c" style={{ gap: 12, marginTop: 2 }}>
        <span className="label-tiny">EQUITY</span>
        <span className="t-num t-sm" style={{ color, whiteSpace: 'nowrap' }}>
          {fmtUsd(Number(formatUnits(perp.live ? perp.equity : perp.snapshot, 18)))}
          {!perp.live && <span className="t-mono t-xs t-dim"> (last known)</span>}
        </span>
      </div>
      {perp.marginStatus > 0 && <MarginWarning status={perp.marginStatus} />}
    </div>
  );
}

/**
 * A fighter in trouble. Deliberately loud: a margin call is the most dramatic
 * thing that can happen in a perps fight, and a spectator who cannot see it
 * reads a fighter being wiped out as the page having broken.
 */
function MarginWarning({ status }: { status: number }) {
  const copy = marginStatusCopy(status);
  if (!copy) return null;
  const { word, detail } = copy;
  return (
    <div
      className="col gap-2"
      // Announced, because this appears mid-fight without any user action and it is
      // the most consequential thing that can happen to a fighter. A spectator who
      // cannot see the card would otherwise be told nothing at all.
      role="status"
      aria-live="polite"
      style={{ border: '1px solid var(--loss)', padding: '4px 6px', marginTop: 4 }}
    >
      <span className="t-mono t-xs" style={{ color: 'var(--loss)', letterSpacing: '0.12em' }}>
        <span aria-hidden="true">⚠ </span>{word}
      </span>
      <span className="t-mono t-xs t-dim">{detail}</span>
    </div>
  );
}

function FighterCardSplit({
  fighter,
  pnl,
  holdings,
  perp,
  layout,
  winningVsOpponent,
}: {
  fighter: { id: string; name: string; hex: string; side: 'a' | 'b'; tier: string; tagline: string; rank: string };
  pnl: number;
  holdings: Holding[];
  /** Set on a perps fight, and then it replaces the holdings list entirely. */
  perp?: FighterPerp;
  layout: Layout;
  winningVsOpponent: boolean | null;
}) {
  const winning = winningVsOpponent;
  const { hex, side, name, tier, tagline, rank } = fighter;
  const portraitSize = layout === 'oneUp' ? 220 : layout === 'stacked' ? 100 : 160;

  const avatarState = winning === true ? 'winning' : 'losing';
  const pnlColor = winning === true ? 'var(--win)' : winning === false ? 'var(--loss)' : 'var(--text-dim)';

  if (layout === 'stacked') {
    return (
      <div
        className={`card ${winning === true ? `glow-${side}` : ''}`}
        style={{ border: `1px solid ${hex}`, overflow: 'hidden', transition: 'box-shadow 600ms ease' }}
      >
        <RIBBON hex={hex} side={side} tier={tier} rank={rank} winning={winning} />
        <div className="row gap-16 ai-s" style={{ padding: 16 }}>
          <FighterAvatar fighter={fighter.id} context="arena" size={portraitSize} state={avatarState} />
          <div className="col gap-8 grow" style={{ minWidth: 0 }}>
            <div className="row jc-sb ai-c">
              <span className="t-display t-up" style={{ fontSize: 18, color: hex, letterSpacing: '0.12em', whiteSpace: 'nowrap' }}>{name}</span>
              <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>&ldquo;{tagline}&rdquo;</span>
            </div>
            <div className="row gap-16 ai-c">
              <div className="col gap-2">
                <span className="label-tiny">PNL</span>
                <span className="t-num" style={{ fontSize: 26, lineHeight: 1, color: pnlColor, whiteSpace: 'nowrap' }}>
                  <AnimatedNumber value={pnl} formatter={fmtUsd} duration={500} />
                </span>
              </div>
            </div>
            {perp
              ? <PositionsBlock perp={perp} color={hex} />
              : holdings.length > 0 && <HoldingsBlock holdings={holdings} color={hex} />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`card ${winning === true ? `glow-${side}` : ''}`}
      style={{ border: `1px solid ${hex}`, overflow: 'hidden', transition: 'box-shadow 600ms ease' }}
    >
      <RIBBON hex={hex} side={side} tier={tier} rank={rank} winning={winning} />
      <div className="col" style={{ padding: 20, gap: 14 }}>
        <div className="row ai-s gap-16">
          <div style={{ flexShrink: 0 }}>
            <FighterAvatar fighter={fighter.id} context="arena" size={portraitSize} state={avatarState} />
          </div>
          <div className="col gap-8 grow" style={{ minWidth: 0 }}>
            <div className="col gap-2">
              <span className="t-display t-up" style={{ fontSize: layout === 'oneUp' ? 24 : 20, color: hex, letterSpacing: '0.12em', lineHeight: 1.1, whiteSpace: 'nowrap' }}>{name}</span>
              <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>&ldquo;{tagline}&rdquo;</span>
            </div>
            <div className="col gap-2">
              <span className="label-tiny">ROUND PNL</span>
              <span className="t-num" style={{ fontSize: layout === 'oneUp' ? 40 : 32, lineHeight: 1, color: pnlColor, whiteSpace: 'nowrap' }}>
                <AnimatedNumber value={pnl} formatter={fmtUsd} duration={500} />
              </span>
            </div>
          </div>
        </div>

        {(perp || holdings.length > 0) && (
          <>
            <hr className="divider" />
            {perp
              ? <PositionsBlock perp={perp} color={hex} />
              : <HoldingsBlock holdings={holdings} color={hex} />}
          </>
        )}
      </div>
    </div>
  );
}

export default function ArenaPage() {
  const params = useParams();
  const router = useRouter();
  const layout = useUIStore((state) => state.layout) as Layout;

  // Parse duel ID from URL params
  const rawId = params?.id;
  const duelIdNum = rawId ? Number(rawId) : 0;
  const duelId = BigInt(duelIdNum > 0 ? duelIdNum : 0) as bigint;

  // ── Chain state ──────────────────────────────────────────────────────────────
  const {
    duel,
    odds,
    totalBetsA,
    totalBetsB,
    currentTurn,
    isActive,
    isResolved,
    winnerSlot,
    isLoading,
    error: duelError,
    refetch,
  } = useDuelState(duelId);

  // ── Live on-chain portfolio data ──────────────────────────────────────────
  const { fighterA: liveA, fighterB: liveB, markets, slots } = useDuelLive(duelId, duel);

  // ── The fight's whole story, not just its latest line ─────────────────────
  //
  // The same hook the result page uses, on the live page too. It reads every move
  // and every refusal over the fight's own block span and orders them, so a
  // spectator arriving in round nine sees what happened in rounds one to eight
  // instead of two lines reading "HOLD".
  //
  // Re-runs when `lastTurnBlock` changes, which is once per turn — exactly when
  // there are new moves to find. The live websocket feed still drives the fighter
  // cards, so nothing here delays "DECIDING…" appearing.
  const { entries: story } = useDuelTranscript(
    duelId, duel?.startBlock, duel?.turns, duel?.lastTurnBlock, slots,
  );

  // ── Margin states, kept because nothing else keeps them ───────────────────
  const marginStatuses = useMemo(() => {
    const m = new Map<number, number>();
    if (duel && liveA.perp) m.set(duel.fighterA, liveA.perp.marginStatus);
    if (duel && liveB.perp) m.set(duel.fighterB, liveB.perp.marginStatus);
    return m;
  }, [liveA.perp, liveB.perp, duel]);
  const marginSeen = useMarginWatch(duelId, marginStatuses);

  // What the venue actually DID — the permanent half of the margin story, readable
  // for a fight finished long ago as well as a live one. See lib/liquidations.
  const liquidations = useLiquidations(duelId, duel?.startBlock, duel?.turns, duel?.lastTurnBlock);

  // ── Duelist guard: the two fighters' players can't bet on their own duel ───
  const { address: connectedAddress } = useAccount();
  const { data: matchData } = useReadContract({
    address: CONTRACT_ADDRESSES.Matchmaker,
    abi: ABIS.Matchmaker,
    functionName: 'matches',
    args: [duelId],
    query: { enabled: duelId > BigInt(0) },
  });
  const isDuelParticipant =
    !!connectedAddress &&
    !!matchData &&
    [(matchData as readonly unknown[])[0], (matchData as readonly unknown[])[1]]
      .some((p) => typeof p === 'string' && p.toLowerCase() === connectedAddress.toLowerCase());

  // A finished duel has nothing live to watch → send it to the result page,
  // which carries the winner summary and the move-by-move transcript.
  useEffect(() => {
    if (isResolved && rawId) {
      router.replace(`/duel/${rawId}/result`);
    }
  }, [isResolved, rawId, router]);

  // ── Derived display values ───────────────────────────────────────────────────
  // currentTurn is completedCallbacks (2 per round — one move per fighter), so
  // the human round number is ceil(callbacks / 2), capped at the duel's turns.
  const displayTurns = duel ? duel.turns : 0;
  const displayRound = duel ? Math.min(Math.ceil(currentTurn / 2), displayTurns) : 0;
  const duelActive   = isActive;
  const duelResolved = isResolved;
  const duelOver     = duelResolved;

  // No duel (status=0 or not found)
  const noDuel = !isLoading && (!duel || duel.status === 0);

  // Still fetching: `duel` is null, so every derived boolean below is false and
  // the zero-value struct would render as a *finished* duel — "FINALIZING",
  // "DUEL COMPLETE", ROUND 0/0 and fighter indices 0/1 (Degen vs Whale)
  // regardless of who is actually fighting. Render a skeleton instead.
  const duelPending = !noDuel && !duel;

  // Odds: chain BPS → percentage. Default to 50/50 if unavailable or no bets.
  const noBets = totalBetsA === BigInt(0) && totalBetsB === BigInt(0);
  const oddsDegenPct = (!odds || noBets) ? 50 : Math.round(odds.degenBps / 100);
  const oddsWhalePct = 100 - oddsDegenPct;

  // Real fighter indexes from chain
  const fighterAIndex = duel ? duel.fighterA : 0;
  const fighterBIndex = duel ? duel.fighterB : 1;

  // Visual identity
  const visualA = visualOf(fighterAIndex);
  // An unknown index falls back to side B here, so an unrecognised pairing still
  // renders as two opposing corners rather than two red ones.
  const visualB = { ...visualOf(fighterBIndex), side: (RING_IDENTITY[fighterBIndex]?.side ?? 'b') as 'a' | 'b' };

  // Static FIGHTERS persona fallback for name/tagline/avatar
  const fallbackA = FIGHTERS[visualA.fallbackId] ?? FIGHTERS.degen;
  const fallbackB = FIGHTERS[visualB.fallbackId] ?? FIGHTERS.whale;

  // Real on-chain name/tagline from FighterRegistry
  const { fighters: chainFighters } = useFighters();
  const chainA = chainFighters.find((f) => f.index === fighterAIndex);
  const chainB = chainFighters.find((f) => f.index === fighterBIndex);

  const degenF = {
    id: visualA.fallbackId,
    name: chainA?.name ?? fallbackA.name,
    hex: visualA.hex,
    side: 'a' as const,
    tier: visualA.tier,
    tagline: chainA?.tagline ?? fallbackA.tagline,
    rank: visualA.rank,
  };
  const whaleF = {
    id: visualB.fallbackId,
    name: chainB?.name ?? fallbackB.name,
    hex: visualB.hex,
    side: 'b' as const,
    tier: visualB.tier,
    tagline: chainB?.tagline ?? fallbackB.tagline,
    rank: visualB.rank,
  };

  // Winner from chain
  const resolvedWinnerSlot = duelResolved && winnerSlot !== null ? winnerSlot : null;
  const winnerName =
    resolvedWinnerSlot === 0
      ? degenF.name
      : resolvedWinnerSlot === 1
        ? whaleF.name
        : resolvedWinnerSlot === DRAW_SLOT
          ? 'DRAW'
          : '—';

  // Real portfolio PnL (float for AnimatedNumber)
  const degenPnl = liveA.pnlNum;
  const whalePnl = liveB.pnlNum;

  // Real holdings: each market contributes what the fighter HOLDS there and the
  // money it has left to spend THERE.
  //
  // The cash row has to name its market. A fighter is credited a separate purse
  // per market — spending all of one leaves the others untouched — so three
  // markets means three genuinely different cash balances. Labelling them all
  // "USDso" rendered as five near-identical rows that read like a duplication bug
  // and told a spectator nothing about which market the money was sitting in.
  const toDisplayHoldings = (holdings: typeof liveA.holdings): Holding[] =>
    holdings.flatMap((h) => [
      {
        token: h.token,
        amount: Number(parseFloat(h.baseAmount).toFixed(6)),
        hint: `${h.token} this fighter is holding, bought on the ${h.token} market. Valued at the going price when the fight is scored.`,
      },
      // "purse", not "cash": `WETH cash` reads as cash DENOMINATED in WETH, which
      // is not a thing. This row is stablecoin — the money still unspent in that
      // market's own purse, which is why it sits beside the WETH actually held.
      {
        token: `${h.token} purse`,
        amount: Number(parseFloat(h.quoteAmount).toFixed(4)),
        hint: `Stablecoin (USDso) still unspent on the ${h.token} market. Every market gives a fighter its own purse, so emptying this one leaves the others untouched.`,
      },
    ]).filter((h) => (h.amount as number) > 0);

  const degenHoldings = toDisplayHoldings(liveA.holdings);
  const whaleHoldings = toDisplayHoldings(liveB.holdings);

  // Pot from real bets (totalBetsA + totalBetsB), formatted as "$X.XX"
  const potDisplay = `$${Number(formatUnits(totalBetsA + totalBetsB, 18)).toFixed(2)}`;

  // Callback to refresh chain state when RoundClock signals a new turn
  const handleTurnAdvanced = useCallback(() => { refetch(); }, [refetch]);

  const [_layoutState, _setLayoutState] = useState(false); // keep for future use

  // winning is strictly > opponent; null when tied (equal values at round 0 or actual tie)
  const degenWinning = degenPnl > whalePnl ? true : degenPnl < whalePnl ? false : null;
  const whaleWinning = whalePnl > degenPnl ? true : whalePnl < degenPnl ? false : null;

  const degenCard = (
    <FighterCardSplit fighter={degenF} pnl={degenPnl} holdings={degenHoldings} perp={liveA.perp} layout={layout} winningVsOpponent={degenWinning} />
  );
  const whaleCard = (
    <FighterCardSplit fighter={whaleF} pnl={whalePnl} holdings={whaleHoldings} perp={liveB.perp} layout={layout} winningVsOpponent={whaleWinning} />
  );

  // ── Error state ──────────────────────────────────────────────────────────
  // Distinct from "no duel": the read failed, so we know nothing either way.
  // The public RPC throttles intermittently, so offer a retry rather than
  // implying the duel does not exist.
  if (duelError && !duel) {
    return (
      <div className="col app-floor" style={{ minHeight: 'calc(100dvh - var(--topbar-h))' }}>
        <AppTopBar />
        <div
          className="col ai-c jc-c"
          style={{ flex: 1, gap: 16, padding: 48, textAlign: 'center' }}
          role="alert"
        >
          <span
            className="t-display t-up"
            style={{ fontSize: 32, color: 'var(--loss)', letterSpacing: '0.14em' }}
          >
            CANNOT REACH THE ARENA
          </span>
          <span className="t-mono t-sm t-dim" style={{ maxWidth: 520 }}>
            Duel #{duelIdNum} could not be read from chain. The public RPC rate-limits
            under load — this is usually temporary.
          </span>
          <div className="row gap-12">
            <BracketButton onClick={() => refetch()}>RETRY →</BracketButton>
            <Link href="/duel">
              <BracketButton variant="ghost">← BACK TO LOBBY</BracketButton>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Loading state ────────────────────────────────────────────────────────
  if (duelPending) {
    return (
      <div className="col app-floor" style={{ minHeight: 'calc(100dvh - var(--topbar-h))' }}>
        <AppTopBar />
        <div
          className="col ai-c jc-c"
          style={{ flex: 1, gap: 16, padding: 48, textAlign: 'center' }}
          role="status"
          aria-live="polite"
        >
          <span
            className="t-display t-up"
            style={{ fontSize: 32, color: 'var(--text-faint)', letterSpacing: '0.14em' }}
          >
            ENTERING THE ARENA
          </span>
          <span className="t-mono t-sm t-dim">Loading duel #{duelIdNum} from chain…</span>
        </div>
      </div>
    );
  }

  // ── Empty state when no active duel ──────────────────────────────────────
  if (noDuel) {
    return (
      <div className="col app-floor" style={{ minHeight: 'calc(100dvh - var(--topbar-h))' }}>
        <AppTopBar />
        <div className="col ai-c jc-c" style={{ flex: 1, gap: 16, padding: 48, textAlign: 'center' }}>
          <span className="t-display t-up" style={{ fontSize: 32, color: 'var(--text-faint)', letterSpacing: '0.14em' }}>
            THIS ARENA IS DARK
          </span>
          <span className="t-mono t-sm t-dim">No active duel at #{duelIdNum} — check the lobby for live matches.</span>
          <Link href="/duel">
            <BracketButton variant="ghost">← BACK TO LOBBY</BracketButton>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="col app-floor" style={{ minHeight: 'calc(100dvh - var(--topbar-h))' }}>
      <AppTopBar />

      {/* ArenaStatusBar — broadcast slate */}
      <div style={{ background: 'var(--bg-stage)', borderBottom: '1px solid var(--border)', position: 'relative', overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute', inset: 0,
            background: 'linear-gradient(90deg, var(--fighter-a-soft), transparent 30%, transparent 70%, var(--fighter-b-soft))',
            pointerEvents: 'none',
          }}
        />
        {/* The design gives this page no visible title, so it had no heading at
            all — a screen reader landed here with nothing naming the duel. The
            live round is deliberately left out: it changes every turn, and a
            heading that rewrites itself is announced repeatedly. */}
        <h1 className="sr-only">
          Duel #{duelIdNum} — {degenF.name} versus {whaleF.name}
        </h1>
        <div className="row ai-c jc-sb" style={{ padding: '12px var(--gutter)', gap: 16, position: 'relative', flexWrap: 'wrap' }}>
          <div className="row gap-16 ai-c" style={{ flexWrap: 'wrap' }}>
            <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}>§ ARENA · MAIN EVENT</span>
            <span style={{ height: 14, width: 1, background: 'var(--border)' }} />
            {duelActive && <Chip variant="live"><Dot variant="a" pulse /> LIVE</Chip>}
            {duelResolved && <Chip variant="gold">★ SETTLED</Chip>}
            {!isLoading && !duelActive && !duelResolved && <Chip variant="loss">FINALIZING</Chip>}
            {duel?.simulated && <Chip variant="loss">🧪 SIMULATED MARKET</Chip>}
            <span
              className="t-mono t-xs"
              style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}
              role="status"
              aria-live="polite"
              aria-label={`Round ${displayRound} of ${displayTurns}`}
            >
              ROUND <span className="t-num" style={{ color: 'var(--text)' }}>{displayRound}</span>
              <span className="t-faint"> / {displayTurns}</span>
            </span>
          </div>
          <div className="row gap-16 ai-c" style={{ flexWrap: 'wrap' }}>
            <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>
              POT <span className="t-num text-gold">{potDisplay}</span>
            </span>
            <span style={{ height: 14, width: 1, background: 'var(--border)' }} />
            <Link href="/duel">
              <BracketButton variant="ghost">LEAVE ←</BracketButton>
            </Link>
          </div>
        </div>
      </div>

      {/* RoundClock — turn progress driven by chain currentTurn */}
      <div style={{ padding: '12px 24px', background: 'var(--bg-stage)', borderBottom: '1px solid var(--border)' }}>
        <RoundClock
          currentTurn={displayRound}
          totalTurns={displayTurns}
          isActive={duelActive}
          onTurnAdvanced={handleTurnAdvanced}
        />
      </div>

      <div className="shell-pad col" style={{ flex: 1, gap: 'clamp(32px, 5vw, 64px)', paddingBlock: 'clamp(24px, 4vw, 48px)' }}>
        {/* § COMBATANTS */}
        <div className="col gap-12" style={{ position: 'relative' }}>
          <div
            aria-hidden
            style={{
              position: 'absolute', inset: '-24px -12px', pointerEvents: 'none', zIndex: 0,
              background:
                'radial-gradient(55% 75% at 16% 55%, var(--fighter-a-glow), transparent 62%), radial-gradient(55% 75% at 84% 55%, var(--fighter-b-glow), transparent 62%)',
              opacity: 0.5,
            }}
          />
          <div className="sect-head" style={{ position: 'relative', zIndex: 1 }}>
            <span className="sect-head-num">§ COMBATANTS</span>
            <span className="sect-head-title">RED CORNER · BLUE CORNER</span>
            <span className="sect-head-meta">round {displayRound} of {displayTurns} · ~600 blocks per round (~1 min)</span>
          </div>

          {layout === 'split' && (
            <div className="row gap-16 arena-duo" style={{ alignItems: 'stretch', position: 'relative', zIndex: 1 }}>
              <div className="col gap-16" style={{ flex: 1 }}>{degenCard}</div>
              {/* Central scoreboard HUD */}
              <div className="col ai-c jc-c arena-vs" style={{ width: 150, gap: 10 }}>
                <span className="t-mono t-xs t-faint" style={{ letterSpacing: '0.22em', whiteSpace: 'nowrap' }}>
                  ROUND {displayRound}/{displayTurns}
                </span>
                <span
                  className="t-display vs-pop"
                  style={{
                    fontSize: 56, lineHeight: 1,
                    background: 'linear-gradient(180deg, var(--fighter-a), var(--fighter-b))',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }}
                >
                  VS
                </span>
                <div className="col ai-c gap-2" style={{ width: '100%', marginTop: 2 }}>
                  <div className="row ai-c jc-sb" style={{ width: '88%' }}>
                    <span className="t-num" style={{ fontSize: 12, color: 'var(--fighter-a)' }}>{oddsDegenPct}%</span>
                    <span className="t-num" style={{ fontSize: 12, color: 'var(--fighter-b)' }}>{oddsWhalePct}%</span>
                  </div>
                  <div style={{ width: '88%', height: 4, display: 'flex', border: '1px solid var(--border)', overflow: 'hidden' }}>
                    <div style={{ width: `${oddsDegenPct}%`, background: 'var(--fighter-a)' }} />
                    <div style={{ flex: 1, background: 'var(--fighter-b)' }} />
                  </div>
                  <span className="label-tiny" style={{ fontSize: 8 }}>LIVE ODDS</span>
                </div>
              </div>
              <div className="col gap-16" style={{ flex: 1 }}>{whaleCard}</div>
            </div>
          )}

          {layout === 'oneUp' && (() => {
            const dWin = degenPnl > whalePnl;
            const Hero = dWin ? degenCard : whaleCard;
            const Other = dWin ? whaleCard : degenCard;
            return (
              <div className="row gap-16 arena-duo" style={{ alignItems: 'stretch' }}>
                <div style={{ flex: 1.6 }}>{Hero}</div>
                <div style={{ flex: 1, opacity: 0.85, transform: 'scale(0.97)' }}>{Other}</div>
              </div>
            );
          })()}

          {layout === 'stacked' && (
            <div className="col gap-12">
              {degenCard}
              <div className="row ai-c jc-c">
                <span className="t-display" style={{ fontSize: 24, color: 'var(--text-faint)' }}>— VS —</span>
              </div>
              {whaleCard}
            </div>
          )}
        </div>

        {/* § FEED — Real last action + thinking state */}
        {/* DELIBERATELY NOT A LIVE REGION AS A WHOLE. It was one, and then the
            fight history moved inside it — so every backfilled timestamp, every
            margin sighting, and every phrase of the decorative thinking ticker
            (which changes every 1.7s, twice over, for the length of a fight) was
            read aloud. The announcement belongs on the one thing that is news:
            each fighter's current move, below. */}
        <div
          className="card pad-24 col gap-16"
          style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.012), transparent 40%), var(--bg-card)' }}
        >
          <div className="sect-head">
            <span className="sect-head-num">§ FEED</span>
            <span className="sect-head-title">FIGHT TIMELINE</span>
            <span className="sect-head-meta">every move, timestamped · newest first</span>
          </div>

          {/* Who is deciding RIGHT NOW. Kept above the history because a live
              fight's most interesting moment is the one that has not resolved
              yet, and it has no timestamp to sort by. */}
          <div className="row gap-16 stack-sm" style={{ alignItems: 'stretch' }}>
            {[
              { f: degenF, live: liveA, side: 'a' as const, corner: 'RED CORNER', tick: 0, fid: fighterAIndex },
              { f: whaleF, live: liveB, side: 'b' as const, corner: 'BLUE CORNER', tick: 2, fid: fighterBIndex },
            ].map(({ f, live, side, corner, tick, fid }) => (
              // TWO CONTAINERS, not one holding the other. What a fighter is doing
              // NOW and what it has already done are different questions, asked at
              // different moments — a spectator glances at the first constantly and
              // reads the second once. Nesting the history inside the live card made
              // one tall box whose top half was mostly empty, and buried the live
              // line above a list that scrolls.
              <div key={side} className="col gap-12 flex-1" style={{ minWidth: 0 }}>
                {/* NOW — the only part of the feed that is announced. One
                    fighter's current state and move, read as a whole so it
                    arrives as "The Degen acted, long ETH" rather than as two
                    unrelated fragments. */}
                <div
                  className={`col gap-6 tint-${side} tint-down`}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  style={{ minWidth: 0, padding: '14px 16px' }}
                >
                  <div className="row gap-8 ai-c jc-sb">
                    <span className="row gap-8 ai-c" style={{ minWidth: 0 }}>
                      <Dot variant={side} pulse={live.thinking} />
                      <span className="label-tiny" style={{ color: `var(--fighter-${side})`, whiteSpace: 'nowrap' }}>
                        {f.name} {live.thinking ? 'DECIDING…' : live.lastAction ? 'ACTED' : 'WAITING'}
                      </span>
                    </span>
                    <span className="t-mono t-xs t-faint" style={{ letterSpacing: '0.18em' }}>{corner}</span>
                  </div>
                  <div className="t-mono t-sm" style={{ color: 'var(--text)', lineHeight: 1.55 }}>
                    {live.thinking ? (
                      <ThinkingTicker fighterId={f.id} startIndex={tick} />
                    ) : live.lastAction ? (
                      <MoveText move={live.lastAction} />
                    ) : (
                      <span className="t-dim">{'> '}<span style={{ opacity: 0.5 }}>No move recorded yet</span></span>
                    )}
                  </div>
                </div>

                {/* WHAT IT HAS ALREADY DONE */}
                <div
                  className="col gap-6"
                  style={{
                    minWidth: 0, padding: '12px 0',
                    borderLeft: `2px solid var(--fighter-${side})`,
                    background: 'var(--bg-card-2)',
                  }}
                >
                  <span className="label-tiny" style={{ padding: '0 16px' }}>EARLIER</span>
                  <FighterTimeline
                    fighterId={fid}
                    side={side}
                    story={story}
                    marginSeen={marginSeen}
                    liquidations={liquidations}
                    latestShown={live.thinking ? '' : live.lastAction}
                  />
                </div>
              </div>
            ))}
          </div>

          {marginSeen.length > 0 && (
            <span className="t-mono t-xs t-faint">
              Margin lines are what a browser watching this fight SAW, not a chain record — nothing
              stores them, and one that clears within ten seconds is missed.
            </span>
          )}
        </div>

        {/* § MARKET — Real mark prices from MarkPriceSnapshot events */}
        <div className="card pad-24 col gap-12">
          <div className="sect-head">
            <span className="sect-head-num">§ MARKET</span>
            <span className="sect-head-title">MARK PRICES</span>
            <span className="sect-head-meta">
              {markets.length > 0
                ? <><Dot variant="win" pulse /> <span style={{ color: 'var(--win)' }}>ON-CHAIN</span> · dreamDEX mid mark · MarkPriceSnapshot events</>
                : 'No mark price snapshots yet for this duel'}
            </span>
          </div>
          {markets.length === 0 ? (
            <div className="panel pad-16" style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
              <span className="t-mono t-sm">Waiting for first mark price snapshot from the Arena…</span>
            </div>
          ) : (
            <div className="row ai-c" style={{ gap: 'clamp(12px, 3vw, 32px)', flexWrap: 'wrap' }}>
              {markets.map((m) => (
                <div key={m.poolKey} className="col gap-2" style={{ flexShrink: 0 }}>
                  {/* Three kinds of slot, three ways to read the number. A question
                      is a probability: no currency symbol and no pair suffix, or
                      0.845 reads as 84 cents of WETH when it means an 84% chance. A
                      perpetual carries a label like a question does but quotes a
                      PRICE, so the same treatment would print Bitcoin as
                      6,400,000%. A coin book is an ordinary traded pair. */}
                  <span className="label-tiny">
                    {m.isPerp ? `${m.poolKey}-PERP` : m.isQuestion ? m.poolKey : `${m.poolKey}/USDso`}
                  </span>
                  <span className="t-num" style={{ fontSize: 18 }}>
                    {m.markPrice > BigInt(0)
                      ? (m.isQuestion
                          ? `${(m.markPriceNum * 100).toFixed(1)}%`
                          : `$${m.markPriceNum.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: m.markPriceNum < 10 ? 4 : 2,
                            })}`)
                      : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* § BOOK — Real BetPanel (chain). */}
        <div className="card pad-24 col gap-12" style={{ boxShadow: '0 0 0 1px rgba(252,211,77,0.14), 0 0 32px rgba(252,211,77,0.05)' }}>
          <div className="sect-head">
            <span className="sect-head-num">§ BOOK</span>
            <span className="sect-head-title">PLACE YOUR WAGER</span>
            <span className="sect-head-meta">
              {duelActive
                ? <><Dot variant="warn" pulse /> <span style={{ color: 'var(--gold)' }}>BETS OPEN</span> · approve + placeBet</>
                : 'BETS CLOSED'}
            </span>
          </div>

          {/* Odds bar — real chain odds */}
          <div className="col gap-8">
            <div className="row jc-sb ai-c">
              <span className="t-mono t-xs" style={{ color: 'var(--fighter-a)' }}>
                {degenF.name} <span className="t-num" style={{ fontSize: 16, marginLeft: 4 }}>{oddsDegenPct}%</span>
              </span>
              <span className="t-mono t-xs" style={{ color: 'var(--fighter-b)' }}>
                <span className="t-num" style={{ fontSize: 16, marginRight: 4 }}>{oddsWhalePct}%</span> {whaleF.name}
              </span>
            </div>
            <OddsBar oddsA={oddsDegenPct} oddsB={oddsWhalePct} />
          </div>

          {/* Real BetPanel */}
          {duelIdNum > 0 ? (
            <BetPanel
              duelId={duelId}
              fighterAName={degenF.name}
              fighterBName={whaleF.name}
              odds={odds}
              totalBetsA={totalBetsA}
              totalBetsB={totalBetsB}
              isActive={isActive}
              isResolved={isResolved}
              isLoading={isLoading}
              isParticipant={isDuelParticipant}
            />
          ) : (
            <div className="panel pad-16" style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
              <span className="t-sm">No active duel</span>
            </div>
          )}
        </div>

        {/* End-of-duel verdict */}
        {duelOver ? (
          <div className="card pad-24 row jc-sb ai-c" style={{ borderColor: 'var(--gold)' }}>
            <div className="row gap-16 ai-c">
              <Chip variant="gold">★ DUEL CONCLUDED</Chip>
              <div className="col gap-2">
                <span className="label-tiny">FINAL VERDICT</span>
                <span
                  className="t-display t-up"
                  style={{
                    fontSize: 18,
                    letterSpacing: '0.14em',
                    color: resolvedWinnerSlot === 0 ? 'var(--fighter-a)' : 'var(--fighter-b)',
                  }}
                >
                  {winnerName} WINS (slot {resolvedWinnerSlot})
                </span>
              </div>
            </div>
            <Link href={`/duel/${params?.id ?? 1}/result`}>
              <BracketButton variant="gold">SEE WINNER →</BracketButton>
            </Link>
          </div>
        ) : (
          <div className="card pad-16 row jc-sb ai-c" style={{ borderColor: 'var(--border)', flexWrap: 'wrap', gap: 12 }}>
            <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.18em' }}>
              ▸ TURNS ADVANCE ON-CHAIN · AUTO
            </span>
            <span className="t-mono t-xs t-dim">
              Round {displayRound} of {displayTurns}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
