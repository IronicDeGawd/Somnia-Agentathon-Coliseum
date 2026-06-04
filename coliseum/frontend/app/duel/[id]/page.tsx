'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { formatUnits } from 'viem';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { OddsBar } from '@/components/shared/OddsBar';
import { AnimatedNumber } from '@/components/shared/AnimatedNumber';
import { BracketButton, Chip, Dot } from '@/components/shared/OtherHUD';
import BetPanel from '@/components/shared/BetPanel';
import { RoundClock } from '@/components/shared/RoundClock';
import { useUIStore } from '@/store/ui';
import { useDuelState } from '@/hooks/useDuelState';
import { useDuelLive } from '@/hooks/useDuelLive';
import { useFighters } from '@/hooks/useFighters';
import { FIGHTERS } from '@/lib/fighters';
import { fmtUsd, fmtPct } from '@/lib/format';

type Layout = 'split' | 'oneUp' | 'stacked';

interface Holding {
  token: string;
  amount: string | number;
  pct?: number;
}

// Visual identity per fighter index — mirrors VISUAL_IDENTITY in useFighters.ts.
const FIGHTER_VISUAL_MAP: Record<number, {
  hex: string;
  side: 'a' | 'b';
  tier: string;
  rank: string;
  fallbackId: string;
}> = {
  0: { hex: '#ff3366', side: 'a', tier: 'AGGRESSOR', rank: 'S', fallbackId: 'degen' },
  1: { hex: '#00d9ff', side: 'b', tier: 'TACTICIAN', rank: 'S', fallbackId: 'whale' },
  2: { hex: '#a78bfa', side: 'a', tier: 'QUANT',     rank: 'A', fallbackId: 'quant' },
  3: { hex: '#fcd34d', side: 'b', tier: 'HOLDER',    rank: 'A', fallbackId: 'diamond' },
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
  holdings,
  layout,
}: {
  fighter: { id: string; name: string; hex: string; side: 'a' | 'b'; tier: string; tagline: string; rank: string };
  pnl: number;
  holdings: Holding[];
  layout: Layout;
}) {
  const winning = pnl >= 0;
  const { hex, side, name, tier, tagline, rank } = fighter;
  const portraitSize = layout === 'oneUp' ? 220 : layout === 'stacked' ? 100 : 160;

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
            </div>
            {holdings.length > 0 && <HoldingsBlock holdings={holdings} color={hex} />}
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
            </div>
          </div>
        </div>

        {holdings.length > 0 && (
          <>
            <hr className="divider" />
            <HoldingsBlock holdings={holdings} color={hex} />
          </>
        )}
      </div>
    </div>
  );
}

