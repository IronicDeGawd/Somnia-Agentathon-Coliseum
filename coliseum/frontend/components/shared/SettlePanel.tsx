'use client';

import { formatUnits } from 'viem';
import { useDuelState } from '@/hooks/useDuelState';
import { useSettleBets } from '@/hooks/useSettleBets';
import { useFighters } from '@/hooks/useFighters';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SettlePanelProps {
  duelId: bigint;
  isCreator: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUsdso(raw: bigint, decimals = 2): string {
  return Number(formatUnits(raw, 18)).toFixed(decimals);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettlePanel({ duelId, isCreator }: SettlePanelProps) {
  const { duel, isLoading: duelLoading, winnerSlot } = useDuelState(duelId);
  const { fighters, isLoading: fightersLoading } = useFighters();
  const {
    settleBets,
    recoverFunds,
    userBet,
    estimatedPayout,
    isSettlePending,
    isRecoverPending,
  } = useSettleBets(duelId);

  const isLoading = duelLoading || fightersLoading;

  if (isLoading) {
    return (
      <div className="card pad-24 col gap-16" style={{ minWidth: 320 }}>
        <div className="eyebrow t-dim">Duel Result</div>
        <div className="t-dim t-sm">Loading duel data…</div>
      </div>
    );
  }

  if (!duel) {
    return (
      <div className="card pad-24 col gap-16" style={{ minWidth: 320 }}>
        <div className="eyebrow t-dim">Duel Result</div>
        <div className="t-dim t-sm">Duel not found.</div>
      </div>
    );
  }

  const isResolved = duel.status === 3;

  if (!isResolved) {
    return (
      <div className="card pad-24 col gap-16" style={{ minWidth: 320 }}>
        <div className="eyebrow t-dim">Duel Result</div>
        <div className="chip chip-live row gap-8 ai-c" style={{ width: 'fit-content' }}>
          <span className="dot pulse" />
          <span className="t-sm">Duel still in progress</span>
        </div>
      </div>
    );
  }

  // Resolve winner / loser fighter objects
  const fighterAIndex = duel.creator ? duel.poolMask : -1; // poolMask slot not the fighter index
  // fighters are read by slot from the duel — winnerSlot 0 = fighterA, 1 = fighterB
  // The duel tuple returns (creator, turns, poolMask, currentTurn, status, winnerSlot, qA, qB)
  // fighterA and fighterB indexes are NOT directly in this tuple per the ABI provided.
  // We derive winner display from winnerSlot + quoteBalance comparison.
  const winnerSlotNum = winnerSlot ?? duel.winnerSlot;
  const loserSlotNum = winnerSlotNum === 0 ? 1 : 0;

  // quoteBalanceA / quoteBalanceB are the USDso values per fighter at resolution
  const balA = duel.quoteBalanceA;
  const balB = duel.quoteBalanceB;
  const winnerBalance = winnerSlotNum === 0 ? balA : balB;
  const loserBalance = winnerSlotNum === 0 ? balB : balA;
  const margin = winnerBalance > loserBalance ? winnerBalance - loserBalance : BigInt(0);

  // Fighter display — we don't have fighterA/fighterB indexes in the ABI tuple,
  // so we label generically and use slot colors.
  const winnerLabel = winnerSlotNum === 0 ? 'Fighter A' : 'Fighter B';
  const winnerColor = winnerSlotNum === 0 ? 'var(--fighter-a)' : 'var(--fighter-b)';

  // Determine user bet outcome
  const userWon = userBet !== null && userBet.fighterId === winnerSlotNum;
  const userLost = userBet !== null && userBet.fighterId !== winnerSlotNum;

  // Recoverable amount = sum of both quote balances (what remains in contract)
  const recoverableAmount = balA + balB;
  const fundsAlreadyRecovered = duel.creator === '0x0000000000000000000000000000000000000000';

  return (
    <div className="card pad-24 col gap-24" style={{ minWidth: 320 }}>

      {/* ── Duel Outcome ──────────────────────────────────────────────────────── */}
      <div className="col gap-12">
        <div className="eyebrow t-dim">Duel Result</div>

        <div
          className="panel pad-16 col gap-8"
          style={{ borderColor: winnerColor, borderLeftWidth: 3, borderLeftStyle: 'solid' }}
        >
          <div className="row ai-c gap-8">
            <span
              className="fp-display"
              style={{ color: winnerColor, fontSize: '1.1rem', letterSpacing: '0.08em' }}
            >
              {winnerLabel}
            </span>
            <span className="chip" style={{ background: winnerColor, color: '#0a0a0f', fontWeight: 700, fontSize: '0.65rem' }}>
              WINNER
            </span>
          </div>

          <div className="row ai-c gap-16">
            <div className="col gap-2">
              <span className="label-tiny t-dim">Winning Portfolio</span>
              <span className="t-num t-mono" style={{ color: winnerColor, fontSize: '1rem' }}>
                {formatUsdso(winnerBalance)} USDso
              </span>
            </div>
            <div className="col gap-2">
              <span className="label-tiny t-dim">Margin</span>
              <span className="t-num t-mono text-win" style={{ fontSize: '1rem' }}>
                +{formatUsdso(margin)} USDso
              </span>
            </div>
          </div>

          <div className="row ai-c gap-8 t-faint t-xs" style={{ marginTop: 4 }}>
            <span>Loser ({loserSlotNum === 0 ? 'Fighter A' : 'Fighter B'}):</span>
            <span className="t-num t-mono text-loss">{formatUsdso(loserBalance)} USDso</span>
          </div>
        </div>
      </div>

      {/* ── User Bet Section ───────────────────────────────────────────────────── */}
      {userBet && (
        <div className="col gap-12">
          <div className="eyebrow t-dim">Your Bet</div>

          <div className="panel pad-16 col gap-10">
            {/* Bet details */}
            <div className="row jc-sb ai-c">
              <span className="t-sm t-dim">Backed</span>
              <span
                className="t-sm t-mono"
                style={{ color: userBet.fighterId === 0 ? 'var(--fighter-a)' : 'var(--fighter-b)' }}
              >
                {userBet.fighterId === 0 ? 'Fighter A' : 'Fighter B'}
              </span>
            </div>
            <div className="row jc-sb ai-c">
              <span className="t-sm t-dim">Stake</span>
              <span className="t-sm t-mono">{formatUsdso(userBet.stake)} USDso</span>
            </div>
            <div className="row jc-sb ai-c">
              <span className="t-sm t-dim">Odds at placement</span>
              <span className="t-sm t-mono">
                {(userBet.oddsAtPlacementBps / 100).toFixed(1)}%
              </span>
            </div>

            {/* Outcome badge */}
            <div className="row ai-c gap-8" style={{ marginTop: 4 }}>
              {userWon ? (
                <span className="chip" style={{ background: 'var(--win)', color: '#0a0a0f', fontWeight: 700, fontSize: '0.65rem' }}>
                  WON
                </span>
              ) : (
                <span className="chip" style={{ background: 'var(--loss)', color: '#fff', fontWeight: 700, fontSize: '0.65rem' }}>
                  LOST
                </span>
              )}

              {userWon && estimatedPayout !== null && (
                <span className="t-sm t-mono text-win">
                  {userBet.settled
                    ? `Payout sent`
                    : `Est. payout: ${formatUsdso(estimatedPayout)} USDso`}
                </span>
              )}
            </div>
          </div>

          {/* Settle Bets button */}
          {!userBet.settled && (
            <button
              className="bk bk-primary"
              onClick={settleBets}
              disabled={isSettlePending}
              style={{ width: '100%' }}
            >
              {isSettlePending ? 'Settling…' : 'SETTLE BETS'}
            </button>
          )}

          {userBet.settled && (
            <div className="panel pad-16 row ai-c gap-8" style={{ borderColor: 'var(--win)' }}>
              <span className="dot dot-win" />
              <span className="t-sm text-win">Bets settled — payout sent to winners</span>
            </div>
          )}
        </div>
      )}

      {/* If user didn't bet but can still trigger settlement (permissionless) */}
      {!userBet && (
        <div className="col gap-8">
          <div className="eyebrow t-dim">Settlement</div>
          <button
            className="bk bk-ghost"
            onClick={settleBets}
            disabled={isSettlePending}
            style={{ width: '100%' }}
          >
            {isSettlePending ? 'Settling…' : 'SETTLE BETS'}
          </button>
          <p className="t-xs t-faint" style={{ margin: 0 }}>
            Permissionless — anyone can trigger settlement to distribute winnings.
          </p>
        </div>
      )}

      {/* ── Creator Recovery Section ──────────────────────────────────────────── */}
      {isCreator && (
        <div className="col gap-12">
          <div className="eyebrow t-dim">Creator Recovery</div>

          <div className="panel pad-16 col gap-8">
            <div className="row jc-sb ai-c">
              <span className="t-sm t-dim">Recoverable</span>
              <span className="t-sm t-mono t-num">
                {formatUsdso(recoverableAmount)} USDso
              </span>
            </div>
            <p className="t-xs t-faint" style={{ margin: 0 }}>
              Quote token balances remaining after trading. Base-token holdings are not included.
            </p>
          </div>

          {!duel.creator.startsWith('0x000') && recoverableAmount > BigInt(0) && (
            <button
              className="bk bk-gold"
              onClick={recoverFunds}
              disabled={isRecoverPending}
              style={{ width: '100%' }}
            >
              {isRecoverPending ? 'Recovering…' : 'RECOVER FUNDS'}
            </button>
          )}

          {recoverableAmount === BigInt(0) && (
            <div className="panel pad-16 row ai-c gap-8" style={{ borderColor: 'var(--win)' }}>
              <span className="dot dot-win" />
              <span className="t-sm text-win">Funds recovered</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
