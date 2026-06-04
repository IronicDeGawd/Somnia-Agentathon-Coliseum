'use client';

import React, { useReducer, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { Sparkline } from '@/components/shared/Sparkline';
import { OddsBar } from '@/components/shared/OddsBar';
import { AnimatedNumber } from '@/components/shared/AnimatedNumber';
import { Typewriter } from '@/components/shared/Typewriter';
import { BracketButton, Chip, Dot } from '@/components/shared/OtherHUD';
import BetPanel from '@/components/shared/BetPanel';
import { RoundClock } from '@/components/shared/RoundClock';
import { useUIStore } from '@/store/ui';
import { useDuelState } from '@/hooks/useDuelState';
import { simReducer, makeInitialSim } from '@/lib/simulation';
import { FIGHTERS } from '@/lib/fighters';
import { fmtUsd, fmtPct, fmtTime } from '@/lib/format';

type Layout = 'split' | 'oneUp' | 'stacked';

interface Holding {
  token: string;
  amount: string | number;
  pct?: number;
}

// Visual identity per fighter index — mirrors VISUAL_IDENTITY in useFighters.ts.
// These are the on-chain fighter indexes 0-5 from FighterRegistry.
const FIGHTER_VISUAL_MAP: Record<number, {
  hex: string;
  side: 'a' | 'b';
  tier: string;
  rank: string;
  fallbackId: string;   // key into FIGHTERS for avatar / tagline fallback
}> = {
  0: { hex: '#ff3366', side: 'a', tier: 'AGGRESSOR', rank: 'S', fallbackId: 'degen' },
  1: { hex: '#00d9ff', side: 'b', tier: 'TACTICIAN', rank: 'S', fallbackId: 'whale' },
  2: { hex: '#a78bfa', side: 'a', tier: 'QUANT',     rank: 'A', fallbackId: 'reverter' },
  3: { hex: '#fcd34d', side: 'b', tier: 'HOLDER',    rank: 'A', fallbackId: 'scalper' },
  4: { hex: '#f97316', side: 'a', tier: 'SCALPER',   rank: 'A', fallbackId: 'scalper' },
  5: { hex: '#34d399', side: 'b', tier: 'REBEL',     rank: 'B', fallbackId: 'contrarian' },
};

const DEFAULT_VISUAL = { hex: '#ffffff', side: 'a' as const, tier: 'FIGHTER', rank: 'A', fallbackId: 'degen' };

const RIBBON = ({ hex, side, tier, rank, winning }: { hex: string; side: 'a' | 'b'; tier: string; rank: string; winning: boolean }) => {
  const isRight = side === 'b';
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
      <Chip variant={winning ? 'win' : 'loss'}>
        <Dot variant={winning ? 'win' : 'loss'} pulse />
        {winning ? 'WINNING' : 'LOSING'}
      </Chip>
    </div>
  );
};

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
          <div key={h.token} className="col gap-2">
            <div className="row jc-sb ai-c" style={{ gap: 12 }}>
              <span className="row gap-8 ai-c" style={{ minWidth: 0 }}>
                <span style={{ width: 6, height: 6, background: color, display: 'inline-block', boxShadow: `0 0 6px ${color}`, flexShrink: 0 }} />
                <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>{h.token}</span>
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

