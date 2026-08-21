'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { formatUnits, parseAbiItem } from 'viem';
import { useAccount, useChainId, useSwitchChain, usePublicClient } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useQueue } from '@/hooks/useQueue';
import { LOBBY_MENU, MarketKind, MARKET_LABEL } from '@/lib/contracts';
import { useQueueState, queueKey } from '@/hooks/useQueueState';
import { useEventQuestions } from '@/hooks/useEventQuestions';
import { usePerpMarkets } from '@/hooks/usePerpMarkets';
import type { PerpTierOffer } from '@/hooks/usePerpMarkets';
import { ROSTER, FIGHTER_VISUAL_MAP } from '@/lib/fighters';
import { CONTRACT_ADDRESSES, SIM_MARKET_ENABLED } from '@/lib/contracts';
import { getWsClient } from '@/lib/wsClient';
import { somniaTestnet } from '@/lib/chain';
import { fightLengthLabel } from '@/lib/fightLength';

const MATCH_STARTED_EVENT = parseAbiItem(
  'event MatchStarted(uint256 indexed duelId, address indexed playerA, address indexed playerB, uint8 fighterA, uint8 fighterB, uint16 turns)',
);

/** What each tier trades on the COIN markets. The ladder narrows for short
 *  fights because a smallest BTC order costs dollars. The events market does not
 *  use this — it trades questions, which all cost a fraction of a cent. */
const TIER_POOLS: Record<number, string[]> = {
  3:  ['SOMI'],
  6:  ['SOMI', 'WETH'],
  9:  ['SOMI', 'WETH', 'WBTC'],
  15: ['SOMI', 'WETH', 'WBTC'],
};


const MARKET_CHOICES: ReadonlyArray<{
  kind: MarketKind; label: string; accent: string; hint: string;
}> = [
  {
    kind: MarketKind.Events,
    label: '◆ EVENTS',
    accent: 'var(--gold)',
    hint: 'Three live prediction questions. Cheap at every length — even the longest fight costs about a USDso.',
  },
  {
    kind: MarketKind.Perps,
    label: '◇ PERPS',
    accent: 'var(--market-perps)',
    hint: 'Real assets on margin, so a fighter can bet one DOWN as well as up. A position is posted against rather than bought, which makes a long fight cost about a tenth of what spot does.',
  },
  {
    kind: MarketKind.Spot,
    label: '⚡ SPOT',
    accent: 'var(--market-spot)',
    hint: 'Real WETH, WBTC and SOMI order books. Far larger deposit, because one minimum BTC order costs dollars. SOMI is the chain\u2019s own coin, so a fighter can buy it but not sell it back \u2014 anything still held is valued at the closing price.',
  },
  ...(SIM_MARKET_ENABLED
    ? [{
        kind: MarketKind.Practice,
        label: '🧪 PRACTICE',
        accent: 'var(--market-practice)',
        hint: 'Mock books. No real market risk.',
      }]
    : []),
];

/**
 * The two things about a perps tier a player cannot work out from the buttons.
 *
 * FIRST, what the number buys. On every other market the tier number is a length
 * and nothing else. Here it is also a bankroll: the fighter is handed that much
 * collateral to post margin against, and the whole fight is decided by what it
 * does with it.
 *
 * SECOND, why the assets keep changing. A player who sees Bitcoin on the fifteen-
 * round tier one hour and not the next will read it as a bug. It is not: how much
 * margin a market demands rises with how much open interest it carries, so a busy
 * market prices itself out of the cheaper tiers on its own and walks back in when
 * it quietens. Which three a fight gets is settled at the moment it starts, from
 * what the budget can actually cover right then — so two fights at the same length
 * can legitimately trade different assets.
 */
function PerpsTierNote({ offer }: { offer?: PerpTierOffer }) {
  const budget = offer?.budget ?? BigInt(0);
  return (
    <div className="t-xs" style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>
      {budget > BigInt(0) && (
        <>
          Each fighter gets <strong style={{ color: 'var(--text)' }}>{formatUnits(budget, 18)} USDso</strong>{' '}
          of collateral to post margin against.{' '}
        </>
      )}
      The three assets are settled when the fight starts, from what that collateral
      can cover at the time — a market that gets busy demands more margin and drops
      out of the cheaper tiers by itself, so two fights at this length can trade
      different assets.
      {offer?.unavailable && (
        <span style={{ color: 'var(--loss)' }}>
          {' '}Fewer than three markets qualify right now, so a fight at this length
          would be refused.
        </span>
      )}
    </div>
  );
}

