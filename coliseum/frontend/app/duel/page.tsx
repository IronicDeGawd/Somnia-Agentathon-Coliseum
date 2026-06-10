'use client';

import React, { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { BracketButton, Chip, Dot } from '@/components/shared/OtherHUD';
import { DuelCreator } from '@/components/shared/DuelCreator';
import DuelCard from '@/components/shared/DuelCard';
import { useActiveDuel } from '@/hooks/useActiveDuel';
import { useDuelState } from '@/hooks/useDuelState';
import { useQueueState, type QueueTier } from '@/hooks/useQueueState';
import { useLeaderboard } from '@/hooks/useLeaderboard';
import { useMyBets } from '@/hooks/useMyBets';
import { ROSTER, fighterIndexToId, FIGHTER_VISUAL_MAP } from '@/lib/fighters';
import { formatUnits } from 'viem';
import { useAccount } from 'wagmi';

// On-chain fighter index → local fighter roster id (FighterRegistry order matches ROSTER order)
const FIGHTER_INDEX_TO_ID: Record<number, string> = {
  0: 'degen',
  1: 'whale',
  2: 'scalper',
  3: 'reverter',
  4: 'surfer',
  5: 'contrarian',
};

export default function LobbyPage() {
  const router = useRouter();
  const [creatorExpanded, setCreatorExpanded] = useState(false);
  // When set, the creator opens with the tier fixed (joining a specific tier);
  // null means the generic creator with a selectable tier.
  const [lockedTurns, setLockedTurns] = useState<QueueTier | null>(null);
  const creatorRef = useRef<HTMLElement>(null);

  // The "START A DUEL" buttons live at the top of the page, but the creator
  // form renders several sections down. Expanding alone gives no visible
  // feedback, so scroll the now-open form into view on the next paint.
  // Pass a tier to lock the round (JOIN on a card); omit it for the generic form.
  const openCreator = useCallback((turns?: QueueTier) => {
    setLockedTurns(turns ?? null);
    setCreatorExpanded(true);
    requestAnimationFrame(() =>
      creatorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }, []);

  const { activeDuelId, duel, isLoading: isDuelLoading } = useActiveDuel();
  const { rows: leaderboardRows, isEmpty: leaderboardEmpty } = useLeaderboard();
  const { bets: myBets, isEmpty: betsEmpty, isLoading: betsLoading } = useMyBets();
  const { address: walletAddress } = useAccount();
  const { slots: queueSlots, isLoading: isQueueLoading } = useQueueState();
  // Live betting odds for the active duel (real Bookmaker pools, 0 = disabled).
  const { odds: liveOdds } = useDuelState(activeDuelId ?? BigInt(0));

  // Derive display values from on-chain duel when available
  const activeDuelIdStr = activeDuelId !== null ? activeDuelId.toString() : null;
  const currentTurn = duel ? Math.floor(duel.completedCallbacks / 2) : 0;
  const totalTurns = duel?.turns ?? 15;
  const fighterAIndex = duel?.fighterA ?? 0;
  const fighterBIndex = duel?.fighterB ?? 1;
  const fighterAId = FIGHTER_INDEX_TO_ID[fighterAIndex] ?? 'degen';
  const fighterBId = FIGHTER_INDEX_TO_ID[fighterBIndex] ?? 'whale';
  const fighterAName = ROSTER.find(r => r.id === fighterAId)?.name ?? `FIGHTER #${fighterAIndex}`;
  const fighterBName = ROSTER.find(r => r.id === fighterBId)?.name ?? `FIGHTER #${fighterBIndex}`;

  // Real on-chain stats for the hero strip. Purse = both duelists' staked pot
  // (initialUsdsoPerFighter × 2). Odds = live Bookmaker spectator odds (fighter A %).
  const pursePot = duel ? duel.initialUsdsoPerFighter * BigInt(2) : BigInt(0);
  const liveOddsAPct = liveOdds ? Math.round(liveOdds.degenBps / 100) : 50;

  // Ticker items — prices deferred to future price-feed wiring
  const tickerItemNodes: React.ReactNode[] = [
    <>WBTC/USDso <span className="t-num t-dim">—</span></>,
    <>WETH/USDso <span className="t-num t-dim">—</span></>,
    <>SOMI/USDso <span className="t-num t-dim">—</span></>,
    <>ONE ARENA · ONE LIVE DUEL</>,
    activeDuelId !== null
      ? <>ACTIVE DUEL <span className="t-num text-gold">#{activeDuelIdStr}</span></>
      : <>ARENA IS DARK · START A DUEL</>,
  ];

  return (
    <div className="col app-floor">
      <AppTopBar />

      {/* ── LOBBY MARQUEE ──────────────────────────────────────────── */}
      <section style={{ position: 'relative', borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        {/* Faded backdrop portraits */}
        <div style={{ position: 'absolute', left: -40, top: 40, opacity: 0.18, transform: 'rotate(-3deg)', pointerEvents: 'none' }}>
          <FighterAvatar fighter={fighterAId} context="card" size={320} state="winning" chrome={false} />
        </div>
        <div style={{ position: 'absolute', right: -40, top: 40, opacity: 0.18, transform: 'rotate(3deg)', pointerEvents: 'none' }}>
          <FighterAvatar fighter={fighterBId} context="card" size={320} state="winning" chrome={false} />
        </div>

        <div className="shell-pad col gap-16" style={{ position: 'relative', paddingTop: 36, paddingBottom: 36 }}>
          {/* Status strip */}
          <div className="row jc-sb ai-c">
            <div className="row gap-12 ai-c">
              <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}>§ LOBBY · MAIN HALL</span>
              <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
              {activeDuelId !== null ? (
                <Chip variant="live"><Dot variant="a" pulse /> DUEL #{activeDuelIdStr} · LIVE</Chip>
              ) : (
                <Chip variant="gold">▸ ARENA DARK · START A DUEL</Chip>
              )}
            </div>
            <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.18em', whiteSpace: 'nowrap' }}>
              {activeDuelId !== null ? `BEST OF ${totalTurns}` : 'AWAITING CHALLENGER'} · SOMNIA SHANNON TESTNET
            </span>
          </div>

          {/* Big poster headline */}
          <div className="col ai-c gap-4" style={{ paddingTop: 12 }}>
            <span className="eyebrow" style={{ color: 'var(--text-dim)' }}>
              {activeDuelId !== null ? "TONIGHT'S MAIN EVENT" : 'NO ACTIVE DUEL'}
            </span>
            <h1
              className="fp-display"
              style={{
                fontSize: 'clamp(56px, 8vw, 96px)',
                letterSpacing: '0.04em',
                lineHeight: 1,
                textAlign: 'center',
                margin: '8px 0',
                color: 'var(--text)',
              }}
            >
              {activeDuelId !== null ? (
                <>
                  <span className="text-a">{fighterAName}</span>
                  <span style={{ color: 'var(--text-faint)', margin: '0 16px' }}>vs</span>
                  <span className="text-b">{fighterBName}</span>
                </>
              ) : (
                <span style={{ color: 'var(--text-faint)' }}>ARENA IS DARK</span>
              )}
            </h1>
          </div>

          {/* 3-up stat strip — PURSE / ODDS / ROUND (all read from chain) */}
          <div className="row ai-c jc-c" style={{ marginTop: 8, gap: 'clamp(12px, 3vw, 32px)', flexWrap: 'wrap' }}>
            <div className="col ai-c gap-2">
              <span className="eyebrow">PURSE</span>
              <span className="t-num text-gold" style={{ fontSize: 'clamp(22px, 5vw, 36px)', lineHeight: 1 }}>
                {activeDuelId !== null && duel
                  ? `$${parseFloat(formatUnits(pursePot, 18)).toFixed(2)}`
                  : '—'}
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">ODDS</span>
              <span className="t-num" style={{ fontSize: 'clamp(22px, 5vw, 36px)', lineHeight: 1, whiteSpace: 'nowrap' }}>
                {activeDuelId !== null && liveOdds ? (
                  <>
                    <span className="text-a">{liveOddsAPct}</span>
                    <span style={{ color: 'var(--text-faint)', fontSize: 22 }}> · </span>
                    <span className="text-b">{100 - liveOddsAPct}</span>
                  </>
                ) : (
                  <span className="t-dim">—</span>
                )}
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">ROUND</span>
              <span className="t-num" style={{ fontSize: 'clamp(22px, 5vw, 36px)', lineHeight: 1, color: 'var(--text)' }}>
                {activeDuelId !== null
                  ? isDuelLoading ? '…' : `${currentTurn}/${totalTurns}`
                  : '—'}
              </span>
            </div>
          </div>

          {/* CTAs */}
          <div className="row gap-12 ai-c jc-c" style={{ marginTop: 12 }}>
            {activeDuelId !== null ? (
              <>
                <Link href={`/duel/${activeDuelIdStr}/preduel`}>
                  <BracketButton variant="a">BACK {fighterAName}</BracketButton>
                </Link>
                <Link href={`/duel/${activeDuelIdStr}/preduel`}>
                  <BracketButton variant="primary">ENTER PRE-DUEL →</BracketButton>
                </Link>
                <Link href={`/duel/${activeDuelIdStr}/preduel`}>
                  <BracketButton variant="b">BACK {fighterBName}</BracketButton>
                </Link>
              </>
            ) : (
              <button
                className="bk bk-primary"
                style={{ padding: '12px 32px', letterSpacing: '0.08em' }}
                onClick={() => openCreator()}
              >
                START THE FIRST DUEL →
              </button>
            )}
          </div>
        </div>

        {/* Ticker bottom strip */}
        <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-stage)', height: 36, overflow: 'hidden', position: 'relative' }}>
          <div className="ticker" style={{ height: '100%', alignItems: 'center', paddingLeft: 16 }}>
            {[0, 1].map((k) => (
              <div className="row gap-32 ai-c" key={k} style={{ height: '100%' }}>
                {tickerItemNodes.map((item, i) => (
                  <React.Fragment key={i}>
                    <span className="t-mono t-xs t-dim">{item}</span>
                    {i < tickerItemNodes.length - 1 && (
                      <span className="t-mono t-xs t-dim">·</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── § 01 LIVE NOW ──────────────────────────────────────────── */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 40, paddingBottom: 40 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 01</span>
          <span className="sect-head-title">LIVE NOW</span>
          <span className="sect-head-meta">
            {activeDuelId !== null && !isDuelLoading
              ? `duel #${activeDuelIdStr} · round ${currentTurn}/${totalTurns}`
              : activeDuelId !== null
              ? 'loading…'
              : 'no active duel'}
          </span>
        </div>

        {/* On-chain duel card when active */}
        {activeDuelId !== null && !isDuelLoading && duel ? (
          <div className="col gap-16">
            <DuelCard
              duelId={activeDuelId}
              fighterAIndex={duel.fighterA}
              fighterBIndex={duel.fighterB}
            />
            <div className="row ai-c jc-c gap-12">
              <Link href={`/duel/${activeDuelIdStr}`}>
                <BracketButton variant="primary">WATCH LIVE →</BracketButton>
              </Link>
            </div>
          </div>
        ) : activeDuelId !== null && isDuelLoading ? (
          <div className="card pad-24 col ai-c gap-8">
            <span className="t-mono t-xs t-dim">Loading duel data…</span>
          </div>
        ) : (
          /* Empty state — no active duel */
          <div
            className="card pad-24 col ai-c gap-16"
            style={{ borderStyle: 'dashed', borderColor: 'var(--text-faint)' }}
          >
            <span className="t-display" style={{ fontSize: 48, color: 'var(--text-faint)', lineHeight: 1 }}>◌</span>
            <div className="col ai-c gap-4">
              <span className="t-mono t-sm" style={{ color: 'var(--text-dim)' }}>ARENA IS DARK</span>
              <span className="t-xs t-dim" style={{ textAlign: 'center' }}>
                No active duel — be the first to start one
              </span>
            </div>
            <button
              className="bk bk-primary"
              style={{ padding: '10px 24px', letterSpacing: '0.08em' }}
              onClick={() => openCreator()}
            >
              START A DUEL →
            </button>
          </div>
        )}

      </section>

      {/* ── § 02 · QUEUE STATE ────────────────────────────────────── */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">QUEUE STATE</span>
          <span className="sect-head-meta">
            {isQueueLoading ? 'loading…' : 'matchmaker slots — join a tier to queue up'}
          </span>
        </div>

        <div className="row gap-16" style={{ flexWrap: 'wrap' }}>
          {([3, 6, 9, 15] as QueueTier[]).map((turns) => {
            const TIER_POOL_LABELS: Record<QueueTier, string> = {
              3:  'SOMI',
              6:  'SOMI · WETH',
              9:  'SOMI · WETH · WBTC',
              15: 'ALL POOLS',
            };
            const slot = queueSlots[turns];
            const fighterName = slot
              ? (ROSTER.find(r => r.id === fighterIndexToId(slot.fighter))?.name ?? `FIGHTER #${slot.fighter}`)
              : null;
            const fighterHex = slot
              ? (FIGHTER_VISUAL_MAP[slot.fighter]?.hex ?? 'var(--text-dim)')
              : null;

            return (
              <div
                key={turns}
                className="card pad-16 col gap-12 flex-1"
                style={{ minWidth: 'min(100%, 200px)', flex: '1 1 200px' }}
              >
                {/* Tier label */}
                <div className="row jc-sb ai-c">
                  <span className="t-display t-up" style={{ fontSize: 18, letterSpacing: '0.08em', color: 'var(--text)' }}>
                    {turns} ROUNDS
                  </span>
                  {slot ? (
                    <Chip variant="live"><Dot variant="a" pulse /> WAITING</Chip>
                  ) : (
                    <Chip variant="default">OPEN</Chip>
                  )}
                </div>

                {/* Pool label */}
                <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.12em' }}>
                  {TIER_POOL_LABELS[turns]}
                </span>

                <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

                {/* Status line */}
                {slot ? (
                  <div className="row ai-c gap-8">
                    <span
                      className="t-mono t-xs"
                      style={{ color: fighterHex ?? 'var(--text)' }}
                    >
                      ● {fighterName}
                    </span>
                    <span className="t-mono t-xs t-dim">waiting for opponent</span>
                  </div>
                ) : (
                  <span className="t-mono t-xs t-dim">no one waiting — be first</span>
                )}

                {/* JOIN button */}
                <button
                  className="bk bk-ghost"
                  style={{ padding: '8px 16px', letterSpacing: '0.08em', marginTop: 4 }}
                  onClick={() => openCreator(turns)}
                >
                  {slot ? 'JOIN →' : 'START →'}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── § 02.5 CREATE NEW DUEL ────────────────────────────────── */}
      <section ref={creatorRef} className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <div
          className="sect-head"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            // Header toggle opens the generic creator (selectable tier).
            if (!creatorExpanded) setLockedTurns(null);
            setCreatorExpanded(v => !v);
          }}
        >
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">{lockedTurns ? `JOIN ${lockedTurns}-ROUND TIER` : 'CREATE NEW DUEL'}</span>
          <span className="sect-head-meta">{creatorExpanded ? '▲ collapse' : '▼ expand to start a duel'}</span>
        </div>

        {creatorExpanded && (
          <div style={{ maxWidth: 520 }}>
            <DuelCreator
              lockedTurns={lockedTurns ?? undefined}
              onMatchFound={(duelId) => {
                setCreatorExpanded(false);
                // Auto-enter the arena the moment the match starts on-chain, so the
                // queued player doesn't have to refresh/click to see their duel.
                router.push(`/duel/${duelId.toString()}`);
              }}
            />
          </div>
        )}
      </section>

      {/* ── § 03 STANDINGS ─────────────────────────────────────────── */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 03</span>
          <span className="sect-head-title">STANDINGS</span>
          <span className="sect-head-meta"></span>
        </div>

        <div className="card" style={{ padding: '0 clamp(12px, 3vw, 28px)', overflow: 'hidden' }}>
          {/* Header row */}
          <div
            className="standings-grid standings-head"
            style={{ borderBottom: '1px solid var(--text-faint)' }}
          >
            <span className="label-tiny">#</span>
            <span className="label-tiny">FIGHTER</span>
            <span className="label-tiny">RECORD</span>
            <span className="label-tiny" style={{ textAlign: 'right' }}>TOTAL PNL</span>
            <span className="label-tiny">FORM</span>
          </div>

          {leaderboardEmpty ? (
            <div
              className="row ai-c jc-c"
              style={{ padding: '28px 0', color: 'var(--text-faint)' }}
            >
              <span className="t-mono t-xs" style={{ letterSpacing: '0.2em', textAlign: 'center' }}>
                No settled duels yet — standings populate as fighters duel.
              </span>
            </div>
          ) : (
            leaderboardRows.map((r, i) => {
              const fighterId = fighterIndexToId(r.index);
              const hasDuels = r.duels > 0;
              const isPos = r.pnl >= BigInt(0);
              const absPnl = parseFloat(formatUnits(r.pnl < BigInt(0) ? -r.pnl : r.pnl, 18));
              // Adaptive precision so sub-cent PnL is still visible (these duels
              // can end near-tie with PnL well under a cent).
              const pnlDecimals = absPnl > 0 && absPnl < 0.01 ? 4 : 2;
              const pnlAbs = absPnl.toFixed(pnlDecimals);
              const pnlSign = r.pnl > BigInt(0) ? '+' : r.pnl < BigInt(0) ? '-' : '';
              // FORM = win rate (wins / duels), left-anchored bar.
              const winRate = hasDuels ? r.wins / r.duels : 0;
              return (
                <div
                  key={r.index}
                  className="standings-grid"
                  style={{
                    borderBottom: i < leaderboardRows.length - 1 ? '1px solid var(--border)' : 'none',
                    cursor: 'pointer',
                  }}
                  onClick={() => { window.location.href = `/fighters/${fighterId}`; }}
                >
                  <span className="st-rank t-num t-sm t-dim">{String(i + 1).padStart(2, '0')}</span>
                  <div className="st-name row ai-c" style={{ gap: 10, minWidth: 0, overflow: 'hidden' }}>
                    <FighterAvatar fighter={fighterId} context="mini" size={28} />
                    <span className="t-display t-up" style={{ color: r.hex, letterSpacing: '0.08em', fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                  </div>
                  <span className="st-rec t-num t-sm">{r.wins}W-{r.losses}L</span>
                  <span
                    className="st-pnl t-num"
                    style={{ textAlign: 'right', color: !hasDuels ? 'var(--text-faint)' : isPos ? 'var(--win)' : 'var(--loss)' }}
                  >
                    {hasDuels ? `${pnlSign}$${pnlAbs}` : '—'}
                  </span>
                  <div
                    className="st-form"
                    style={{ height: 4, background: 'var(--bg-card-2)', position: 'relative' }}
                    title={hasDuels ? `${Math.round(winRate * 100)}% win rate (${r.wins}/${r.duels})` : 'no duels yet'}
                  >
                    {hasDuels && (
                      <div
                        style={{
                          position: 'absolute',
                          top: 0,
                          bottom: 0,
                          left: 0,
                          width: `${winRate * 100}%`,
                          background: winRate >= 0.5 ? 'var(--win)' : 'var(--loss)',
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* ── § 04 YOUR LEDGER ───────────────────────────────────────── */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 04</span>
          <span className="sect-head-title">YOUR LEDGER</span>
          <span className="sect-head-meta">bets placed via Bookmaker (from on-chain events for the connected wallet)</span>
        </div>

        <div className="row gap-16" style={{ flexWrap: 'wrap' }}>
          {!walletAddress ? (
            <div
              className="card pad-16 col ai-c jc-c"
              style={{ minHeight: 100, width: '100%', color: 'var(--text-faint)' }}
            >
              <span className="t-mono t-xs" style={{ letterSpacing: '0.2em' }}>
                Connect wallet to see your bets.
              </span>
            </div>
          ) : betsLoading ? (
            <div
              className="card pad-16 col ai-c jc-c"
              style={{ minHeight: 100, width: '100%', color: 'var(--text-faint)' }}
            >
              <span className="t-mono t-xs" style={{ letterSpacing: '0.2em' }}>
                LOADING BETS…
              </span>
            </div>
          ) : betsEmpty ? (
            <div
              className="card pad-16 col ai-c jc-c"
              style={{ minHeight: 100, width: '100%', color: 'var(--text-faint)' }}
            >
              <span className="t-mono t-xs" style={{ letterSpacing: '0.2em' }}>
                No bets yet. Place a bet during an active duel.
              </span>
            </div>
          ) : (
            myBets.map((b) => {
              const fighterId = fighterIndexToId(b.fighterId);
              const rosterEntry = ROSTER.find((r) => r.id === fighterId);
              const fighterName = rosterEntry?.name ?? `FIGHTER #${b.fighterId}`;
              const stakeUsd = parseFloat(formatUnits(b.stake, 18)).toFixed(2);
              const oddsPct = (b.oddsBps / 100).toFixed(0);
              return (
                <div
                  key={b.betIndex.toString()}
                  className="card pad-16 col gap-8 flex-1"
                  style={{ minWidth: 'min(100%, 220px)' }}
                >
                  <div className="row jc-sb ai-c">
                    <Chip variant="live"><Dot variant="a" /> PLACED</Chip>
                    <span className="t-mono t-xs t-faint">duel #{b.duelId.toString()}</span>
                  </div>
                  <span className="t-mono t-sm">{fighterName}</span>
                  <hr className="divider" />
                  <span className="t-mono t-xs t-dim">${stakeUsd} @ {oddsPct}%</span>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
