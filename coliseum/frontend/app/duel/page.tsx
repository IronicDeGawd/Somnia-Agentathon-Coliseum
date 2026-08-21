'use client';

import React, { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { BracketButton, Chip, Dot } from '@/components/shared/OtherHUD';
import { DuelCreator } from '@/components/shared/DuelCreator';
import DuelCard from '@/components/shared/DuelCard';
import { useActiveDuels } from '@/hooks/useActiveDuels';
import { useDuelState } from '@/hooks/useDuelState';
import { useQueueState, queueKey, type QueueTier } from '@/hooks/useQueueState';
import { useEventQuestions } from '@/hooks/useEventQuestions';
import { usePerpMarkets } from '@/hooks/usePerpMarkets';
import { LOBBY_MENU, MarketKind, MARKET_LABEL } from '@/lib/contracts';
import { useLeaderboard } from '@/hooks/useLeaderboard';
import { useMyBets } from '@/hooks/useMyBets';
import { fighterIndexToId, FIGHTER_VISUAL_MAP, fighterNameOf } from '@/lib/fighters';
import { useDuelMarkets } from '@/hooks/useDuelMarkets';
import { fightLengthLabel } from '@/lib/fightLength';
import { formatUnits } from 'viem';
import { useAccount } from 'wagmi';

// On-chain fighter index → roster id comes from lib/fighters (fighterIndexToId).
// A local copy of that mapping used to live here and had drifted out of registry
// order — it named index two Scalper (it is The Quant) and indexes three and four
// as fighters that no longer exist, so the headline duel card mislabelled them.
// The rest of this page already used the shared helper; the hero now does too.

/** One colour per market, so a card is identifiable before its label is read.
 *  Matches the market picker in DuelCreator. */
const MARKET_ACCENT: Record<MarketKind, string> = {
  [MarketKind.Events]: 'var(--gold)',
  [MarketKind.Perps]: 'var(--market-perps)',
  [MarketKind.Spot]: 'var(--market-spot)',
  [MarketKind.Practice]: 'var(--market-practice)',
};

/** The order the markets are presented in: cheapest game first, mock last. */
const MARKET_ORDER: MarketKind[] = [
  MarketKind.Events,
  MarketKind.Perps,
  MarketKind.Spot,
  MarketKind.Practice,
];

/** The same glyph each market carries in the picker and on a live card. */
const MARKET_MARK: Record<MarketKind, string> = {
  [MarketKind.Events]: '◆',
  [MarketKind.Perps]: '◇',
  [MarketKind.Spot]: '⚡',
  [MarketKind.Practice]: '🧪',
};

/**
 * One line saying what the market is, replacing the pool list that used to sit
 * on every card. Events is absent on purpose — its questions change every
 * fifteen minutes, so that line is read from the chain instead of written here.
 */
const MARKET_BLURB: Record<MarketKind, string> = {
  [MarketKind.Events]: '',
  [MarketKind.Perps]: 'margin desks — assets vary by length',
  [MarketKind.Spot]: 'real order books — more coins the longer the fight',
  [MarketKind.Practice]: 'mock books — no real money at stake',
};

export default function LobbyPage() {
  const router = useRouter();
  const [creatorExpanded, setCreatorExpanded] = useState(false);
  // When set, the creator opens with the tier fixed (joining a specific tier);
  // null means the generic creator with a selectable tier.
  const [lockedTurns, setLockedTurns] = useState<QueueTier | null>(null);
  // The market has to be locked alongside the tier. Joining a nine-round SPOT
  // line used to open the creator fixed at nine rounds but on whatever market
  // was last selected — and the picker is disabled while locked, so there was no
  // way back. The waiting line you clicked and the one you would have joined
  // could be different games.
  const [lockedMarket, setLockedMarket] = useState<MarketKind | null>(null);
  const creatorRef = useRef<HTMLElement>(null);

  // The "START A DUEL" buttons live at the top of the page, but the creator
  // form renders several sections down. Expanding alone gives no visible
  // feedback, so scroll the now-open form into view on the next paint.
  // Pass a tier to lock the round (JOIN on a card); omit it for the generic form.
  const openCreator = useCallback((turns?: QueueTier, market?: MarketKind) => {
    setLockedTurns(turns ?? null);
    setLockedMarket(market ?? null);
    setCreatorExpanded(true);
    requestAnimationFrame(() =>
      creatorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }, []);

  const {
    duels: liveDuels,
    hasCapacity,
    maxActiveDuels,
    isLoading: isDuelLoading,
    error: duelError,
    refetch: refetchActiveDuel,
  } = useActiveDuels();
  // The hero shows one headline fight; the rest are listed below it.
  const headline = liveDuels[0] ?? null;
  const activeDuelId = headline?.duelId ?? null;
  const duel = headline?.duel ?? null;
  // The lobby is an index, so it shows a handful and links to the rest. Keep this
  // in step with the grid's column count: four fills two rows on a laptop.
  const LOBBY_LIVE_LIMIT = 4;
  const shownDuels = liveDuels.slice(0, LOBBY_LIVE_LIMIT);
  const hiddenCount = Math.max(0, liveDuels.length - shownDuels.length);
  // One batched read set for every card's market badge, deduped across fights —
  // see useDuelMarkets for why this is not useDuelSlots per card.
  const markets = useDuelMarkets(
    shownDuels.map(({ duelId, duel: d }) => ({ duelId, simulated: d.simulated })),
  );
  const { rows: leaderboardRows, isEmpty: leaderboardEmpty } = useLeaderboard();
  const { bets: myBets, isEmpty: betsEmpty, isLoading: betsLoading } = useMyBets();
  const { address: walletAddress } = useAccount();
  const { questions: eventQuestions } = useEventQuestions();
  const { offers: perpOffers } = usePerpMarkets();
  const { slots: queueSlots, pendingCounts, isLoading: isQueueLoading } = useQueueState();

  /** How many fighters are standing in a line right now, across all twelve. */
  const waitingCount = Object.values(queueSlots).filter(Boolean).length;

  /**
   * What a given line actually trades. Used for a tier chip's tooltip — the
   * detail that matters when comparing two lengths of the same market, and never
   * when choosing between markets, which is why it is no longer on the face of
   * the card.
   *
   * Perps is the only market whose assets differ BY LENGTH and change on their
   * own: a market leaves the cheap tiers when its margin rises with open
   * interest and walks back in when that eases, so each answer is read from the
   * chain. Naming spot's coin books there would list three assets the fight will
   * not touch. Events trades the same live questions at every length.
   */
  const poolLabelFor = useCallback((market: MarketKind, turns: QueueTier): string => {
    if (market === MarketKind.Events) {
      return eventQuestions.length ? eventQuestions.join(' · ') : 'live questions';
    }
    if (market === MarketKind.Perps) {
      const offer = perpOffers.find((x) => x.turns === turns);
      if (!offer) return 'reading…';
      if (offer.unavailable) return 'not enough markets';
      return offer.markets.length ? offer.markets.join(' · ') : 'chosen at start';
    }
    const SPOT_POOLS: Record<QueueTier, string> = {
      3: 'SOMI',
      6: 'SOMI · WETH',
      9: 'SOMI · WETH · WBTC',
      15: 'ALL POOLS',
    };
    return SPOT_POOLS[turns];
  }, [eventQuestions, perpOffers]);
  // Live betting odds for the active duel (real Bookmaker pools, 0 = disabled).
  const { odds: liveOdds } = useDuelState(activeDuelId ?? BigInt(0));

  // Derive display values from on-chain duel when available
  const activeDuelIdStr = activeDuelId !== null ? activeDuelId.toString() : null;
  const currentTurn = duel ? Math.floor(duel.completedCallbacks / 2) : 0;
  const totalTurns = duel?.turns ?? 15;
  const fighterAIndex = duel?.fighterA ?? 0;
  const fighterBIndex = duel?.fighterB ?? 1;
  const fighterAId = fighterIndexToId(fighterAIndex);
  const fighterBId = fighterIndexToId(fighterBIndex);
  const fighterAName = fighterNameOf(fighterAIndex);
  const fighterBName = fighterNameOf(fighterBIndex);

  // Real on-chain stats for the hero strip. Purse = both duelists' staked pot
  // (initialUsdsoPerFighter × 2). Odds = live Bookmaker spectator odds (fighter A %).
  const pursePot = duel ? duel.initialUsdsoPerFighter * BigInt(2) : BigInt(0);
  const liveOddsAPct = liveOdds ? Math.round(liveOdds.degenBps / 100) : 50;

  // Ticker items — prices deferred to future price-feed wiring
  const tickerItemNodes: React.ReactNode[] = [
    <>WBTC/USDso <span className="t-num t-dim">—</span></>,
    <>WETH/USDso <span className="t-num t-dim">—</span></>,
    <>SOMI/USDso <span className="t-num t-dim">—</span></>,
    <>{maxActiveDuels > 0 ? `UP TO ${maxActiveDuels} DUELS AT ONCE` : 'THE ARENA'}</>,
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
              ) : duelError ? (
                // A failed read is not the same as an empty arena — saying
                // "ARENA DARK" here claims knowledge we do not have.
                <span className="row gap-8 ai-c" role="alert">
                  <Chip variant="loss">⚠ ARENA UNREACHABLE</Chip>
                  <BracketButton variant="ghost" onClick={() => refetchActiveDuel()}>RETRY →</BracketButton>
                </span>
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
              ? liveDuels.length === 1
                ? `duel #${activeDuelIdStr} · round ${currentTurn}/${totalTurns}`
                : hiddenCount > 0
                  ? `${liveDuels.length} fights running · showing ${shownDuels.length}`
                  : `${liveDuels.length} fights running`
              : activeDuelId !== null
              ? 'loading…'
              : 'no active duel'}
          </span>
        </div>

        {/* THE LIVE SECTION IS A GRID, NOT A STACK.
            It used to render one full-width card per fight, one under another, with
            a WATCH button beneath each. That reads well for one fight and falls
            apart past three: six concurrent fights pushed the queue board, the
            standings and the creator entirely below the fold, and the arena can hold
            six today with no ceiling on what a busier deployment would show.

            So the lobby shows the FOUR most recent and hands the rest to a page of
            their own. Four because it fills two tidy rows on a laptop and one on a
            phone, and because a lobby is an index — the place you decide what to
            watch, not the place you watch it. */}
        {activeDuelId !== null && !isDuelLoading && duel ? (
          <div className="col gap-16">
            <div className="live-grid">
              {shownDuels.map(({ duelId, duel: d }) => (
                <DuelCard
                  key={duelId.toString()}
                  duelId={duelId}
                  fighterAIndex={d.fighterA}
                  fighterBIndex={d.fighterB}
                  market={markets.get(duelId.toString())}
                />
              ))}
            </div>

            <div className="row ai-c jc-c gap-12" style={{ flexWrap: 'wrap' }}>
              <Link href={`/duel/${activeDuelIdStr}`}>
                <BracketButton variant="primary">WATCH LIVE →</BracketButton>
              </Link>
              {/* Only offered when there is genuinely more to see. A permanent
                  "see all" on a lobby showing everything it has is a dead end. */}
              {hiddenCount > 0 && (
                <Link href="/duel/live">
                  <BracketButton variant="ghost">
                    ALL {liveDuels.length} LIVE FIGHTS →
                  </BracketButton>
                </Link>
              )}
            </div>

            {!hasCapacity && (
              <span className="t-mono t-xs t-dim" style={{ textAlign: 'center' }}>
                every ring is full ({liveDuels.length}/{maxActiveDuels}) — new challengers join the queue and start as duels finish
              </span>
            )}
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
      {/* GROUPED BY MARKET, NOT ONE CARD PER LINE.
          There are twelve waiting lines, and a card each carried seven things —
          the tier, the market, an open/waiting chip, a queued-pairs count that
          is almost always zero, the pool list, the length, and a status line
          repeating what the chip already said. Eighty-four items to read before
          picking one fight.

          A market is the real choice — a prediction, a margin position, real
          coin books, or a mock — and the round count is a detail within it. So
          the market says itself once, at full size, and its lengths sit under it
          as small chips. The pool list moves to the chip's tooltip: it matters
          when comparing two tiers of the same market and never when choosing
          between markets. The queued count appears only when it is not zero. */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">QUEUE STATE</span>
          <span className="sect-head-meta">
            {isQueueLoading
              ? 'loading…'
              : waitingCount > 0
              ? `${waitingCount} fighter${waitingCount === 1 ? '' : 's'} waiting for an opponent`
              : 'nobody waiting — pick a market and be first'}
          </span>
        </div>

        <div className="col gap-12">
          {MARKET_ORDER.filter((m) => LOBBY_MENU.some((r) => r.market === m)).map((market) => {
            const accent = MARKET_ACCENT[market];
            const tiers = LOBBY_MENU
              .filter((r) => r.market === market)
              .map((r) => r.turns as QueueTier);

            return (
              <div key={market} className="card pad-16 col gap-12">
                {/* What this market IS, said once instead of once per tier.
                    Left-aligned rather than pushed to opposite ends of the card:
                    the second half describes the first, and nine hundred pixels
                    of gap between them reads as two unrelated labels. */}
                <div className="row ai-c gap-10" style={{ flexWrap: 'wrap' }}>
                  <span
                    className="t-display t-up"
                    style={{ fontSize: 16, letterSpacing: '0.08em', color: accent }}
                  >
                    <span aria-hidden="true">{MARKET_MARK[market]} </span>
                    {MARKET_LABEL[market]}
                  </span>
                  <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.08em' }}>
                    {market === MarketKind.Events
                      ? (eventQuestions.length ? eventQuestions.join(' · ') : 'live questions')
                      : MARKET_BLURB[market]}
                  </span>
                </div>

                {/* One chip per length. Auto-fit so four sit in a row on a wide
                    screen and wrap rather than shrink to nothing on a phone. */}
                <div className="queue-tiers">
                  {tiers.map((turns) => {
                    const key = queueKey(turns, market);
                    const slot = queueSlots[key];
                    const pending = pendingCounts[key] ?? 0;
                    const fighterName = slot ? fighterNameOf(slot.fighter) : null;
                    const fighterHex = slot
                      ? (FIGHTER_VISUAL_MAP[slot.fighter]?.hex ?? 'var(--text-dim)')
                      : null;
                    const pools = poolLabelFor(market, turns);
                    const length = fightLengthLabel(turns);

                    return (
                      <button
                        key={key}
                        type="button"
                        className="queue-tier"
                        onClick={() => openCreator(turns, market)}
                        /* The tooltip carries what used to be a whole line of the
                           card. Also spelled into the aria-label, because a title
                           attribute is not reliably announced. */
                        title={`${pools} · ${length}${pending > 0 ? ` · ${pending} pair${pending === 1 ? '' : 's'} queued` : ''}`}
                        aria-label={
                          `${slot ? 'Join' : 'Start'} the ${turns} round ${MARKET_LABEL[market].toLowerCase()} line. ` +
                          `Roughly ${length.replace('~', '').replace('–', ' to ').replace(' MIN', ' minutes')}. ` +
                          `${fighterName ? `${fighterName} is waiting for an opponent.` : 'Nobody waiting yet.'}`
                        }
                        style={{ borderColor: slot ? accent : 'var(--border)' }}
                      >
                        <span className="row ai-c gap-6">
                          {/* A dot only when somebody is actually there. An
                              always-present marker teaches the eye to ignore it. */}
                          {slot && (
                            <span
                              className="dot pulse"
                              style={{ background: fighterHex ?? accent }}
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className="t-display"
                            style={{ fontSize: 18, lineHeight: 1, color: slot ? accent : 'var(--text)' }}
                          >
                            {turns}R
                          </span>
                        </span>
                        <span className="t-mono t-xs" style={{ color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                          {length}
                        </span>
                        {/* The third line is the only one that changes on its own,
                            so it is the only one worth a colour. */}
                        <span
                          className="t-mono t-xs"
                          style={{
                            color: fighterHex ?? 'var(--text-faint)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: '100%',
                          }}
                        >
                          {fighterName ? `${fighterName} waiting` : pending > 0 ? `${pending} queued` : 'open'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── § 02.5 CREATE NEW DUEL ────────────────────────────────── */}
      <section ref={creatorRef} className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 40 }}>
        {/* This is the primary way into starting a duel, so it is a real
            button: focusable, Enter/Space operable, and it announces its
            expanded state. */}
        <button
          type="button"
          className="sect-head"
          aria-expanded={creatorExpanded}
          aria-controls="duel-creator-panel"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            // Header toggle opens the generic creator (selectable tier).
            if (!creatorExpanded) { setLockedTurns(null); setLockedMarket(null); }
            setCreatorExpanded(v => !v);
          }}
        >
          <span className="sect-head-num">§ 03</span>
          <span className="sect-head-title">{lockedTurns ? `JOIN ${lockedTurns}-ROUND TIER` : 'CREATE NEW DUEL'}</span>
          <span className="sect-head-meta">{creatorExpanded ? '▲ collapse' : '▼ expand to start a duel'}</span>
        </button>

        {/* Full width, like every other section on this page. It used to be
            capped at 520px, which left it hugging the left edge under a
            full-width heading and read as a layout fault rather than a choice.
            The panel's own grids are all auto-fit, so they spread rather than
            stretch. */}
        {creatorExpanded && (
          <div id="duel-creator-panel">
            <DuelCreator
              lockedTurns={lockedTurns ?? undefined}
              lockedMarket={lockedMarket ?? undefined}
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
          <span className="sect-head-num">§ 04</span>
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
                // A row is navigation, so it is a link: focusable and
                // keyboard-operable for free, and routed client-side rather
                // than through a full page reload.
                <Link
                  key={r.index}
                  href={`/fighters/${fighterId}`}
                  className="standings-grid"
                  style={{
                    borderBottom: i < leaderboardRows.length - 1 ? '1px solid var(--border)' : 'none',
                    cursor: 'pointer',
                    color: 'inherit',
                    textDecoration: 'none',
                  }}
                >
                  <span className="st-rank t-num t-sm t-dim">{String(i + 1).padStart(2, '0')}</span>
                  <div className="st-name row ai-c" style={{ gap: 10, minWidth: 0, overflow: 'hidden' }}>
                    <FighterAvatar fighter={fighterId} context="mini" size={28} />
                    <span className="t-display t-up" style={{ color: r.hex, letterSpacing: '0.08em', fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                  </div>
                  <span className="st-rec t-num t-sm">
                    {r.wins}W-{r.losses}L{r.draws > 0 ? `-${r.draws}D` : ''}
                  </span>
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
                </Link>
              );
            })
          )}
        </div>
      </section>

      {/* ── § 04 YOUR LEDGER ───────────────────────────────────────── */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 05</span>
          <span className="sect-head-title">YOUR LEDGER</span>
          <span className="sect-head-meta">your bets, read from chain for the connected wallet</span>
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
              const fighterName = fighterNameOf(b.fighterId);
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