/// Events trades every question at every length, so this does not vary by tier.
/// The names come from the chain — the desks are re-pointed at fresh questions
/// between fights, so anything written in here would go stale within the hour.
function poolsFor(
  turns: number,
  market: MarketKind,
  questions: string[],
  perpMarkets: string[],
): string[] {
  if (market === MarketKind.Events) return questions.length ? questions : ['live questions'];
  // Perps picks its three from six at the moment a fight starts, sized to what the
  // budget can post margin for right then. So this is read from the chain per
  // tier, and two fights at the same length can legitimately differ.
  if (market === MarketKind.Perps) return perpMarkets.length ? perpMarkets : ['selected at start'];
  return TIER_POOLS[turns];
}

/** Round counts the lobby offers on a given market. */
function tiersFor(market: MarketKind): TurnOption[] {
  if (market === MarketKind.Practice) return [6, 9, 15];
  return LOBBY_MENU.filter((r) => r.market === market).map((r) => r.turns as TurnOption);
}

// Which rounds are offered on which market comes from LOBBY_MENU in
// lib/contracts, so the menu can change without touching this component.
/**
 * Any tier a duel can have, which still includes 3 — duels already on chain use it
 * and a locked join has to be able to name it. tiersFor(market) is the narrower
 * set a user may pick from.
 */
type TurnOption = 3 | 6 | 9 | 15;

interface DuelCreatorProps {
  onMatchFound?: (duelId: bigint) => void;
  // When set, the tier is fixed (e.g. joining a specific waiting opponent) —
  // the round selector is hidden and only the fighter is chosen.
  lockedTurns?: TurnOption;
  // The market has to be fixed alongside it. A locked creator DISABLES the
  // market picker, so opening it locked to nine rounds while the market still
  // said EVENTS left no way to reach the spot line the user had clicked — a
  // different game, at a different deposit, with no visible way back.
  lockedMarket?: MarketKind;
}