export default function ArenaPage() {
  const params = useParams();
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
    refetch,
  } = useDuelState(duelId);

  // ── Live on-chain portfolio data ──────────────────────────────────────────
  const { fighterA: liveA, fighterB: liveB, markets } = useDuelLive(duelId, duel);

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

  // Odds: chain BPS → percentage. Default to 50/50 if unavailable.
  const oddsDegenPct = odds ? Math.round(odds.degenBps / 100) : 50;
  const oddsWhalePct = 100 - oddsDegenPct;

  // Real fighter indexes from chain
  const fighterAIndex = duel ? duel.fighterA : 0;
  const fighterBIndex = duel ? duel.fighterB : 1;

  // Visual identity
  const visualA = FIGHTER_VISUAL_MAP[fighterAIndex] ?? DEFAULT_VISUAL;
  const visualB = FIGHTER_VISUAL_MAP[fighterBIndex] ?? { ...DEFAULT_VISUAL, side: 'b' as const };

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
  const winnerName = resolvedWinnerSlot === 0 ? degenF.name : resolvedWinnerSlot === 1 ? whaleF.name : '—';

  // Real portfolio PnL (float for AnimatedNumber)
  const degenPnl = liveA.pnlNum;
  const whalePnl = liveB.pnlNum;

  // Real holdings: combine base+quote per pool into display rows
  const toDisplayHoldings = (holdings: typeof liveA.holdings): Holding[] =>
    holdings.flatMap((h) => [
      { token: h.token, amount: Number(parseFloat(h.baseAmount).toFixed(6)) },
      { token: 'USDso', amount: Number(parseFloat(h.quoteAmount).toFixed(2)) },
    ]).filter((h) => (h.amount as number) > 0);

  const degenHoldings = toDisplayHoldings(liveA.holdings);
  const whaleHoldings = toDisplayHoldings(liveB.holdings);

  // Pot from real bets (totalBetsA + totalBetsB), formatted as "$X.XX"
  const potDisplay = `$${Number(formatUnits(totalBetsA + totalBetsB, 18)).toFixed(2)}`;

  // Callback to refresh chain state when RoundClock signals a new turn
  const handleTurnAdvanced = useCallback(() => { refetch(); }, [refetch]);

  const [_layoutState, _setLayoutState] = useState(false); // keep for future use

  const degenCard = (
    <FighterCardSplit fighter={degenF} pnl={degenPnl} holdings={degenHoldings} layout={layout} />
  );
  const whaleCard = (
    <FighterCardSplit fighter={whaleF} pnl={whalePnl} holdings={whaleHoldings} layout={layout} />
  );

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
        <div className="row ai-c jc-sb" style={{ padding: '12px var(--gutter)', gap: 16, position: 'relative', flexWrap: 'wrap' }}>
          <div className="row gap-16 ai-c" style={{ flexWrap: 'wrap' }}>
            <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}>§ ARENA · MAIN EVENT</span>
            <span style={{ height: 14, width: 1, background: 'var(--border)' }} />
            {duelActive && <Chip variant="live"><Dot variant="a" pulse /> LIVE</Chip>}
            {duelResolved && <Chip variant="gold">★ SETTLED</Chip>}
            {!duelActive && !duelResolved && <Chip variant="loss">FINALIZING</Chip>}
            <span className="t-mono t-xs" style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
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
            const dWin = degenPnl >= whalePnl;
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
        <div
          className="card pad-24 col gap-16"
          style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.012), transparent 40%), var(--bg-card)' }}
        >
          <div className="sect-head">
            <span className="sect-head-num">§ FEED</span>
            <span className="sect-head-title">FIGHTER ACTIONS</span>
            <span className="sect-head-meta">SOMNIA AGENTS · on-chain FighterMove events</span>
          </div>
          <div className="row gap-16 stack-sm" style={{ alignItems: 'stretch' }}>
            <div
              className="col gap-6 flex-1"
              style={{ minWidth: 0, padding: '14px 16px', borderLeft: '2px solid var(--fighter-a)', background: 'linear-gradient(180deg, var(--fighter-a-soft), transparent 70%)' }}
            >
              <div className="row gap-8 ai-c jc-sb">
                <span className="row gap-8 ai-c" style={{ minWidth: 0 }}>
                  <Dot variant="a" pulse={liveA.thinking} />
                  <span className="label-tiny" style={{ color: 'var(--fighter-a)', whiteSpace: 'nowrap' }}>
                    {degenF.name} {liveA.thinking ? 'THINKING…' : liveA.lastAction ? 'ACTED' : 'WAITING'}
                  </span>
                </span>
                <span className="t-mono t-xs t-faint" style={{ letterSpacing: '0.18em' }}>RED CORNER</span>
              </div>
              <div className="t-mono t-sm" style={{ color: 'var(--text)', lineHeight: 1.55, minHeight: 44 }}>
                {liveA.thinking ? (
                  <span className="t-dim">{'> '}<span style={{ color: 'var(--text-dim)' }}>THINKING…</span></span>
                ) : liveA.lastAction ? (
                  <span><span className="t-dim">{'> '}</span>{liveA.lastAction}</span>
                ) : (
                  <span className="t-dim">{'> '}<span style={{ opacity: 0.5 }}>No move recorded yet</span></span>
                )}
              </div>
            </div>
            <div
              className="col gap-6 flex-1"
              style={{ minWidth: 0, padding: '14px 16px', borderLeft: '2px solid var(--fighter-b)', background: 'linear-gradient(180deg, var(--fighter-b-soft), transparent 70%)' }}
            >
              <div className="row gap-8 ai-c jc-sb">
                <span className="row gap-8 ai-c" style={{ minWidth: 0 }}>
                  <Dot variant="b" pulse={liveB.thinking} />
                  <span className="label-tiny" style={{ color: 'var(--fighter-b)', whiteSpace: 'nowrap' }}>
                    {whaleF.name} {liveB.thinking ? 'THINKING…' : liveB.lastAction ? 'ACTED' : 'WAITING'}
                  </span>
                </span>
                <span className="t-mono t-xs t-faint" style={{ letterSpacing: '0.18em' }}>BLUE CORNER</span>
              </div>
              <div className="t-mono t-sm" style={{ color: 'var(--text)', lineHeight: 1.55, minHeight: 44 }}>
                {liveB.thinking ? (
                  <span className="t-dim">{'> '}<span style={{ color: 'var(--text-dim)' }}>THINKING…</span></span>
                ) : liveB.lastAction ? (
                  <span><span className="t-dim">{'> '}</span>{liveB.lastAction}</span>
                ) : (
                  <span className="t-dim">{'> '}<span style={{ opacity: 0.5 }}>No move recorded yet</span></span>
                )}
              </div>
            </div>
          </div>
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
                  <span className="label-tiny">{m.poolKey}/USDso</span>
                  <span className="t-num" style={{ fontSize: 18 }}>
                    {m.markPrice > BigInt(0) ? `$${m.markPriceNum.toFixed(4)}` : '—'}
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
              isLoading={isLoading}
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
