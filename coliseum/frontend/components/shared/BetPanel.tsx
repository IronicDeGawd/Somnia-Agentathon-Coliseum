'use client';

import { useState, useMemo, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits, parseUnits } from 'viem';
import { usePlaceBet } from '@/hooks/usePlaceBet';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BetPanelProps {
  duelId: bigint;
  fighterAName: string;
  fighterBName: string;
  // Duel state is owned by the parent arena page (single useDuelState poll) and
  // passed down, so this panel does not spawn a second poller / event watcher.
  odds: { degenBps: number; whaleBps: number } | null;
  totalBetsA: bigint;
  totalBetsB: bigint;
  isActive: boolean;
  isLoading: boolean;
  // True when the connected wallet is one of the two fighters' players — they
  // can't bet on their own duel.
  isParticipant?: boolean;
}

type FighterSlot = 0 | 1;

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_AMOUNTS = [2, 5] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUSDso(value: bigint, decimals = 2): string {
  return Number(formatUnits(value, 18)).toFixed(decimals);
}

/**
 * Parimutuel payout estimate:
 *   payout = stake + stake * (losingPool * 0.95) / totalWinningPool
 *
 * Returns null when the estimate is not yet meaningful (zero stake or zero
 * winning pool after adding the user's stake).
 */
function calcPayoutEstimate(
  stake: bigint,
  slot: FighterSlot,
  totalBetsA: bigint,
  totalBetsB: bigint,
): string | null {
  if (stake === BigInt(0)) return null;

  // Include the user's own stake in the winning pool.
  const totalWinning = slot === 0 ? totalBetsA + stake : totalBetsB + stake;
  const totalLosing  = slot === 0 ? totalBetsB         : totalBetsA;

  if (totalWinning === BigInt(0)) return null;

  // Apply 5 % rake to the losing pool before distributing.
  const losingAfterRake = (totalLosing * BigInt(9500)) / BigInt(10000);
  const winnings        = (losingAfterRake * stake) / totalWinning;
  const payout          = stake + winnings;

  return formatUSDso(payout);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BetPanel({
  duelId,
  fighterAName,
  fighterBName,
  odds,
  totalBetsA,
  totalBetsB,
  isActive,
  isLoading: duelLoading,
  isParticipant = false,
}: BetPanelProps) {
  const { address } = useAccount();

  const [selectedSlot, setSelectedSlot] = useState<FighterSlot | null>(null);
  const [customAmount, setCustomAmount] = useState<string>('');
  const [existingBet, setExistingBet]   = useState<{ slot: FighterSlot; amount: bigint } | null>(null);
  const [submitError, setSubmitError]   = useState<Error | null>(null);

  // Parse the pending bet amount from the unified text input.
  const pendingAmount = useMemo((): bigint => {
    const parsed = parseFloat(customAmount);
    if (!isNaN(parsed) && parsed > 0) {
      return parseUnits(parsed.toFixed(18), 18);
    }
    return BigInt(0);
  }, [customAmount]);

  const { placeBet, isPending } = usePlaceBet(
    duelId,
    selectedSlot ?? 0,
    pendingAmount,
  );

  // Lock in the receipt only after placeBet resolves without throwing.
  const handlePlaceBet = useCallback(async () => {
    if (selectedSlot === null || pendingAmount === BigInt(0)) return;
    setSubmitError(null);
    try {
      await placeBet();
      setExistingBet({ slot: selectedSlot, amount: pendingAmount });
    } catch (err) {
      setSubmitError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [placeBet, selectedSlot, pendingAmount]);

  // Quick-amount buttons write into the same customAmount string as the input.
  const handleQuickAmount = useCallback((n: number) => {
    setCustomAmount(String(n));
  }, []);

  // ── Derived display values ──────────────────────────────────────────────────
  const oddsAPercent = odds ? (odds.degenBps / 100).toFixed(1) : '—';
  const oddsBPercent = odds ? (odds.whaleBps  / 100).toFixed(1) : '—';

  const totalPool    = totalBetsA + totalBetsB;
  const poolDisplay  = formatUSDso(totalPool);

  const payoutEstimate = selectedSlot !== null && pendingAmount > BigInt(0)
    ? calcPayoutEstimate(pendingAmount, selectedSlot, totalBetsA, totalBetsB)
    : null;

  // ── Guard flags ─────────────────────────────────────────────────────────────
  const walletConnected = !!address;
  const betsOpen        = isActive && walletConnected && !existingBet && !isParticipant;
  const canPlaceBet     = betsOpen && selectedSlot !== null && pendingAmount > BigInt(0) && !isPending;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="card col gap-16" style={{ padding: '20px' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="row ai-c jc-sb">
        <span className="eyebrow">Bet Panel</span>
        {isActive && (
          <span className="chip chip-live">
            <span className="dot pulse" />
            BETS OPEN
          </span>
        )}
        {!isActive && !duelLoading && (
          <span className="chip" style={{ color: 'var(--text-dim)' }}>BETS CLOSED</span>
        )}
      </div>

      {/* ── Odds bar ───────────────────────────────────────────────────────── */}
      <div className="col gap-8">
        <div className="row jc-sb ai-c">
          <span className="t-sm t-up" style={{ color: 'var(--fighter-a)' }}>
            {fighterAName}
          </span>
          <span className="t-sm t-up" style={{ color: 'var(--fighter-b)' }}>
            {fighterBName}
          </span>
        </div>

        {/* Sliding probability bar — animates when odds update */}
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: 'var(--border)',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {odds && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                width: `${odds.degenBps / 100}%`,
                background: 'var(--fighter-a)',
                borderRadius: 3,
                transition: 'width 0.4s ease',
              }}
            />
          )}
        </div>

        <div className="row jc-sb">
          <span className="t-mono t-sm" style={{ color: 'var(--fighter-a)' }}>
            {oddsAPercent}%
          </span>
          <span className="t-dim t-xs">win probability</span>
          <span className="t-mono t-sm" style={{ color: 'var(--fighter-b)' }}>
            {oddsBPercent}%
          </span>
        </div>
      </div>

      {/* ── Pool size ──────────────────────────────────────────────────────── */}
      <div className="panel pad-16 row jc-sb ai-c">
        <span className="t-dim t-sm">Total pool</span>
        <span className="t-mono t-sm text-gold">{poolDisplay} USDso</span>
      </div>

      {/* ── Not connected ──────────────────────────────────────────────────── */}
      {!walletConnected && (
        <div
          className="panel pad-16"
          style={{ textAlign: 'center', color: 'var(--text-dim)' }}
        >
          <span className="t-sm">Connect wallet to bet</span>
        </div>
      )}

      {/* ── Duelist can't bet on their own fight ────────────────────────────── */}
      {walletConnected && isParticipant && (
        <div
          className="panel pad-16 col gap-4"
          style={{ textAlign: 'center', borderColor: 'var(--gold)' }}
        >
          <span className="t-sm text-gold">You're a fighter in this duel</span>
          <span className="t-xs t-dim">Players can't bet on their own fight.</span>
        </div>
      )}

      {/* ── Existing bet receipt ────────────────────────────────────────────── */}
      {walletConnected && existingBet && (
        <div
          className="panel pad-16 col gap-8"
          style={{
            border: `1px solid ${existingBet.slot === 0 ? 'var(--fighter-a)' : 'var(--fighter-b)'}`,
          }}
        >
          <span className="eyebrow">Your Bet</span>
          <div className="row jc-sb ai-c">
            <span
              className="t-sm t-up"
              style={{ color: existingBet.slot === 0 ? 'var(--fighter-a)' : 'var(--fighter-b)' }}
            >
              {existingBet.slot === 0 ? fighterAName : fighterBName}
            </span>
            <span className="t-mono t-sm">{formatUSDso(existingBet.amount)} USDso</span>
          </div>
          <span className="t-xs t-dim">Bet placed. Settle after the duel resolves.</span>
        </div>
      )}

      {/* ── Betting form ────────────────────────────────────────────────────── */}
      {walletConnected && !existingBet && !isParticipant && (
        <div className="col gap-16">

          {/* Fighter selection */}
          <div className="col gap-8">
            <span className="label-tiny">Pick a side</span>
            <div className="row gap-8">

              {/* Fighter A */}
              <button
                className="bk grow"
                disabled={!betsOpen}
                onClick={() => setSelectedSlot(0)}
                style={{
                  flex: 1,
                  border: selectedSlot === 0
                    ? '2px solid var(--fighter-a)'
                    : '1px solid var(--border)',
                  background: selectedSlot === 0
                    ? 'color-mix(in srgb, var(--fighter-a) 12%, transparent)'
                    : 'var(--bg-card)',
                  color: selectedSlot === 0 ? 'var(--fighter-a)' : 'var(--text)',
                  padding: '10px 12px',
                  borderRadius: 6,
                  cursor: betsOpen ? 'pointer' : 'not-allowed',
                  opacity: betsOpen ? 1 : 0.5,
                  transition: 'border-color 0.2s ease, background 0.2s ease, color 0.2s ease',
                }}
              >
                <span className="t-sm t-up">{fighterAName}</span>
                <br />
                <span className="t-mono t-xs" style={{ color: 'var(--fighter-a)' }}>
                  {oddsAPercent}%
                </span>
              </button>

              {/* Fighter B */}
              <button
                className="bk grow"
                disabled={!betsOpen}
                onClick={() => setSelectedSlot(1)}
                style={{
                  flex: 1,
                  border: selectedSlot === 1
                    ? '2px solid var(--fighter-b)'
                    : '1px solid var(--border)',
                  background: selectedSlot === 1
                    ? 'color-mix(in srgb, var(--fighter-b) 12%, transparent)'
                    : 'var(--bg-card)',
                  color: selectedSlot === 1 ? 'var(--fighter-b)' : 'var(--text)',
                  padding: '10px 12px',
                  borderRadius: 6,
                  cursor: betsOpen ? 'pointer' : 'not-allowed',
                  opacity: betsOpen ? 1 : 0.5,
                  transition: 'border-color 0.2s ease, background 0.2s ease, color 0.2s ease',
                }}
              >
                <span className="t-sm t-up">{fighterBName}</span>
                <br />
                <span className="t-mono t-xs" style={{ color: 'var(--fighter-b)' }}>
                  {oddsBPercent}%
                </span>
              </button>

            </div>
          </div>

          {/* Amount selection */}
          <div className="col gap-8">
            <span className="label-tiny">Amount (USDso)</span>

            {/* Quick-pick buttons — write into the same customAmount string */}
            <div className="row gap-8">
              {QUICK_AMOUNTS.map((n) => (
                <button
                  key={n}
                  className="bk-ghost"
                  disabled={!betsOpen}
                  onClick={() => handleQuickAmount(n)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: customAmount === String(n)
                      ? '1px solid var(--gold)'
                      : '1px solid var(--border)',
                    color: customAmount === String(n) ? 'var(--gold)' : 'var(--text-dim)',
                    background: 'transparent',
                    cursor: betsOpen ? 'pointer' : 'not-allowed',
                    opacity: betsOpen ? 1 : 0.5,
                    fontSize: 13,
                  }}
                >
                  +{n} USDso
                </button>
              ))}
            </div>

            {/* Freeform number input — unified with quick-picks via customAmount */}
            <input
              type="number"
              min="0"
              step="1"
              placeholder="Custom amount…"
              value={customAmount}
              disabled={!betsOpen}
              onChange={(e) => setCustomAmount(e.target.value)}
              style={{
                background: 'var(--bg-stage)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text)',
                padding: '8px 12px',
                fontSize: 14,
                fontFamily: 'var(--font-mono, monospace)',
                width: '100%',
                boxSizing: 'border-box',
                outline: 'none',
                opacity: betsOpen ? 1 : 0.5,
              }}
            />
          </div>

          {/* Payout estimate — visible only when slot and non-zero amount are set */}
          {payoutEstimate !== null && (
            <div
              className="panel pad-16 row jc-sb ai-c"
              style={{
                border: ' 1px solid color-mix(in srgb, var(--gold) 30%, transparent)',
              }}
            >
              <div className="col gap-4">
                <span className="label-tiny">Potential payout</span>
                <span className="t-xs t-dim">Parimutuel — shifts with new bets</span>
              </div>
              <span className="t-mono text-gold">~{payoutEstimate} USDso</span>
            </div>
          )}

          {/* Error display */}
          {submitError && (
            <div
              className="panel pad-16"
              style={{ border: '1px solid var(--loss)', color: 'var(--loss)' }}
            >
              <span className="t-xs">{submitError.message}</span>
            </div>
          )}

          {/* Place Bet CTA */}
          <button
            className="bk-primary"
            disabled={!canPlaceBet}
            onClick={handlePlaceBet}
            style={{
              width: '100%',
              padding: '12px',
              borderRadius: 6,
              fontSize: 14,
              letterSpacing: '0.08em',
              fontWeight: 700,
              opacity: canPlaceBet ? 1 : 0.45,
              cursor: canPlaceBet ? 'pointer' : 'not-allowed',
              background: canPlaceBet ? 'var(--gold)' : 'var(--bg-card)',
              color: canPlaceBet ? '#000' : 'var(--text-dim)',
              border: 'none',
              transition: 'background 0.2s ease, color 0.2s ease, opacity 0.2s ease',
            }}
          >
            {isPending ? 'CONFIRMING…' : 'PLACE BET'}
          </button>

          {/* Wallet hint while the two-step approve → placeBet flow is running */}
          {isPending && (
            <span className="t-xs t-dim" style={{ textAlign: 'center' }}>
              Approve USDso then confirm the bet in your wallet
            </span>
          )}

          {/* Bets closed notice — shown when duel is not Active */}
          {!isActive && !duelLoading && (
            <div
              className="panel pad-16"
              style={{ textAlign: 'center', color: 'var(--text-dim)' }}
            >
              <span className="t-sm">Bets are closed for this duel</span>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