// Inner: re-created when fighter/turns change so hooks get stable args
function QueueInner({
  fighter,
  turns,
  market,
  locked,
  onMatchFound,
  onFighterChange,
  onTurnsChange,
  onMarketChange,
}: {
  fighter: number;
  turns: TurnOption;
  market: MarketKind;
  locked: boolean;
  onMatchFound?: (duelId: bigint) => void;
  onFighterChange: (idx: number) => void;
  onTurnsChange: (t: TurnOption) => void;
  onMarketChange: (m: MarketKind) => void;
}) {
  const {
    halfDeposit,
    usdsoBalance,
    hasEnough,
    enterQueue,
    cancelQueue,
    isPending,
    isSuccess,
    error,
  } = useQueue(fighter, turns, market);

  const { slots, isLoading: slotLoading, refetch: refetchSlots } = useQueueState();
  const { questions: eventQuestions } = useEventQuestions();
  const { offers: perpOffers } = usePerpMarkets();
  const perpFor = (t: number) => perpOffers.find((o) => o.turns === t)?.markets ?? [];

  const { isConnected, address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const wrongNetwork = isConnected && chainId !== somniaTestnet.id;
  const publicClient = usePublicClient();

  const [matchedDuelId, setMatchedDuelId] = useState<bigint | null>(null);
  const [queued, setQueued] = useState(false);
  // Guard against double-fire from WS + polling both catching the same match.
  const matchHandledRef = useRef(false);

  // When enterQueue succeeds, flip into waiting state
  useEffect(() => {
    if (isSuccess && !isPending) {
      matchHandledRef.current = false;
      setQueued(true);
    }
  }, [isSuccess, isPending]);

  // Stream MatchStarted over the dedicated WS client (eth_subscribe). wagmi's
  // useWatchContractEvent never fired here — the HTTP transport can't subscribe —
  // so a matched player had to manually reload to leave the queue. Only redirect
  // when *this* wallet is one of the two matched players.
  useEffect(() => {
    if (!queued || !address) return;
    const client = getWsClient();
    if (!client) return;
    const me = address.toLowerCase();
    let unwatch: (() => void) | undefined;
    try {
      unwatch = client.watchEvent({
        address: CONTRACT_ADDRESSES.Matchmaker,
        event: MATCH_STARTED_EVENT,
        onLogs(logs) {
          for (const log of logs) {
            const args = (log as unknown as {
              args?: { duelId?: bigint; playerA?: `0x${string}`; playerB?: `0x${string}` };
            }).args;
            if (args?.duelId === undefined) continue;
            const isMine =
              args.playerA?.toLowerCase() === me || args.playerB?.toLowerCase() === me;
            if (!isMine) continue;
            if (matchHandledRef.current) return;
            matchHandledRef.current = true;
            setMatchedDuelId(args.duelId);
            setQueued(false);
            onMatchFound?.(args.duelId);
            refetchSlots();
          }
        },
        onError: () => {},
      });
    } catch {
      // WS unavailable — polling fallback below will catch it.
    }
    return () => { try { unwatch?.(); } catch { /* already torn down */ } };
  }, [queued, address, onMatchFound, refetchSlots]);

  // Polling fallback: every 4s while queued, scan the last 200 blocks for a
  // MatchStarted event that includes this wallet. This fires even when the WS
  // log subscription doesn't deliver (common on public Somnia RPC).
  useEffect(() => {
    if (!queued || !address || !publicClient) return;
    const me = address.toLowerCase();

    const poll = async () => {
      if (matchHandledRef.current) return;
      try {
        const head = await publicClient.getBlockNumber();
        const fromBlock = head > BigInt(200) ? head - BigInt(200) : BigInt(0);
        const logs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.Matchmaker,
          event: MATCH_STARTED_EVENT,
          fromBlock,
          toBlock: 'latest',
        });
        for (const log of logs) {
          const args = (log as unknown as {
            args?: { duelId?: bigint; playerA?: `0x${string}`; playerB?: `0x${string}` };
          }).args;
          if (args?.duelId === undefined) continue;
          const isMine =
            args.playerA?.toLowerCase() === me || args.playerB?.toLowerCase() === me;
          if (!isMine) continue;
          if (matchHandledRef.current) return;
          matchHandledRef.current = true;
          setMatchedDuelId(args.duelId);
          setQueued(false);
          onMatchFound?.(args.duelId);
          refetchSlots();
          return;
        }
      } catch {
        // Non-fatal — next tick will retry.
      }
    };

    void poll();
    const interval = setInterval(() => { void poll(); }, 4_000);
    return () => clearInterval(interval);
  }, [queued, address, publicClient, onMatchFound, refetchSlots]);

  const halfDepositFormatted = halfDeposit !== null
    ? Number(formatUnits(halfDeposit, 18)).toFixed(2)
    : '—';

  const balanceFormatted = Number(formatUnits(usdsoBalance, 18)).toFixed(2);

  const currentSlot = slots[queueKey(turns, market)] ?? null;
  const fighterVisual = FIGHTER_VISUAL_MAP[fighter];
  const fighterRoster = ROSTER[fighter];

  const handleEnterQueue = useCallback(async () => {
    await enterQueue();
  }, [enterQueue]);

  const handleCancelQueue = useCallback(async () => {
    await cancelQueue();
    setQueued(false);
  }, [cancelQueue]);

  // Match found state
  if (matchedDuelId !== null) {
    return (
      <div className="col gap-24">
        <div
          className="panel pad-24 col gap-16"
          style={{
            borderColor: 'var(--win)',
            textAlign: 'center',
            animation: 'pulse 0.6s ease-in-out 3',
          }}
        >
          <div
            className="t-display t-up"
            style={{ color: 'var(--win)', fontSize: '13px', letterSpacing: '0.12em' }}
          >
            MATCH FOUND!
          </div>
          <div
            className="t-mono"
            style={{ color: 'var(--win)', fontSize: '28px', fontWeight: 700 }}
          >
            DUEL #{matchedDuelId.toString()}
          </div>
          <a
            href={`/duel/${matchedDuelId.toString()}`}
            className="bk bk-primary"
            style={{
              display: 'block',
              padding: '12px',
              textAlign: 'center',
              letterSpacing: '0.08em',
              fontSize: '13px',
              textDecoration: 'none',
            }}
          >
            ENTER THE ARENA →
          </a>
        </div>
      </div>
    );
  }

  // Waiting room state
  if (queued) {
    return (
      <div className="col gap-24">
        <div className="sect-head">
          <span className="sect-head-num">02</span>
          <span className="sect-head-title">WAITING FOR OPPONENT</span>
        </div>

        {/* Queued fighter display */}
        <div className="panel pad-24 col gap-16" style={{ textAlign: 'center' }}>
          <div className="eyebrow t-dim">QUEUED AS</div>
          <div
            className="t-mono"
            style={{
              fontSize: '22px',
              fontWeight: 700,
              color: fighterVisual?.hex ?? 'var(--text)',
              letterSpacing: '0.04em',
            }}
          >
            {fighterRoster?.name ?? `FIGHTER ${fighter}`}
          </div>
          <div className="t-sm t-dim">
            {turns}-round tier · {poolsFor(turns, market, eventQuestions, perpFor(turns)).join(' + ')}
          </div>

          {/* Animated pulse indicator */}
          <div className="row jc-c gap-8" style={{ marginTop: '8px' }}>
            <span className="dot pulse" style={{ background: 'var(--gold)' }} />
            <span className="t-sm t-dim">Waiting for opponent…</span>
          </div>
        </div>

        {/* Cancel */}
        <button
          className="bk bk-ghost"
          style={{
            width: '100%',
            padding: '12px',
            opacity: isPending ? 0.45 : 1,
            cursor: isPending ? 'not-allowed' : 'pointer',
            letterSpacing: '0.08em',
            fontSize: '12px',
          }}
          disabled={isPending}
          onClick={handleCancelQueue}
        >
          {isPending ? 'CANCELLING…' : 'CANCEL QUEUE'}
        </button>

        {error && (
          <div
            className="panel pad-16 t-xs"
            style={{ color: 'var(--loss)', borderColor: 'var(--loss)', wordBreak: 'break-word' }}
          >
            {error}
          </div>
        )}
      </div>
    );
  }

  // Setup state — pick fighter, tier, enter queue
  return (
    <div className="col gap-24">

      {/* Header */}
      <div className="sect-head">
        <span className="sect-head-num">01</span>
        <span className="sect-head-title">
          {locked ? `JOIN ${turns}-ROUND DUEL` : 'ENTER THE ARENA'}
        </span>
      </div>

      {/* Market picker. Events and spot are different games, not a display
          setting: events replaces every coin with a prediction question, so
          a nine-round fight costs about two USDso instead of about ninety-four.
          Each market has its own waiting line. */}
      <div className="col gap-12">
        <div className="eyebrow">MARKET</div>
        <div className="row gap-8">
          {MARKET_CHOICES.map(({ kind, label, accent, hint }) => {
            const selected = market === kind;
            return (
              <button
                key={kind}
                onClick={() => onMarketChange(kind)}
                disabled={locked}
                aria-pressed={selected}
                title={hint}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '10px 6px',
                  border: `1px solid ${selected ? accent : 'var(--border)'}`,
                  // color-mix, NOT `${accent}1f`. Gluing an alpha pair onto the end
                  // of a colour only works when the colour is a literal hex; the EVENTS
                  // accent is a token, so it produced `var(--gold)1f`, which the browser
                  // discards — that one market's selected state had no fill at all while
                  // its neighbours did. This form accepts either kind of colour.
                  background: selected ? `color-mix(in srgb, ${accent} 12%, transparent)` : 'transparent',
                  borderRadius: '2px',
                  cursor: locked ? 'not-allowed' : 'pointer',
                  opacity: locked && !selected ? 0.4 : 1,
                  color: selected ? accent : 'var(--text-dim)',
                  fontSize: '12px',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  transition: 'border-color 0.15s, background 0.15s, color 0.15s',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="t-xs" style={{ color: 'var(--text-dim)' }}>
          {MARKET_CHOICES.find((m) => m.kind === market)?.hint}
        </div>
      </div>

      {/* Fighter picker */}
      <div className="col gap-12">
        <div className="eyebrow">CHOOSE YOUR FIGHTER</div>
        <div
          style={{
            display: 'grid',
            // auto-fit, not a fixed three: the panel is full width now, and
            // three fixed columns would stretch each fighter card to about
            // four hundred pixels. This gives six across when there is room
            // and folds back to three, then two, as it narrows.
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '8px',
          }}
        >
          {ROSTER.map((f, idx) => {
            const selected = fighter === idx;
            return (
              <button
                key={f.id}
                onClick={() => onFighterChange(idx)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '3px',
                  minWidth: 0,
                  background: selected ? `color-mix(in srgb, ${f.hex} 8%, transparent)` : 'transparent',
                  border: `1px solid ${selected ? f.hex : 'var(--border)'}`,
                  boxShadow: selected ? `0 0 8px color-mix(in srgb, ${f.hex} 33%, transparent)` : 'none',
                  borderRadius: '2px',
                  padding: '10px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'border-color 0.15s, box-shadow 0.15s, background 0.15s',
                }}
              >
                <span
                  className="t-mono"
                  style={{ color: f.hex, fontSize: '13px', fontWeight: 700, lineHeight: 1 }}
                >
                  {f.initials}
                </span>
                <span
                  className="t-up"
                  style={{
                    color: selected ? 'var(--text)' : 'var(--text-dim)',
                    fontSize: '10px',
                    fontWeight: 600,
                    lineHeight: 1.15,
                    letterSpacing: '0.04em',
                  }}
                >
                  {f.name.replace('THE ', '')}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tier / Turns — fixed when joining a specific tier, else selectable */}
      {locked ? (
        <div className="col gap-12">
          <div className="eyebrow">TIER / ROUNDS</div>
          <div className="panel pad-16 row jc-sb ai-c">
            <span
              className="t-mono"
              style={{ color: 'var(--gold)', fontSize: '16px', fontWeight: 700, lineHeight: 1 }}
            >
              {turns} ROUNDS
            </span>
            <span
              className="t-up"
              style={{ color: 'var(--text-faint)', fontSize: '10px', letterSpacing: '0.04em' }}
            >
              {TIER_POOLS[turns].join(' + ')} · {fightLengthLabel(turns)}
            </span>
          </div>
        </div>
      ) : (
      <div className="col gap-12">
        <div className="eyebrow">TIER / ROUNDS</div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
            gap: '8px',
          }}
        >
          {tiersFor(market).map((t) => {
            const selected = turns === t;
            const pools = poolsFor(t, market, eventQuestions, perpFor(t));
            return (
              <button
                key={t}
                onClick={() => onTurnsChange(t)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '4px',
                  minWidth: 0,
                  background: selected ? 'var(--gold-soft)' : 'transparent',
                  border: `1px solid ${selected ? 'var(--gold)' : 'var(--border)'}`,
                  borderRadius: '2px',
                  padding: '10px 4px',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                <span
                  className="t-mono"
                  style={{
                    color: selected ? 'var(--gold)' : 'var(--text)',
                    fontSize: '16px',
                    fontWeight: 700,
                    lineHeight: 1,
                  }}
                >
                  {t}
                </span>
                <span
                  className="t-up"
                  style={{
                    color: 'var(--text-faint)',
                    fontSize: 'clamp(9px, 1.6vw, 10px)',
                    lineHeight: 1.2,
                    letterSpacing: '0.04em',
                    textAlign: 'center',
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {pools.join('+')}
                </span>
                {/* Roughly how long sitting through this tier takes. It belongs
                    on the button that takes the deposit, because a round count
                    alone does not tell anybody that. Hedged on purpose — see
                    lib/fightLength.ts for why it can only ever be a range. */}
                <span
                  className="t-mono"
                  style={{
                    color: 'var(--text-faint)',
                    fontSize: 'clamp(8px, 1.5vw, 9px)',
                    lineHeight: 1.2,
                    letterSpacing: '0.02em',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fightLengthLabel(t)}
                </span>
              </button>
            );
          })}
        </div>
        {market === MarketKind.Perps && <PerpsTierNote offer={perpOffers.find((o) => o.turns === turns)} />}
      </div>
      )}

      {/* Queue slot info + Deposit */}
      <div className="panel pad-16 col gap-12">
        {/* Who's waiting */}
        <div className="row jc-sb ai-c">
          <span className="t-sm t-dim">Opponent in queue</span>
          {slotLoading ? (
            <span className="t-xs t-dim">…</span>
          ) : currentSlot ? (
            <span className="row gap-8 ai-c">
              <span className="dot dot-warn pulse" />
              <span className="t-sm t-mono" style={{ color: 'var(--gold)' }}>
                {ROSTER[currentSlot.fighter]?.name ?? `FIGHTER ${currentSlot.fighter}`}
              </span>
            </span>
          ) : (
            <span className="t-xs t-dim">No opponent yet</span>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} />

        <div className="row jc-sb ai-c">
          <span className="t-sm t-dim">Required deposit</span>
          <span className="t-mono text-gold" style={{ fontSize: '15px' }}>
            {halfDepositFormatted} USDso
          </span>
        </div>
        <div className="row jc-sb ai-c">
          <span className="t-sm t-dim">Your balance</span>
          <span
            className="t-mono"
            style={{
              fontSize: '13px',
              color: hasEnough ? 'var(--text)' : 'var(--loss)',
            }}
          >
            {balanceFormatted} USDso
          </span>
        </div>
        {!hasEnough && halfDeposit !== null && (
          <div
            className="t-xs"
            style={{ color: 'var(--loss)', borderTop: '1px solid var(--border)', paddingTop: '8px' }}
          >
            Insufficient balance. You need {halfDepositFormatted} USDso to enter.
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div
          className="panel pad-16 t-xs"
          style={{ color: 'var(--loss)', borderColor: 'var(--loss)', wordBreak: 'break-word' }}
        >
          {error}
        </div>
      )}

      {/* Submit — connect → switch network → queue */}
      {!isConnected ? (
        <button
          className="bk bk-primary"
          style={{ width: '100%', padding: '14px', letterSpacing: '0.08em', fontSize: '13px' }}
          onClick={() => openConnectModal?.()}
        >
          CONNECT WALLET TO QUEUE
        </button>
      ) : wrongNetwork ? (
        <button
          className="bk bk-primary"
          style={{
            width: '100%',
            padding: '14px',
            letterSpacing: '0.08em',
            fontSize: '13px',
            color: 'var(--loss)',
            borderColor: 'var(--loss)',
          }}
          disabled={isSwitching}
          onClick={() => switchChain({ chainId: somniaTestnet.id })}
        >
          {isSwitching ? 'SWITCHING…' : 'SWITCH TO SOMNIA TESTNET'}
        </button>
      ) : (
        <button
          className="bk bk-primary"
          style={{
            width: '100%',
            padding: '14px',
            opacity: hasEnough && !isPending ? 1 : 0.45,
            cursor: hasEnough && !isPending ? 'pointer' : 'not-allowed',
            letterSpacing: '0.08em',
            fontSize: '13px',
          }}
          disabled={!hasEnough || isPending}
          onClick={handleEnterQueue}
        >
          {isPending
            ? 'APPROVING + QUEUEING…'
            : hasEnough
              ? 'ENTER QUEUE'
              : 'INSUFFICIENT USDso'}
        </button>
      )}
    </div>
  );
}

export function DuelCreator({ onMatchFound, lockedTurns, lockedMarket }: DuelCreatorProps) {
  const [fighter, setFighter] = useState(0);
  const [turns, setTurns] = useState<TurnOption>(lockedTurns ?? 6);
  // Events is the default: it is the affordable game, and the one every tier is
  // offered on.
  const [market, setMarket] = useState<MarketKind>(lockedMarket ?? MarketKind.Events);

  // Sync the tier when the user opens a different locked tier while the
  // creator is already mounted (e.g. clicking JOIN on another card).
  useEffect(() => {
    if (lockedTurns != null) setTurns(lockedTurns);
  }, [lockedTurns]);

  // Same for the market, and for the same reason: the creator stays mounted
  // between clicks, so a second click on a different market's chip has to move
  // it or the form keeps the first choice.
  useEffect(() => {
    if (lockedMarket != null) setMarket(lockedMarket);
  }, [lockedMarket]);

  const handleMarketChange = (m: MarketKind) => {
    if (m === MarketKind.Practice && !SIM_MARKET_ENABLED) return;
    setMarket(m);
    // Not every round count is offered on every market, so a switch that would
    // leave an unavailable tier selected snaps to one that exists rather than
    // silently queueing for a line the lobby does not list.
    const available = tiersFor(m);
    if (!available.includes(turns)) setTurns(available[0]);
  };

  return (
    <div className="card pad-24">
      <QueueInner
        fighter={fighter}
        turns={turns}
        market={market}
        locked={lockedTurns != null}
        onMatchFound={onMatchFound}
        onFighterChange={setFighter}
        onTurnsChange={setTurns}
        onMarketChange={handleMarketChange}
      />
    </div>
  );
}

export default DuelCreator;
