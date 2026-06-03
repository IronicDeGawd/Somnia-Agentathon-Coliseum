'use client';

import React, { useReducer, useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { Sparkline } from '@/components/shared/Sparkline';
import { OddsBar } from '@/components/shared/OddsBar';
import { BracketButton, Chip, Dot } from '@/components/shared/OtherHUD';
import { DuelCreator } from '@/components/shared/DuelCreator';
import DuelCard from '@/components/shared/DuelCard';
import { useActiveDuel } from '@/hooks/useActiveDuel';
import { useQueueState, type QueueTier } from '@/hooks/useQueueState';
import { simReducer, makeInitialSim } from '@/lib/simulation';
import { ROSTER, fighterIndexToId, FIGHTER_VISUAL_MAP } from '@/lib/fighters';
import { fmtUsd, fmtTime } from '@/lib/format';

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
  const [sim, dispatch] = useReducer(simReducer, makeInitialSim());
  const [creatorExpanded, setCreatorExpanded] = useState(false);
  const creatorRef = useRef<HTMLElement>(null);

  // The "START A DUEL" buttons live at the top of the page, but the creator
  // form renders several sections down. Expanding alone gives no visible
  // feedback, so scroll the now-open form into view on the next paint.
  const openCreator = useCallback(() => {
    setCreatorExpanded(true);
    requestAnimationFrame(() =>
      creatorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }, []);

  const { activeDuelId, duel, isLoading: isDuelLoading } = useActiveDuel();
  const { slots: queueSlots, isLoading: isQueueLoading } = useQueueState();

  useEffect(() => {
    const clock = setInterval(() => dispatch({ type: 'TICK' }), 1000);
    return () => clearInterval(clock);
  }, []);

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

  // Ticker items — prices deferred to future price-feed wiring
  const tickerItemNodes: React.ReactNode[] = [
    <>WBTC/USDso <span className="t-num t-dim">—</span></>,
    <>WETH/USDso <span className="t-num t-dim">—</span></>,
    <>SOMI/USDso <span className="t-num t-dim">—</span></>,
    <>VOLUME 24H <span className="t-num">$12.4M</span></>,
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

          {/* 4-up stat strip — BELL IN / PURSE / ODDS / BETTORS */}
          <div className="row gap-32 ai-c jc-c" style={{ marginTop: 8 }}>
            <div className="col ai-c gap-2">
              <span className="eyebrow">BELL IN</span>
              <span className="t-num text-gold" style={{ fontSize: 36, lineHeight: 1 }}>
                {activeDuelId !== null ? fmtTime(sim.countdown) : '—'}
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">PURSE</span>
              <span className="t-num text-gold" style={{ fontSize: 36, lineHeight: 1 }}>
                {activeDuelId !== null ? `$${sim.potNext}` : '—'}
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">ODDS</span>
              <span className="t-num" style={{ fontSize: 36, lineHeight: 1, whiteSpace: 'nowrap' }}>
                {activeDuelId !== null ? (
                  <>
                    <span className="text-a">{sim.oddsDegen}</span>
                    <span style={{ color: 'var(--text-faint)', fontSize: 22 }}> · </span>
                    <span className="text-b">{100 - sim.oddsDegen}</span>
                  </>
                ) : (
                  <span className="t-dim">—</span>
                )}
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">ROUND</span>
              <span className="t-num" style={{ fontSize: 36, lineHeight: 1, color: 'var(--text)' }}>
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
                onClick={openCreator}
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
              onClick={openCreator}
            >
              START A DUEL →
            </button>
          </div>
        )}

        {/* Sim-driven sparkline preview (always shown as fight preview) */}
        {activeDuelId !== null && (
          <div className="card corner-card acc-a glow-a" style={{ overflow: 'hidden' }}>
            {/* Header strip */}
            <div
              className="row ai-c"
              style={{
                padding: '10px 16px',
                background: 'linear-gradient(90deg, var(--fighter-a-soft), transparent 70%)',
                borderBottom: '1px solid var(--border)',
                gap: 12,
              }}
            >
              <Chip variant="live"><Dot variant="a" pulse /> LIVE</Chip>
              <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>
                R<span className="t-num" style={{ color: 'var(--text)' }}>{sim.round}/{totalTurns}</span>
                <span style={{ margin: '0 8px' }}>·</span>
                <span className="t-num" style={{ color: 'var(--text)' }}>{fmtTime(sim.timeLeft)}</span> left
              </span>
              <div className="grow" />
              <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>{sim.spectators} watching</span>
            </div>

            {/* Two-fighter body */}
            <div className="row gap-24" style={{ padding: 24, alignItems: 'stretch' }}>
              <div className="col gap-12 flex-1">
                <div className="row jc-sb ai-c">
                  <div className="row ai-c" style={{ gap: 10 }}>
                    <FighterAvatar fighter={fighterAId} context="mini" size={32} />
                    <span className="t-display t-up" style={{ color: 'var(--fighter-a)', letterSpacing: '0.12em', fontSize: 14 }}>{fighterAName}</span>
                  </div>
                  <span className="t-num" style={{ fontSize: 24, color: sim.degen.pnl >= 0 ? 'var(--win)' : 'var(--loss)' }}>
                    {fmtUsd(sim.degen.pnl)}
                  </span>
                </div>
                <Sparkline data={sim.degen.history} color="var(--fighter-a)" height={48} />
              </div>

              <div className="col ai-c jc-c" style={{ width: 60 }}>
                <span className="t-display" style={{ fontSize: 32, color: 'var(--text-faint)' }}>VS</span>
              </div>

              <div className="col gap-12 flex-1">
                <div className="row jc-sb ai-c">
                  <span className="t-num" style={{ fontSize: 24, color: sim.whale.pnl >= 0 ? 'var(--win)' : 'var(--loss)' }}>
                    {fmtUsd(sim.whale.pnl)}
                  </span>
                  <div className="row ai-c" style={{ gap: 10 }}>
                    <span className="t-display t-up" style={{ color: 'var(--fighter-b)', letterSpacing: '0.12em', fontSize: 14 }}>{fighterBName}</span>
                    <FighterAvatar fighter={fighterBId} context="mini" size={32} />
                  </div>
                </div>
                <Sparkline data={sim.whale.history} color="var(--fighter-b)" height={48} />
              </div>
            </div>

            {/* Footer: odds + WATCH LIVE */}
            <div
              className="row ai-c jc-sb"
              style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', background: 'var(--bg-stage)' }}
            >
              <div className="col gap-4" style={{ flex: 2 }}>
                <div className="row jc-sb t-mono t-xs">
                  <span className="text-a">{fighterAName} {sim.oddsDegen}%</span>
                  <span className="text-b">{fighterBName} {100 - sim.oddsDegen}%</span>
                </div>
                <OddsBar oddsA={sim.oddsDegen} oddsB={100 - sim.oddsDegen} className="!h-[8px]" />
              </div>
              <Link href={`/duel/${activeDuelIdStr}`} style={{ marginLeft: 24 }}>
                <BracketButton variant="a">JOIN SPECTATORS →</BracketButton>
              </Link>
            </div>
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

        <div className="row gap-16">
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
                style={{ minWidth: 0 }}
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
                  onClick={openCreator}
                >
                  JOIN →
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
          onClick={() => setCreatorExpanded(v => !v)}
        >
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">CREATE NEW DUEL</span>
          <span className="sect-head-meta">{creatorExpanded ? '▲ collapse' : '▼ expand to start a duel'}</span>
        </div>

        {creatorExpanded && (
          <div style={{ maxWidth: 520 }}>
            <DuelCreator onMatchFound={() => setCreatorExpanded(false)} />
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

          {ROSTER.map((r, i) => {
            const isPos = r.pnl >= 0;
            const maxAbs = 400;
            const w = Math.min(100, (Math.abs(r.pnl) / maxAbs) * 100);
            return (
              <div
                key={r.id}
                className="standings-grid"
                style={{
                  borderBottom: i < ROSTER.length - 1 ? '1px solid var(--border)' : 'none',
                  cursor: 'pointer',
                }}
                onClick={() => { window.location.href = `/fighters/${r.id}`; }}
              >
                <span className="st-rank t-num t-sm t-dim">{String(i + 1).padStart(2, '0')}</span>
                <div className="st-name row ai-c" style={{ gap: 10, minWidth: 0, overflow: 'hidden' }}>
                  <FighterAvatar fighter={r.id} context="mini" size={28} />
                  <span className="t-display t-up" style={{ color: r.hex, letterSpacing: '0.08em', fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                </div>
                <span className="st-rec t-num t-sm">{r.record}</span>
                <span className="st-pnl t-num" style={{ textAlign: 'right', color: isPos ? 'var(--win)' : 'var(--loss)' }}>
                  {fmtUsd(r.pnl)}
                </span>
                <div className="st-form" style={{ height: 4, background: 'var(--bg-card-2)', position: 'relative' }}>
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: isPos ? '50%' : `${50 - w / 2}%`,
                      width: `${w / 2}%`,
                      background: isPos ? 'var(--win)' : 'var(--loss)',
                    }}
                  />
                  <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'var(--text-faint)' }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── § 04 YOUR LEDGER ───────────────────────────────────────── */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 04</span>
          <span className="sect-head-title">YOUR LEDGER</span>
          <span className="sect-head-meta">bets placed via Bookmaker (from on-chain events for the connected wallet)</span>
        </div>

        <div className="row gap-16">
          {[
            { status: 'live', round: 341, fighters: 'DEGEN vs WHALE',      bet: '$5 on DEGEN @ 65%',   est: '+$2.69 est.', color: 'var(--win)' },
            { status: 'won',  round: 339, fighters: 'DEGEN vs CONTRARIAN', bet: '$10 on DEGEN @ 58%',  est: '+$7.24',      color: 'var(--win)' },
            { status: 'lost', round: 338, fighters: 'SCALPER vs SURFER',   bet: '$5 on SCALPER @ 47%', est: '−$5.00',      color: 'var(--loss)' },
            { status: 'won',  round: 336, fighters: 'WHALE vs DEGEN',      bet: '$8 on WHALE @ 51%',   est: '+$7.85',      color: 'var(--win)' },
          ].map((b) => (
            <div key={b.round} className="card pad-16 col gap-8 flex-1">
              <div className="row jc-sb ai-c">
                {b.status === 'live' ? (
                  <Chip variant="live"><Dot variant="a" pulse /> LIVE</Chip>
                ) : b.status === 'won' ? (
                  <Chip variant="win">WON</Chip>
                ) : (
                  <Chip variant="loss">LOST</Chip>
                )}
                <span className="t-mono t-xs t-faint">#{b.round}</span>
              </div>
              <span className="t-mono t-sm">{b.fighters}</span>
              <hr className="divider" />
              <span className="t-mono t-xs t-dim">{b.bet}</span>
              <span className="t-num" style={{ color: b.color, fontSize: 18 }}>{b.est}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
