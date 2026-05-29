'use client';

import { useState, useEffect } from 'react';
import { parseAbi, type Address } from 'viem';
import {
  useReadContract,
  useWriteContract,
  useWatchContractEvent,
  useAccount,
} from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES } from '@/lib/contracts';

// ─── Local ABI extensions not present in the shared ABIS object ──────────────
// Bookmaker.bets is a public mapping: bets[duelId][index] → Bet struct.
// We extend inline rather than mutating the shared ABIS, so this file is
// self-contained.
const BOOKMAKER_BETS_ABI = parseAbi([
  'function bets(uint256 duelId, uint256 index) view returns (address bettor, uint8 fighterId, uint256 stake, uint16 oddsAtPlacementBps, bool settled)',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BetData {
  /** bettor address — always the connected wallet */
  bettor: Address;
  /** 0 = fighterA slot, 1 = fighterB slot (relative index, NOT global fighter id) */
  fighterId: number;
  /** raw USDso amount (18-decimal) */
  stake: bigint;
  /** odds locked at placement, BPS [500..9500] */
  oddsAtPlacementBps: number;
  /** true once settleBets has been called and payout transferred */
  settled: boolean;
  /** index inside bets[duelId] array — needed to read the struct */
  index: bigint;
}

export interface UseSettleBetsReturn {
  settleBets: () => void;
  recoverFunds: () => void;
  userBet: BetData | null;
  /**
   * Indicative parimutuel payout (18-decimal bigint).
   *
   * Formula (per contract):
   *   winnings = losingPoolAfterRake * stake / totalWinningStake
   *   payout   = stake + winnings
   *   rake     = 5% of losing pool
   *
   * Because the contract exposes no aggregate totals, we approximate pool
   * sizes from the current odds BPS. The bookmaker derives odds from the
   * relative win probabilities, which closely tracks pool ratios in a
   * parimutuel system:
   *   approxTotalWinning = stake * 10000 / oddsAtPlacementBps
   *   approxTotalLosing  = approxTotalWinning * (10000 - oddsAtPlacementBps) / oddsAtPlacementBps
   *
   * This is an estimate. Actual payout depends on all bets placed.
   */
  estimatedPayout: bigint | null;
  isSettlePending: boolean;
  isRecoverPending: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RAKE_BPS = BigInt(500);       // 5%
const BPS_TOTAL = BigInt(10_000);

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useSettleBets — settlement and recovery actions for a resolved duel.
 *
 * @param duelId  The on-chain duel identifier (bigint).
 */
export function useSettleBets(duelId: bigint): UseSettleBetsReturn {
  const { address: userAddress } = useAccount();

  // Index of the user's bet inside bets[duelId]. Discovered via BetPlaced event.
  const [userBetIndex, setUserBetIndex] = useState<bigint | null>(null);

  // ── Write: settleBets(duelId) ──────────────────────────────────────────────
  const {
    writeContract: writeSettle,
    isPending: isSettlePending,
  } = useWriteContract();

  const settleBets = () => {
    writeSettle({
      address: CONTRACT_ADDRESSES.Bookmaker,
      abi: ABIS.Bookmaker,
      functionName: 'settleBets',
      args: [duelId],
    });
  };

  // ── Write: recoverFunds(duelId) ────────────────────────────────────────────
  // Only callable by duel creator after resolution. One-shot (fundsRecovered flag).
  const {
    writeContract: writeRecover,
    isPending: isRecoverPending,
  } = useWriteContract();

  const recoverFunds = () => {
    writeRecover({
      address: CONTRACT_ADDRESSES.Arena,
      abi: ABIS.Arena,
      functionName: 'recoverFunds',
      args: [duelId],
    });
  };

  // ── Event watch: discover user's bet index from BetPlaced ─────────────────
  // BetPlaced(duelId indexed, fighterId indexed, bettor indexed, stake, oddsAtPlacementBps, betIndex)
  // The event is emitted at bet placement time, so we catch historical + live.
  // wagmi's useWatchContractEvent receives logs as they arrive; for already-
  // mined events we rely on the initial poll window or a separate getLogs call.
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: parseAbi([
      'event BetPlaced(uint256 indexed duelId, uint8 indexed fighterId, address indexed bettor, uint256 stake, uint16 oddsAtPlacementBps, uint256 betIndex)',
    ]),
    eventName: 'BetPlaced',
    onLogs(logs) {
      if (!userAddress) return;
      for (const log of logs) {
        const args = log.args as {
          duelId?: bigint;
          fighterId?: number;
          bettor?: Address;
          stake?: bigint;
          oddsAtPlacementBps?: number;
          betIndex?: bigint;
        };
        if (
          args.duelId === duelId &&
          args.bettor?.toLowerCase() === userAddress.toLowerCase() &&
          args.betIndex !== undefined
        ) {
          setUserBetIndex(args.betIndex);
        }
      }
    },
  });

  // Reset index when duelId changes (e.g. navigating between duels).
  useEffect(() => {
    setUserBetIndex(null);
  }, [duelId]);

  // ── Read: bets[duelId][userBetIndex] ──────────────────────────────────────
  const { data: betRaw } = useReadContract({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: BOOKMAKER_BETS_ABI,
    functionName: 'bets',
    args: userBetIndex !== null ? [duelId, userBetIndex] : undefined,
    query: {
      enabled: userBetIndex !== null,
    },
  });

  // ── Derive BetData ─────────────────────────────────────────────────────────
  const userBet: BetData | null =
    betRaw && userBetIndex !== null
      ? {
          bettor: betRaw[0],
          fighterId: betRaw[1],
          stake: betRaw[2],
          oddsAtPlacementBps: betRaw[3],
          settled: betRaw[4],
          index: userBetIndex,
        }
      : null;

  // ── Estimated payout (parimutuel approximation) ────────────────────────────
  // See JSDoc comment on UseSettleBetsReturn.estimatedPayout for the formula.
  const estimatedPayout: bigint | null = (() => {
    if (!userBet) return null;
    const { stake, oddsAtPlacementBps } = userBet;
    if (stake === BigInt(0) || oddsAtPlacementBps === 0) return null;

    const oddsBps = BigInt(oddsAtPlacementBps);

    // Approximate total winning pool:  stake is oddsBps/10000 of the total.
    const approxTotalWinning = (stake * BPS_TOTAL) / oddsBps;

    // Approximate total losing pool is the complement.
    const approxTotalLosing =
      (approxTotalWinning * (BPS_TOTAL - oddsBps)) / oddsBps;

    // Apply 5% rake on the losing pool.
    const losingAfterRake = (approxTotalLosing * (BPS_TOTAL - RAKE_BPS)) / BPS_TOTAL;

    // Proportional winnings from the losing pool.
    const winnings =
      approxTotalWinning > BigInt(0)
        ? (losingAfterRake * stake) / approxTotalWinning
        : BigInt(0);

    return stake + winnings;
  })();

  return {
    settleBets,
    recoverFunds,
    userBet,
    estimatedPayout,
    isSettlePending,
    isRecoverPending,
  };
}
