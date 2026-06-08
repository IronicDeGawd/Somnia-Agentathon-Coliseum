'use client';

import { useState, useEffect } from 'react';
import { formatUnits, parseAbiItem } from 'viem';
import { useAccount, useReadContract, useWriteContract, usePublicClient, useSwitchChain } from 'wagmi';
import { useDuelState } from '@/hooks/useDuelState';
import { useSettleBets } from '@/hooks/useSettleBets';
import { useFighters } from '@/hooks/useFighters';
import { CONTRACT_ADDRESSES, ABIS, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';
import { somniaTestnet } from '@/lib/chain';
import { getLogsChunked, duelToBlock } from '@/lib/logs';

// DuelResolved event for final value backfill (mirrors result page pattern).
const DUEL_RESOLVED_EVENT = parseAbiItem(
  'event DuelResolved(uint256 indexed duelId, uint8 indexed winnerFighterId, uint256 valueA, uint256 valueB)',
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface SettlePanelProps {
  duelId: bigint;
  isCreator: boolean;
  matchmakerDuel?: boolean;
  // Real fighter identity from the parent (the result page resolves these from
  // the duel's fighterA/fighterB indexes). Falls back to generic slot labels.
  winnerName?: string;
  loserName?: string;
  winnerColor?: string;
  loserColor?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUsdso(raw: bigint, decimals = 2): string {
  return Number(formatUnits(raw, 18)).toFixed(decimals);
}

// ─── Matchmaker Claim Section ─────────────────────────────────────────────────

function MatchmakerClaimSection({ duelId, winnerSlot }: { duelId: bigint; winnerSlot: number | null }) {
  const { address, chainId } = useAccount();

  const { data: matchData, isLoading } = useReadContract({
    address: CONTRACT_ADDRESSES.Matchmaker,
    abi: ABIS.Matchmaker,
    functionName: 'matches',
    args: [duelId],
  });

  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const { switchChainAsync } = useSwitchChain();

  if (isLoading || !matchData) {
    return (
      <div className="col gap-8">
        <div className="eyebrow t-dim">Your Result</div>
        <div className="t-dim t-sm">Loading match data…</div>
      </div>
    );
  }

  const [playerA, playerB, totalPot, , settledA, settledB] = matchData as [
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
  // This section only renders for a resolved duel (parent gates on isResolved).
  const userIsWinner =
    (winnerSlot === 0 && isPlayerA) || (winnerSlot === 1 && isPlayerB);

  async function handleClaim() {
    if (!publicClient || !address) return;
    if (chainId !== somniaTestnet.id) {
      await switchChainAsync({ chainId: somniaTestnet.id });
    }
    const gasPrice = await publicClient.getGasPrice();
    // The first claimer triggers Arena.recoverFunds (heavy dreamDEX withdrawal) —
    // a flat 300k cap out-of-gas reverts it. Estimate with headroom, floor 5M,
    // fall back to 12M if Somnia's estimator is momentarily unavailable.
    let gas = BigInt(12000000);
    try {
      const est = await publicClient.estimateContractGas({
        address: CONTRACT_ADDRESSES.Matchmaker,
        abi: ABIS.Matchmaker,
        functionName: 'claimWinnings',
        args: [duelId],
        account: address,
      });
      const buffered = (est * BigInt(15)) / BigInt(10);
      gas = buffered > BigInt(5000000) ? buffered : BigInt(5000000);
    } catch { /* keep fallback */ }
    await writeContractAsync({
      address: CONTRACT_ADDRESSES.Matchmaker,
      abi: ABIS.Matchmaker,
      functionName: 'claimWinnings',
      args: [duelId],
      gasPrice,
      gas,
    });
  }

  return (
    <div className="col gap-12">
      <div className="eyebrow t-dim">Your Result</div>

      <div
        className="panel pad-16 col gap-8"
        style={{
          borderColor: userIsWinner ? 'var(--win)' : 'var(--loss)',
          borderLeftWidth: 3,
          borderLeftStyle: 'solid',
        }}
      >
        <div className="row jc-sb ai-c">
          <span
            className="t-display t-up"
            style={{
              color: userIsWinner ? 'var(--win)' : 'var(--loss)',
              letterSpacing: '0.12em',
              fontSize: 16,
            }}
          >
            {userIsWinner ? '★ YOU WON' : 'YOU LOST'}
          </span>
          <span
            className="t-sm t-mono"
            style={{ color: isPlayerA ? 'var(--fighter-a)' : 'var(--fighter-b)' }}
          >
            {isPlayerA ? 'Player A' : 'Player B'}
          </span>
        </div>
        <div className="row jc-sb ai-c">
          <span className="t-sm t-dim">{userIsWinner ? 'Pot to claim' : 'Total pot'}</span>
          <span className="t-sm t-mono t-num">{formatUsdso(totalPot)} USDso</span>
        </div>
      </div>

      {/* Winner: claim triggers fund recovery + payout. */}
      {userIsWinner && !alreadyClaimed && (
        <>
          <button
            className="bk bk-primary"
            onClick={handleClaim}
            disabled={isPending}
            style={{ width: '100%' }}
          >
            {isPending ? 'Claiming…' : 'CLAIM WINNINGS'}
          </button>
          <p className="t-xs t-faint" style={{ margin: 0 }}>
            Claiming pulls the pot from the Arena and sends it to your wallet.
          </p>
        </>
      )}

      {userIsWinner && alreadyClaimed && (
        <div className="panel pad-16 row ai-c gap-8" style={{ borderColor: 'var(--win)' }}>
          <span className="dot dot-win" />
          <span className="t-sm text-win">Winnings claimed — pot sent to your wallet</span>
        </div>
      )}

      {/* Loser: nothing to claim. */}
      {!userIsWinner && (
        <p className="t-xs t-faint" style={{ margin: 0 }}>
          The pot goes to the winner. Better luck in the next bout.
        </p>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettlePanel({ duelId, isCreator, matchmakerDuel = false, winnerName, loserName, winnerColor: winnerColorProp, loserColor: loserColorProp }: SettlePanelProps) {
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
        const dTurns = duel?.turns ?? 3;
        const logs = await getLogsChunked(publicClient, {
          address: CONTRACT_ADDRESSES.Arena,
          event: DUEL_RESOLVED_EVENT,
          args: { duelId },
          fromBlock,
          toBlock: duelToBlock(fromBlock, dTurns, duel?.lastTurnBlock),
        }) as { args: { valueA?: bigint; valueB?: bigint } }[];
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
  }, [publicClient, duelId, duel?.startBlock, duel?.lastTurnBlock]);

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

  // Prefer the real fighter name/color passed by the parent (resolved from the
  // duel's fighterA/fighterB indexes); fall back to generic slot labels.
  const winnerLabel = winnerName ?? (winnerSlotNum === 0 ? 'Fighter A' : 'Fighter B');
  const loserLabel  = loserName  ?? (loserSlotNum  === 0 ? 'Fighter A' : 'Fighter B');
  const winnerColor =
    winnerColorProp ?? (winnerSlotNum === 0 ? 'var(--fighter-a)' : 'var(--fighter-b)');

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
            <span style={{ color: loserColorProp ?? undefined }}>Loser ({loserLabel}):</span>
            <span className="t-num t-mono text-loss">
              {loserBalance !== null ? `${formatUsdso(loserBalance)} USDso` : '—'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Matchmaker PvP Claim Section ───────────────────────────────────────── */}
      {matchmakerDuel && <MatchmakerClaimSection duelId={duelId} winnerSlot={winnerSlotNum} />}

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
