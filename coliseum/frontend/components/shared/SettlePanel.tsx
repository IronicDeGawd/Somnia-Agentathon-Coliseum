'use client';

import { useState, useEffect } from 'react';
import { formatUnits, parseAbiItem } from 'viem';
import { useAccount, useReadContract, useWriteContract, usePublicClient } from 'wagmi';
import { useDuelState } from '@/hooks/useDuelState';
import { useSettleBets } from '@/hooks/useSettleBets';
import { useFighters } from '@/hooks/useFighters';
import { CONTRACT_ADDRESSES, ABIS, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';

// DuelResolved event for final value backfill (mirrors result page pattern).
const DUEL_RESOLVED_EVENT = parseAbiItem(
  'event DuelResolved(uint256 indexed duelId, uint8 indexed winnerFighterId, uint256 valueA, uint256 valueB)',
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface SettlePanelProps {
  duelId: bigint;
  isCreator: boolean;
  matchmakerDuel?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUsdso(raw: bigint, decimals = 2): string {
  return Number(formatUnits(raw, 18)).toFixed(decimals);
}

// ─── Matchmaker Claim Section ─────────────────────────────────────────────────

function MatchmakerClaimSection({ duelId }: { duelId: bigint }) {
  const { address } = useAccount();

  const { data: matchData, isLoading } = useReadContract({
    address: CONTRACT_ADDRESSES.Matchmaker,
    abi: ABIS.Matchmaker,
    functionName: 'matches',
    args: [duelId],
  });

  const { writeContract, isPending } = useWriteContract();

  if (isLoading || !matchData) {
    return (
      <div className="col gap-8">
        <div className="eyebrow t-dim">Your Winnings</div>
        <div className="t-dim t-sm">Loading match data…</div>
      </div>
    );
  }

  const [playerA, playerB, totalPot, recovered, settledA, settledB] = matchData as [
    `0x${string}`,
    `0x${string}`,
    bigint,
    boolean,
    boolean,
    boolean,
  ];

  const isPlayerA = address?.toLowerCase() === playerA?.toLowerCase();
  const isPlayerB = address?.toLowerCase() === playerB?.toLowerCase();
  const isParticipant = isPlayerA || isPlayerB;

  if (!isParticipant) return null;

  const alreadyClaimed = isPlayerA ? settledA : settledB;

  function handleClaim() {
    writeContract({
      address: CONTRACT_ADDRESSES.Matchmaker,
      abi: ABIS.Matchmaker,
      functionName: 'claimWinnings',
      args: [duelId],
    });
  }

  return (
    <div className="col gap-12">
      <div className="eyebrow t-dim">Your Winnings</div>

      <div className="panel pad-16 col gap-8">
        <div className="row jc-sb ai-c">
          <span className="t-sm t-dim">Your role</span>
          <span
            className="t-sm t-mono"
            style={{ color: isPlayerA ? 'var(--fighter-a)' : 'var(--fighter-b)' }}
          >
            {isPlayerA ? 'Player A' : 'Player B'}
          </span>
        </div>
        <div className="row jc-sb ai-c">
          <span className="t-sm t-dim">Total pot</span>
          <span className="t-sm t-mono t-num">{formatUsdso(totalPot)} USDso</span>
        </div>
        {!recovered && (
          <p className="t-xs t-faint" style={{ margin: 0 }}>
            Winnings will be claimable once the Arena resolves the duel.
          </p>
        )}
      </div>

      {recovered && !alreadyClaimed && (
        <button
          className="bk bk-primary"
          onClick={handleClaim}
          disabled={isPending}
          style={{ width: '100%' }}
        >
          {isPending ? 'Claiming…' : 'CLAIM WINNINGS'}
        </button>
      )}

      {alreadyClaimed && (
        <div className="panel pad-16 row ai-c gap-8" style={{ borderColor: 'var(--win)' }}>
          <span className="dot dot-win" />
          <span className="t-sm text-win">Already claimed</span>
        </div>
      )}

      {recovered && !alreadyClaimed && (
        <p className="t-xs t-faint" style={{ margin: 0 }}>
          Winner takes the full pot minus platform fee.
        </p>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettlePanel({ duelId, isCreator, matchmakerDuel = false }: SettlePanelProps) {
  const { duel, isLoading: duelLoading, winnerSlot, totalBetsA, totalBetsB } = useDuelState(duelId);
  const { isLoading: fightersLoading } = useFighters();
  const publicClient = usePublicClient();

  // ── DuelResolved backfill for real final portfolio values (M2) ─────────────
  const [resolvedValueA, setResolvedValueA] = useState<bigint | null>(null);
  const [resolvedValueB, setResolvedValueB] = useState<bigint | null>(null);

  useEffect(() => {
    if (!publicClient || duelId <= BigInt(0)) return;
    let cancelled = false;
    void (async () => {
      try {
        const fromBlock = duel?.startBlock ?? BOOKMAKER_DEPLOY_BLOCK;
        const logs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.Arena,
          event: DUEL_RESOLVED_EVENT,
          args: { duelId },
          fromBlock,
          toBlock: 'latest',
        });
        if (cancelled || logs.length === 0) return;
        const last = logs[logs.length - 1];
        const args = last.args as { valueA?: bigint; valueB?: bigint };
        if (args.valueA !== undefined) setResolvedValueA(args.valueA);
        if (args.valueB !== undefined) setResolvedValueB(args.valueB);
      } catch {
        // Non-fatal — UI falls back to showing "—".
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, duelId, duel?.startBlock]);

  const {
    settleBets,
    recoverFunds,
    userBet,
    estimatedPayout,
    duelSettled,
    isSettlePending,
    isRecoverPending,
  } = useSettleBets(duelId, totalBetsA, totalBetsB);

  const isLoading = duelLoading || fightersLoading;

  if (isLoading) {
    return (
      <div className="card pad-24 col gap-16" style={{ width: '100%' }}>
        <div className="eyebrow t-dim">Duel Result</div>
        <div className="t-dim t-sm">Loading duel data…</div>
      </div>
    );
  }

  if (!duel) {
    return (
      <div className="card pad-24 col gap-16" style={{ width: '100%' }}>
        <div className="eyebrow t-dim">Duel Result</div>
        <div className="t-dim t-sm">Duel not found.</div>
      </div>
    );
  }

  const isResolved = duel.status === 3;

  if (!isResolved) {
    return (
      <div className="card pad-24 col gap-16" style={{ width: '100%' }}>
        <div className="eyebrow t-dim">Duel Result</div>
        <div className="chip chip-live row gap-8 ai-c" style={{ width: 'fit-content' }}>
          <span className="dot pulse" />
          <span className="t-sm">Duel still in progress</span>
        </div>
      </div>
    );
  }

  // winnerSlot 0 = fighterA won, 1 = fighterB won.
  const winnerSlotNum = winnerSlot ?? duel.winnerSlot;
  const loserSlotNum = winnerSlotNum === 0 ? 1 : 0;

  // Real final portfolio values from DuelResolved event (M2).
  // Falls back to null so we show "—" rather than fabricated initialUsdso stubs.
  const winnerBalance: bigint | null =
    resolvedValueA !== null && resolvedValueB !== null
      ? (winnerSlotNum === 0 ? resolvedValueA : resolvedValueB)
      : null;
  const loserBalance: bigint | null =
    resolvedValueA !== null && resolvedValueB !== null
      ? (winnerSlotNum === 0 ? resolvedValueB : resolvedValueA)
      : null;
  const margin: bigint | null =
    winnerBalance !== null && loserBalance !== null
      ? (winnerBalance > loserBalance ? winnerBalance - loserBalance : BigInt(0))
      : null;

  // Fighter display — we don't have fighterA/fighterB indexes in the ABI tuple,
  // so we label generically and use slot colors.
  const winnerLabel = winnerSlotNum === 0 ? 'Fighter A' : 'Fighter B';
  const winnerColor = winnerSlotNum === 0 ? 'var(--fighter-a)' : 'var(--fighter-b)';

  // Determine user bet outcome
  const userWon = userBet !== null && userBet.fighterId === winnerSlotNum;

  // fundsRecovered from duel tuple index 11 (M3).
  const fundsAlreadyRecovered: boolean = duel.fundsRecovered === true;

  return (
    <div className="card pad-24 col gap-24" style={{ width: '100%' }}>

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
                {winnerBalance !== null ? `${formatUsdso(winnerBalance)} USDso` : '—'}
              </span>
            </div>
            <div className="col gap-2">
              <span className="label-tiny t-dim">Margin</span>
              <span className="t-num t-mono text-win" style={{ fontSize: '1rem' }}>
                {margin !== null ? `+${formatUsdso(margin)} USDso` : '—'}
              </span>
            </div>
          </div>

          <div className="row ai-c gap-8 t-faint t-xs" style={{ marginTop: 4 }}>
            <span>Loser ({loserSlotNum === 0 ? 'Fighter A' : 'Fighter B'}):</span>
            <span className="t-num t-mono text-loss">
              {loserBalance !== null ? `${formatUsdso(loserBalance)} USDso` : '—'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Matchmaker PvP Claim Section ───────────────────────────────────────── */}
      {matchmakerDuel && <MatchmakerClaimSection duelId={duelId} />}

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

          {/* Settle Bets button — hidden once bets are settled on-chain (M4) */}
          {!duelSettled && !userBet.settled && (
            <button
              className="bk bk-primary"
              onClick={settleBets}
              disabled={isSettlePending}
              style={{ width: '100%' }}
            >
              {isSettlePending ? 'Settling…' : 'SETTLE BETS'}
            </button>
          )}

          {(duelSettled || userBet.settled) && (
            <div className="panel pad-16 row ai-c gap-8" style={{ borderColor: 'var(--win)' }}>
              <span className="dot dot-win" />
              <span className="t-sm text-win">Bets settled — payout sent to winners</span>
            </div>
          )}
        </div>
      )}

      {/* Permissionless settlement — hidden once already settled on-chain (M4) */}
      {!userBet && !duelSettled && (
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

      {/* Show settled state when user has no bet and settlement is done */}
      {!userBet && duelSettled && (
        <div className="panel pad-16 row ai-c gap-8" style={{ borderColor: 'var(--win)' }}>
          <span className="dot dot-win" />
          <span className="t-sm text-win">Bets settled — payout sent to winners</span>
        </div>
      )}

      {/* ── Creator Recovery Section ──────────────────────────────────────────── */}
      {isCreator && !matchmakerDuel && (
        <div className="col gap-12">
          <div className="eyebrow t-dim">Creator Recovery</div>

          <div className="panel pad-16 col gap-8">
            <div className="row jc-sb ai-c">
              <span className="t-sm t-dim">Status</span>
              <span className="t-sm t-mono">
                {fundsAlreadyRecovered ? 'Recovered' : 'Pending recovery'}
              </span>
            </div>
            <p className="t-xs t-faint" style={{ margin: 0 }}>
              Quote token balances remaining after trading. Base-token holdings are not included.
            </p>
          </div>

          {/* Gate on !fundsRecovered (on-chain flag, M3) — hide once already recovered */}
          {!fundsAlreadyRecovered && (
            <button
              className="bk bk-gold"
              onClick={recoverFunds}
              disabled={isRecoverPending}
              style={{ width: '100%' }}
            >
              {isRecoverPending ? 'Recovering…' : 'RECOVER FUNDS'}
            </button>
          )}

          {fundsAlreadyRecovered && (
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
