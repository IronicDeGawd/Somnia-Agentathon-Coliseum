'use client';

import { useState, useCallback, useEffect } from 'react';
import { formatUnits } from 'viem';
import { useWatchContractEvent, useAccount, useChainId, useSwitchChain } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useQueue } from '@/hooks/useQueue';
import { useQueueState } from '@/hooks/useQueueState';
import { ROSTER, FIGHTER_VISUAL_MAP } from '@/lib/fighters';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';
import { somniaTestnet } from '@/lib/chain';

const TIER_POOLS: Record<number, string[]> = {
  3:  ['SOMI'],
  6:  ['SOMI', 'WETH'],
  9:  ['SOMI', 'WETH', 'WBTC'],
  15: ['SOMI', 'WETH', 'WBTC'],
};

const TURN_OPTIONS = [3, 6, 9, 15] as const;
type TurnOption = typeof TURN_OPTIONS[number];

interface DuelCreatorProps {
  onMatchFound?: (duelId: bigint) => void;
}

// Inner: re-created when fighter/turns change so hooks get stable args
function QueueInner({
  fighter,
  turns,
  onMatchFound,
  onFighterChange,
  onTurnsChange,
}: {
  fighter: number;
  turns: TurnOption;
  onMatchFound?: (duelId: bigint) => void;
  onFighterChange: (idx: number) => void;
  onTurnsChange: (t: TurnOption) => void;
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
  } = useQueue(fighter, turns);

  const { slots, isLoading: slotLoading, refetch: refetchSlots } = useQueueState();

  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const wrongNetwork = isConnected && chainId !== somniaTestnet.id;

  const [matchedDuelId, setMatchedDuelId] = useState<bigint | null>(null);
  const [queued, setQueued] = useState(false);

  // When enterQueue succeeds, flip into waiting state
  useEffect(() => {
    if (isSuccess && !isPending) {
      setQueued(true);
    }
  }, [isSuccess, isPending]);

  // Watch MatchStarted on the Matchmaker contract
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Matchmaker,
    abi: ABIS.Matchmaker,
    eventName: 'MatchStarted',
    onLogs(logs) {
      for (const log of logs) {
        const args = (log as unknown as { args?: { duelId?: bigint } }).args;
        if (args?.duelId !== undefined) {
          setMatchedDuelId(args.duelId);
          setQueued(false);
          onMatchFound?.(args.duelId);
          refetchSlots();
        }
      }
    },
  });

  const halfDepositFormatted = halfDeposit !== null
    ? Number(formatUnits(halfDeposit, 18)).toFixed(2)
    : '—';

  const balanceFormatted = Number(formatUnits(usdsoBalance, 18)).toFixed(2);

  const currentSlot = slots[turns] ?? null;
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
            {turns}-round tier · {TIER_POOLS[turns].join(' + ')}
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
        <span className="sect-head-title">ENTER THE ARENA</span>
      </div>

      {/* Fighter picker */}
      <div className="col gap-12">
        <div className="eyebrow">CHOOSE YOUR FIGHTER</div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '8px',
          }}
        >
          {ROSTER.map((f, idx) => {
            const selected = fighter === idx;
            return (
              <button
                key={f.id}
                className={`bk${selected ? ' bk-primary' : ''}`}
                style={{
                  borderColor: selected ? f.hex : 'var(--border)',
                  boxShadow: selected ? `0 0 8px ${f.hex}55` : 'none',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '10px 6px',
                  letterSpacing: '0.04em',
                  transition: 'border-color 0.15s, box-shadow 0.15s',
                }}
                onClick={() => onFighterChange(idx)}
              >
                <span
                  className="t-mono t-xs"
                  style={{
                    display: 'block',
                    color: f.hex,
                    fontSize: '13px',
                    fontWeight: 700,
                    lineHeight: 1,
                  }}
                >
                  {f.initials}
                </span>
                <span
                  className="t-xs t-up"
                  style={{
                    display: 'block',
                    color: selected ? 'var(--text)' : 'var(--text-dim)',
                    marginTop: '4px',
                    fontSize: '9px',
                  }}
                >
                  {f.name.replace('THE ', '')}
                </span>
                <span
                  className="label-tiny"
                  style={{
                    display: 'block',
                    color: 'var(--text-dim)',
                    marginTop: '2px',
                    fontSize: '8px',
                    opacity: 0.7,
                  }}
                >
                  {f.tier}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tier / Turns selector */}
      <div className="col gap-12">
        <div className="eyebrow">TIER / ROUNDS</div>
        <div className="row gap-8">
          {TURN_OPTIONS.map((t) => {
            const selected = turns === t;
            const pools = TIER_POOLS[t];
            return (
              <button
                key={t}
                className={`bk${selected ? ' bk-gold' : ''}`}
                style={{
                  flex: 1,
                  padding: '10px 4px',
                  cursor: 'pointer',
                }}
                onClick={() => onTurnsChange(t)}
              >
                <span
                  className="t-mono"
                  style={{
                    display: 'block',
                    color: selected ? 'var(--gold)' : 'var(--text)',
                    fontSize: '16px',
                    fontWeight: 700,
                    lineHeight: 1,
                  }}
                >
                  {t}
                </span>
                <span
                  className="label-tiny t-dim"
                  style={{ display: 'block', marginTop: '4px', fontSize: '8px' }}
                >
                  {pools.join('+')}
                </span>
              </button>
            );
          })}
        </div>
      </div>

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

export function DuelCreator({ onMatchFound }: DuelCreatorProps) {
  const [fighter, setFighter] = useState(0);
  const [turns, setTurns] = useState<TurnOption>(6);

  return (
    <div className="card pad-24">
      <QueueInner
        fighter={fighter}
        turns={turns}
        onMatchFound={onMatchFound}
        onFighterChange={setFighter}
        onTurnsChange={setTurns}
      />
    </div>
  );
}

export default DuelCreator;