function FighterCardSplit({
  fighter,
  pnl,
  history,
  holdings,
  layout,
}: {
  fighter: { id: string; name: string; hex: string; side: 'a' | 'b'; tier: string; tagline: string; rank: string };
  pnl: number;
  history: number[];
  holdings: Holding[];
  layout: Layout;
}) {
  const winning = pnl >= 0;
  const { hex, side, name, tier, tagline, rank } = fighter;
  const portraitSize = layout === 'oneUp' ? 220 : layout === 'stacked' ? 100 : 160;
  const sparklineW = layout === 'oneUp' ? 600 : layout === 'stacked' ? 300 : 420;
  const pct = (pnl / 300) * 100;

  if (layout === 'stacked') {
    return (
      <div
        className={`card ${winning ? `glow-${side}` : ''}`}
        style={{ border: `1px solid ${hex}`, overflow: 'hidden', transition: 'box-shadow 600ms ease' }}
      >
        <RIBBON hex={hex} side={side} tier={tier} rank={rank} winning={winning} />
        <div className="row gap-16 ai-s" style={{ padding: 16 }}>
          <FighterAvatar fighter={fighter.id} context="arena" size={portraitSize} state={winning ? 'winning' : 'losing'} />
          <div className="col gap-8 grow" style={{ minWidth: 0 }}>
            <div className="row jc-sb ai-c">
              <span className="t-display t-up" style={{ fontSize: 18, color: hex, letterSpacing: '0.12em', whiteSpace: 'nowrap' }}>{name}</span>
              <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>&ldquo;{tagline}&rdquo;</span>
            </div>
            <div className="row gap-16 ai-c">
              <div className="col gap-2">
                <span className="label-tiny">PNL</span>
                <span className="t-num" style={{ fontSize: 26, lineHeight: 1, color: winning ? 'var(--win)' : 'var(--loss)', whiteSpace: 'nowrap' }}>
                  <AnimatedNumber value={pnl} formatter={fmtUsd} duration={500} />
                </span>
              </div>
              <div className="col gap-2">
                <span className="label-tiny">CHANGE</span>
                <span className="t-num t-sm" style={{ color: winning ? 'var(--win)' : 'var(--loss)', whiteSpace: 'nowrap' }}>
                  {winning ? '▲' : '▼'} <AnimatedNumber value={pct} formatter={fmtPct} duration={500} />
                </span>
              </div>
              <div className="flex-1" style={{ minWidth: 0 }}>
                <Sparkline data={history} color={hex} width={sparklineW} height={36} />
              </div>
            </div>
            <HoldingsBlock holdings={holdings} color={hex} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`card ${winning ? `glow-${side}` : ''}`}
      style={{ border: `1px solid ${hex}`, overflow: 'hidden', transition: 'box-shadow 600ms ease' }}
    >
      <RIBBON hex={hex} side={side} tier={tier} rank={rank} winning={winning} />
      <div className="col" style={{ padding: 20, gap: 14 }}>
        <div className="row ai-s gap-16">
          <div style={{ flexShrink: 0 }}>
            <FighterAvatar fighter={fighter.id} context="arena" size={portraitSize} state={winning ? 'winning' : 'losing'} />
          </div>
          <div className="col gap-8 grow" style={{ minWidth: 0 }}>
            <div className="col gap-2">
              <span className="t-display t-up" style={{ fontSize: layout === 'oneUp' ? 24 : 20, color: hex, letterSpacing: '0.12em', lineHeight: 1.1, whiteSpace: 'nowrap' }}>{name}</span>
              <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>&ldquo;{tagline}&rdquo;</span>
            </div>
            <div className="col gap-2">
              <span className="label-tiny">ROUND PNL</span>
              <span className="t-num" style={{ fontSize: layout === 'oneUp' ? 40 : 32, lineHeight: 1, color: winning ? 'var(--win)' : 'var(--loss)', whiteSpace: 'nowrap' }}>
                <AnimatedNumber value={pnl} formatter={fmtUsd} duration={500} />
              </span>
              <span className="t-num t-sm" style={{ color: winning ? 'var(--win)' : 'var(--loss)', whiteSpace: 'nowrap' }}>
                {winning ? '▲▲▲' : '▼▼▼'} <AnimatedNumber value={pct} formatter={fmtPct} duration={500} />
              </span>
            </div>
          </div>
        </div>

        <div className="col gap-4">
          <div className="row jc-sb ai-c" style={{ gap: 12 }}>
            <span className="label-tiny">PNL TIMELINE</span>
            <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>ROUND 1—{history.length}</span>
          </div>
          <Sparkline data={history} color={hex} width={sparklineW} height={44} />
        </div>

        <hr className="divider" />
        <HoldingsBlock holdings={holdings} color={hex} />
      </div>
    </div>
  );
}

