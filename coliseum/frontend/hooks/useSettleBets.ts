'use client';

import { useState, useEffect } from 'react';
import { parseAbi, parseAbiItem, type Address } from 'viem';
import {
  useReadContract,
  useWriteContract,
  useWatchContractEvent,
  useAccount,
  usePublicClient,
} from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';

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
   * Uses real pool totals (totalBetsA / totalBetsB) when provided; falls back
   * to an odds-BPS approximation when they are not available.
   */
  estimatedPayout: bigint | null;
  /** True once Bookmaker.settleBets has been called for this duel. */
  duelSettled: boolean;
  isSettlePending: boolean;
  isRecoverPending: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RAKE_BPS = BigInt(500);       // 5%
const BPS_TOTAL = BigInt(10_000);

// BetPlaced event used for historical getLogs backfill.
const BET_PLACED_EVENT = parseAbiItem(
  'event BetPlaced(uint256 indexed duelId, uint8 indexed fighterId, address indexed bettor, uint256 stake, uint16 oddsAtPlacementBps, uint256 betIndex)',
);

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useSettleBets — settlement and recovery actions for a resolved duel.
 *
 * @param duelId      The on-chain duel identifier (bigint).
 * @param totalBetsA  Real total staked on fighter A (from useDuelState). Used for accurate payout estimate.
 * @param totalBetsB  Real total staked on fighter B (from useDuelState). Used for accurate payout estimate.
 */
export function useSettleBets(
  duelId: bigint,
  totalBetsA: bigint = BigInt(0),
  totalBetsB: bigint = BigInt(0),
): UseSettleBetsReturn {
  const { address: userAddress } = useAccount();
  const publicClient = usePublicClient();

  // Index of the user's bet inside bets[duelId]. Discovered via BetPlaced getLogs backfill + live watcher.
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

  // ── getLogs backfill: find user's historical BetPlaced event ──────────────
  // On a fresh page load of a resolved duel the live watcher only sees new
  // blocks, so a bet placed before page open would be invisible. This one-shot
  // fetch covers all history from the deploy block, filtered to this duel +
  // this bettor by indexed topic, so it's cheap and RPC-friendly.
  useEffect(() => {
    if (!userAddress || !publicClient) return;
    let cancelled = false;
    void (async () => {
      try {
        const logs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.Bookmaker,
          event: BET_PLACED_EVENT,
          args: { duelId, bettor: userAddress as Address },
          fromBlock: BOOKMAKER_DEPLOY_BLOCK,
          toBlock: 'latest',
        });
        if (cancelled || logs.length === 0) return;
        const last = logs[logs.length - 1];
        const args = last.args as { betIndex?: bigint };
        if (args.betIndex !== undefined) {
          setUserBetIndex(args.betIndex);
        }
      } catch {
        // Non-fatal — live watcher below still covers in-session bets.
      }
    })();
    return () => { cancelled = true; };
  }, [duelId, userAddress, publicClient]);

  // ── Live watcher: catch bets placed in this browser session ───────────────
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

  // ── Read: Bookmaker.duelSettled(duelId) ───────────────────────────────────
  const { data: duelSettledRaw } = useReadContract({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    functionName: 'duelSettled',
    args: [duelId],
    query: { enabled: duelId > BigInt(0) },
  });
  const duelSettled = duelSettledRaw === true;

  // ── Estimated payout — real parimutuel formula ─────────────────────────────
  // Uses actual pool totals (totalBetsA/totalBetsB from useDuelState) when
  // available. If the caller did not provide them, falls back to the odds-BPS
  // approximation so the field is never null for a winner.
  const estimatedPayout: bigint | null = (() => {
    if (!userBet) return null;
    const { stake, fighterId, oddsAtPlacementBps } = userBet;
    if (stake === BigInt(0)) return null;

    // Prefer real pool sizes when the caller wired them up.
    const hasPools = totalBetsA > BigInt(0) || totalBetsB > BigInt(0);
    let winningPool: bigint;
    let losingPool: bigint;

    if (hasPools) {
      winningPool = fighterId === 0 ? totalBetsA : totalBetsB;
      losingPool  = fighterId === 0 ? totalBetsB : totalBetsA;
    } else {
      // Fallback: derive approximate pools from odds BPS.
      if (oddsAtPlacementBps === 0) return null;
      const oddsBps = BigInt(oddsAtPlacementBps);
      winningPool = (stake * BPS_TOTAL) / oddsBps;
      losingPool  = (winningPool * (BPS_TOTAL - oddsBps)) / oddsBps;
    }

    // 5% rake on the losing pool, then proportional share to this bettor.
    const losingAfterRake = (losingPool * (BPS_TOTAL - RAKE_BPS)) / BPS_TOTAL;
    const winnings =
      winningPool > BigInt(0)
        ? (losingAfterRake * stake) / winningPool
        : BigInt(0);

    return stake + winnings;
  })();

  return {
    settleBets,
    recoverFunds,
    userBet,
    estimatedPayout,
    duelSettled,
    isSettlePending,
    isRecoverPending,
  };
}