export default function ArenaPage() {
  const params = useParams();
  const layout = useUIStore((state) => state.layout) as Layout;
  const autoAdvance = true;

  // Parse duel ID from URL params — BigInt for contract reads.
  const rawId = params?.id;
  const duelIdNum = rawId ? Number(rawId) : 0;
  const duelId = BigInt(duelIdNum > 0 ? duelIdNum : 0) as bigint;

  // ── Chain state ──────────────────────────────────────────────────────────────
  const {
    duel,
    odds,
    currentTurn,
    isActive,
    isResolved,
    winnerSlot,
    isLoading,
    refetch,
  } = useDuelState(duelId);

  // ── Simulation (visual fallback when chain data is loading or absent) ────────
  const turnsParam = Number(params?.turns ?? 15);
  const totalTurns: 3 | 6 | 9 | 15 = ([3, 6, 9, 15] as const).includes(turnsParam as 3 | 6 | 9 | 15)
    ? (turnsParam as 3 | 6 | 9 | 15)
    : 15;

  const [simState, dispatch] = useReducer(simReducer, makeInitialSim());

  useEffect(() => {
    const clock = setInterval(() => dispatch({ type: 'TICK' }), 1000);
    return () => clearInterval(clock);
  }, []);

  const handleAdvance = () => dispatch({ type: 'ADVANCE' });
  const handleFastForward = () => dispatch({ type: 'FAST_FORWARD' });

  // ── Derived display values: chain data when available, sim as fallback ───────
  // Use chain currentTurn when the duel is loaded; fall back to sim round.
  const displayRound = (!isLoading && duel) ? currentTurn  : simState.round;
  const displayTurns = (!isLoading && duel) ? duel.turns   : totalTurns;
  const duelActive   = (!isLoading && duel) ? isActive     : true;
  const duelResolved = (!isLoading && duel) ? isResolved   : false;
  const duelOver     = duelResolved || (simState.round > 15 || simState.timeLeft <= 0);

  // Odds: chain BPS → percentage. Fall back to simState.oddsDegen while loading.
  const oddsDegenPct = (!isLoading && odds)
    ? Math.round(odds.degenBps / 100)
    : simState.oddsDegen;
  const oddsWhalePct = 100 - oddsDegenPct;

  // Fighter indexes from the on-chain duel, defaulting to 0/1 (degen/whale) during load.
  // The ABI tuple for duels() does not expose fighterA/fighterB in the current contracts.ts
  // definition, so we cast through unknown and fall back safely if absent.
  const duelAny = duel as unknown as Record<string, unknown> | null;
  const fighterAIndex = (duelAny && typeof duelAny.fighterA === 'number') ? duelAny.fighterA : 0;
  const fighterBIndex = (duelAny && typeof duelAny.fighterB === 'number') ? duelAny.fighterB : 1;

  // Resolve visual identity for each fighter slot from the registry mapping.
  const visualA = FIGHTER_VISUAL_MAP[fighterAIndex] ?? DEFAULT_VISUAL;
  const visualB = FIGHTER_VISUAL_MAP[fighterBIndex] ?? { ...DEFAULT_VISUAL, side: 'b' as const };

  // Fall back to FIGHTERS static data for name/tagline/avatar while waiting on chain.
  const fallbackA = FIGHTERS[visualA.fallbackId] ?? FIGHTERS.degen;
  const fallbackB = FIGHTERS[visualB.fallbackId] ?? FIGHTERS.whale;

  const degenF = {
    id: visualA.fallbackId,
    name: fallbackA.name,
    hex: visualA.hex,
    side: 'a' as const,
    tier: visualA.tier,
    tagline: fallbackA.tagline,
    rank: visualA.rank,
  };
  const whaleF = {
    id: visualB.fallbackId,
    name: fallbackB.name,
    hex: visualB.hex,
    side: 'b' as const,
    tier: visualB.tier,
    tagline: fallbackB.tagline,
    rank: visualB.rank,
  };

  // Winner display: real winnerSlot from chain when resolved, else sim fallback.
  const resolvedWinnerSlot = duelResolved && winnerSlot !== null ? winnerSlot : null;
  const simWinnerIsA = simState.degen.pnl >= simState.whale.pnl;
  const winnerSlotDisplay = resolvedWinnerSlot !== null ? resolvedWinnerSlot : (simWinnerIsA ? 0 : 1);
  const winnerName = winnerSlotDisplay === 0 ? degenF.name : whaleF.name;

  // Callback to refresh chain state whenever the RoundClock signals a new turn.
  const handleTurnAdvanced = useCallback(() => {
    refetch();
    dispatch({ type: 'ADVANCE' });
  }, [refetch]);

  const degenCard = (
    <FighterCardSplit fighter={degenF} pnl={simState.degen.pnl} history={simState.degen.history} holdings={simState.degen.holdings as Holding[]} layout={layout} />
  );
  const whaleCard = (
    <FighterCardSplit fighter={whaleF} pnl={simState.whale.pnl} history={simState.whale.history} holdings={simState.whale.holdings as Holding[]} layout={layout} />
  );

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
        <div className="row ai-c jc-sb" style={{ padding: '12px var(--gutter)', gap: 16, position: 'relative', flexWrap: 'wrap' }}>
          <div className="row gap-16 ai-c" style={{ flexWrap: 'wrap' }}>
            <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}>§ ARENA · MAIN EVENT</span>
            <span style={{ height: 14, width: 1, background: 'var(--border)' }} />
            <Chip variant="live"><Dot variant="a" pulse /> LIVE</Chip>
            <span className="t-mono t-xs" style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
              ROUND <span className="t-num" style={{ color: 'var(--text)' }}>{displayRound}</span>
              <span className="t-faint"> / {displayTurns}</span>
            </span>
            <span className="t-mono t-xs" style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
              BELL <span className="t-num" style={{ color: simState.timeLeft < 60 ? 'var(--loss)' : 'var(--text)' }}>{fmtTime(simState.timeLeft)}</span>
            </span>
          </div>
          <div className="row gap-16 ai-c" style={{ flexWrap: 'wrap' }}>
            <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>
              <span className="t-num" style={{ color: 'var(--text)' }}>{simState.spectators}</span> watching
            </span>
            <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>
              POT <span className="t-num text-gold">${simState.pot}</span>
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
          {/* Stage spotlights — red corner left, blue corner right, converging center */}
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
              {/* Central scoreboard HUD — the tale of the tape */}
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
                <span className="t-mono t-xs" style={{ whiteSpace: 'nowrap', color: simState.timeLeft < 60 ? 'var(--loss)' : 'var(--text-dim)' }}>
                  BELL <span className="t-num">{fmtTime(simState.timeLeft)}</span>
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
            const dWin = simState.degen.pnl >= simState.whale.pnl;
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

        {/* § FEED — Reasoning */}
        <div
          className="card pad-24 col gap-16"
          style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.012), transparent 40%), var(--bg-card)' }}
        >
          <div className="sect-head">
            <span className="sect-head-num">§ FEED</span>
            <span className="sect-head-title">FIGHTER REASONING</span>
            <span className="sect-head-meta">SOMNIA AGENTS · inferNumber(0..6)</span>
          </div>
          {/* Two opposing corners — red DEGEN / blue WHALE, mirroring the fight */}
          <div className="row gap-16 stack-sm" style={{ alignItems: 'stretch' }}>
            <div
              className="col gap-6 flex-1"
              style={{ minWidth: 0, padding: '14px 16px', borderLeft: '2px solid var(--fighter-a)', background: 'linear-gradient(180deg, var(--fighter-a-soft), transparent 70%)' }}
            >
              <div className="row gap-8 ai-c jc-sb">
                <span className="row gap-8 ai-c" style={{ minWidth: 0 }}>
                  <Dot variant="a" pulse={simState.degen.thinking} />
                  <span className="label-tiny" style={{ color: 'var(--fighter-a)', whiteSpace: 'nowrap' }}>
                    {degenF.name} {simState.degen.thinking ? 'THINKING…' : 'DECIDED'}
                  </span>
                </span>
                <span className="t-mono t-xs t-faint" style={{ letterSpacing: '0.18em' }}>RED CORNER</span>
              </div>
              <div className="t-mono t-sm" style={{ color: 'var(--text)', lineHeight: 1.55, minHeight: 44 }}>
                <span className="t-dim">{'> '}</span>
                <Typewriter text={simState.degen.reasoning} speed={42} />
              </div>
            </div>
            <div
              className="col gap-6 flex-1"
              style={{ minWidth: 0, padding: '14px 16px', borderLeft: '2px solid var(--fighter-b)', background: 'linear-gradient(180deg, var(--fighter-b-soft), transparent 70%)' }}
            >
              <div className="row gap-8 ai-c jc-sb">
                <span className="row gap-8 ai-c" style={{ minWidth: 0 }}>
                  <Dot variant="b" pulse={simState.whale.thinking} />
                  <span className="label-tiny" style={{ color: 'var(--fighter-b)', whiteSpace: 'nowrap' }}>
                    {whaleF.name} {simState.whale.thinking ? 'THINKING…' : 'DECIDED'}
                  </span>
                </span>
                <span className="t-mono t-xs t-faint" style={{ letterSpacing: '0.18em' }}>BLUE CORNER</span>
              </div>
              <div className="t-mono t-sm" style={{ color: 'var(--text)', lineHeight: 1.55, minHeight: 44 }}>
                <span className="t-dim">{'> '}</span>
                <Typewriter text={simState.whale.reasoning} speed={42} />
              </div>
            </div>
          </div>
        </div>

        {/* § MARKET — WBTC ticker */}
        <div className="card pad-24 col gap-12">
          <div className="sect-head">
            <span className="sect-head-num">§ MARKET</span>
            <span className="sect-head-title">WBTC/USDso</span>
            <span className="sect-head-meta">dreamDEX · mid mark live</span>
          </div>
          <div className="row ai-c" style={{ gap: 'clamp(12px, 3vw, 32px)', flexWrap: 'wrap' }}>
            <div className="col gap-2" style={{ flexShrink: 0 }}>
              <span className="label-tiny">BID</span>
              <span className="t-num" style={{ fontSize: 18 }}>${simState.market.bid.toFixed(2)}</span>
            </div>
            <div className="col gap-2" style={{ flexShrink: 0 }}>
              <span className="label-tiny">ASK</span>
              <span className="t-num" style={{ fontSize: 18 }}>${simState.market.ask.toFixed(2)}</span>
            </div>
            <div className="col gap-2" style={{ flexShrink: 0 }}>
              <span className="label-tiny">24H</span>
              <span className={`t-num ${simState.market.change >= 0 ? 'text-win' : 'text-loss'}`} style={{ fontSize: 18 }}>
                {fmtPct(simState.market.change)}
              </span>
            </div>
            <div className="col gap-2 grow">
              <span className="label-tiny">LAST FILLS — {(simState.market.buyRatio * 100).toFixed(0)}% BUYS</span>
              <div className="row gap-2 ai-c">
                {Array.from({ length: 28 }).map((_, i) => {
                  const buy = i < simState.market.buyRatio * 28;
                  return (
                    <span
                      key={i}
                      style={{
                        flex: 1,
                        height: 14,
                        background: buy ? 'var(--win)' : 'var(--loss)',
                        opacity: 0.85,
                      }}
                    />
                  );
                })}
              </div>
            </div>
            <div className="col gap-2 ai-e" style={{ flexShrink: 0 }}>
              <span className="label-tiny">VOL 24H</span>
              <span className="t-num text-gold" style={{ fontSize: 18 }}>${simState.market.vol.toFixed(1)}M</span>
            </div>
          </div>
        </div>

        {/* § BOOK — Real BetPanel (chain) with sim odds bar as visual header */}
        <div className="card pad-24 col gap-12">
          <div className="sect-head">
            <span className="sect-head-num">§ BOOK</span>
            <span className="sect-head-title">PLACE YOUR BET</span>
            <span className="sect-head-meta">{duelActive ? 'BETS OPEN WHILE DUEL ACTIVE · approve + placeBet' : 'BETS CLOSED'}</span>
          </div>

          {/* Odds bar — uses real chain odds when loaded, sim otherwise */}
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

          {/* Real BetPanel — handles wallet connection, approve, placeBet */}
          {duelIdNum > 0 ? (
            <BetPanel
              duelId={duelId}
              fighterAName={degenF.name}
              fighterBName={whaleF.name}
            />
          ) : (
            <div className="panel pad-16" style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
              <span className="t-sm">No active duel</span>
            </div>
          )}
        </div>

        {/* Turn controls / end-of-duel */}
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
                    color: winnerSlotDisplay === 0 ? 'var(--fighter-a)' : 'var(--fighter-b)',
                  }}
                >
                  {winnerName} WINS (winnerSlot {winnerSlotDisplay})
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
              ▸ NEXT TURN IN <span className="t-num" style={{ color: 'var(--text)' }}>{simState.turnIn}s</span> · AUTO {autoAdvance ? 'ON' : 'OFF'}
            </span>
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              <BracketButton onClick={handleAdvance}>ADVANCE TURN ▸</BracketButton>
              <BracketButton variant="ghost" onClick={handleFastForward}>▸▸ JUMP TO END</BracketButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
