'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useReadContract, usePublicClient } from 'wagmi';
import { parseAbiItem } from 'viem';
import { ABIS, CONTRACT_ADDRESSES } from '@/lib/contracts';
import { useContractSubscription } from '@/hooks/useContractSubscription';

// DuelStatus enum mirrors ArenaTypes.DuelStatus { None=0, Active=1, Finalizing=2, Resolved=3 }
const DUEL_STATUS_ACTIVE   = 1;
const DUEL_STATUS_RESOLVED = 3;

// Event used for the historical BetPlaced backfill (getLogs). Field names match
// the on-chain Bookmaker event exactly: (duelId, fighterId, bettor, stake, ...).
const BET_PLACED_EVENT = parseAbiItem(
  'event BetPlaced(uint256 indexed duelId, uint8 indexed fighterId, address indexed bettor, uint256 stake, uint16 oddsAtPlacementBps, uint256 betIndex)',
);

export interface DuelData {
  fighterA: number;
  fighterB: number;
  creator: `0x${string}`;
  startBlock: bigint;
  lastTurnBlock: bigint;
  turns: number;
  poolMask: number;
  currentTurn: number;
  status: number;
  winnerSlot: number;
  quoteBalanceA: bigint;
  quoteBalanceB: bigint;
  /** True once recoverFunds has been called on-chain (tuple index 10). */
  fundsRecovered: boolean;
  /** True when the duel runs on the simulated market (tuple index 12). */
  simulated: boolean;
}

export interface UseDuelStateResult {
  duel: DuelData | null;
  /**
   * The Bookmaker's own odds field. Reads [0, 0] on every duel — nothing maintains
   * it — so prefer `shareA`/`shareB`, which come from the stakes actually placed.
   */
  odds: { degenBps: number; whaleBps: number } | null;
  totalBetsA: bigint;
  totalBetsB: bigint;
  /** False when the pot is empty, meaning there is no line to draw at all. */
  hasBets: boolean;
  /** Fighter A's share of the pot as a percentage; 50 when nothing is staked. */
  shareA: number;
  shareB: number;
  /** Rounds completed — NOT callbacks, of which there are two per round. */
  currentRound: number;
  isActive: boolean;
  isResolved: boolean;
  winnerSlot: number | null;
  isLoading: boolean;
  /** Set when the duel read itself failed, so callers can tell a broken RPC
   *  apart from a duel that does not exist. */
  error: Error | null;
  refetch: () => void;
}

export function useDuelState(duelId: bigint): UseDuelStateResult {
  const enabled = duelId > BigInt(0);  // eslint-disable-line @typescript-eslint/no-unnecessary-condition

  // ── Arena.duels(duelId) — polled every 10s ────────────────────────────────
  const {
    data: duelRaw,
    isLoading: duelLoading,
    error: duelError,
    refetch: refetchDuel,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'duels',
    args: [duelId],
    query: {
      enabled,
      refetchInterval: 10_000,
      refetchIntervalInBackground: true,
    },
  });

  // ── Bookmaker.currentOdds(duelId, index) — polled every 10s ─────────────────
  // The mapping is uint256 => uint16[2], exposed as currentOdds(duelId, index).
  // We read index 0 (fighterA) and index 1 (fighterB) separately.
  const {
    data: oddsARaw,
    refetch: refetchOddsA,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    functionName: 'currentOdds',
    args: [duelId, BigInt(0)],
    query: {
      enabled,
      refetchInterval: 10_000,
      refetchIntervalInBackground: true,
    },
  });

  const {
    data: oddsBRaw,
    refetch: refetchOddsB,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    functionName: 'currentOdds',
    args: [duelId, BigInt(1)],
    query: {
      enabled,
      refetchInterval: 10_000,
      refetchIntervalInBackground: true,
    },
  });

  // ── BetPlaced accumulation for totalBetsA / totalBetsB ───────────────────
  // Bookmaker has no totalBetsA/totalBetsB view; we tally from BetPlaced events.
  // Two sources feed the tally: a one-time getLogs backfill (so a fresh page
  // load shows the real pool, not 0) and the live watcher (for new bets). Both
  // route through ingestBetLogs, which dedupes by txHash:logIndex so the
  // boundary block can't be counted twice. fighterId/stake are the real event
  // field names (slot 0 = A, slot 1 = B; BetPanel places bets keyed by slot).
  const publicClient = usePublicClient();
  const [totalBetsA, setTotalBetsA] = useState<bigint>(BigInt(0));
  const [totalBetsB, setTotalBetsB] = useState<bigint>(BigInt(0));
  const seenBets = useRef<Set<string>>(new Set());

  const ingestBetLogs = useCallback(
    (logs: readonly { transactionHash: `0x${string}` | null; logIndex: number | null; args: unknown }[]) => {
      let addA = BigInt(0);
      let addB = BigInt(0);
      for (const log of logs) {
        const args = log.args as { duelId?: bigint; fighterId?: number; stake?: bigint };
        // Reject foreign-duel logs BEFORE touching the dedup set, so it never
        // accumulates keys for other duels. Both feeds filter on the indexed
        // duelId already; this is the belt-and-braces check.
        if (args.duelId !== duelId) continue;
        const key = `${log.transactionHash}:${log.logIndex}`;
        if (seenBets.current.has(key)) continue;
        seenBets.current.add(key);
        const stake = args.stake ?? BigInt(0);
        if (args.fighterId === 0) addA += stake;
        else if (args.fighterId === 1) addB += stake;
      }
      if (addA > BigInt(0)) setTotalBetsA((prev) => prev + addA);
      if (addB > BigInt(0)) setTotalBetsB((prev) => prev + addB);
    },
    [duelId],
  );

  // Reset tally whenever duelId changes (before the new backfill runs).
  useEffect(() => {
    setTotalBetsA(BigInt(0));
    setTotalBetsB(BigInt(0));
    seenBets.current = new Set();
  }, [duelId]);

  // One-time historical backfill, bounded to the duel's startBlock so we don't
  // scan all chain history. Failure is non-fatal — the live watcher still tallies.
  const startBlock = duelRaw ? (duelRaw[3] as unknown as bigint) : undefined;
  useEffect(() => {
    if (!enabled || !publicClient || startBlock === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const logs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.Bookmaker,
          event: BET_PLACED_EVENT,
          args: { duelId },
          fromBlock: startBlock,
          toBlock: 'latest',
        });
        if (!cancelled) ingestBetLogs(logs);
      } catch {
        // Ignore — live watcher below still accumulates new bets.
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, publicClient, duelId, startBlock, ingestBetLogs]);

  // Live BetPlaced watcher — appends new bets as they land. Filter by the
  // indexed duelId at the RPC level so only this duel's logs reach the client.
  useContractSubscription({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    eventName: 'BetPlaced',
    args: { duelId },
    onLogs(logs) {
      ingestBetLogs(logs);
    },
    enabled,
  });

  // ── TurnAdvanced → refetch duel state ─────────────────────────────────────
  useContractSubscription({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'TurnAdvanced',
    args: { duelId },
    onLogs() {
      refetchDuel();
    },
    enabled,
  });

  // ── OddsUpdated → refetch odds ────────────────────────────────────────────
  useContractSubscription({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    eventName: 'OddsUpdated',
    args: { duelId },
    onLogs() {
      refetchOddsA();
      refetchOddsB();
    },
    enabled,
  });

  // ── Derived values ─────────────────────────────────────────────────────────
  // duels() getter tuple (13 fields — Solidity OMITS the uint8[2] lastAction):
  //   0 fighterA, 1 fighterB, 2 creator, 3 startBlock, 4 lastTurnBlock,
  //   5 completedCallbacks, 6 turns, 7 poolMask, 8 status,
  //   9 initialUsdsoPerFighter, 10 fundsRecovered, 11 winnerSlot, 12 simulated
  const duel: DuelData | null = duelRaw
    ? {
        fighterA:       Number(duelRaw[0]),
        fighterB:       Number(duelRaw[1]),
        creator:        duelRaw[2] as unknown as `0x${string}`,
        startBlock:     duelRaw[3] as unknown as bigint,
        lastTurnBlock:  duelRaw[4] as unknown as bigint,
        turns:          Number(duelRaw[6]),
        poolMask:       Number(duelRaw[7]),
        currentTurn:    Number(duelRaw[5]),   // completedCallbacks
        status:         Number(duelRaw[8]),
        winnerSlot:     Number(duelRaw[11]),
        quoteBalanceA:  duelRaw[9] as unknown as bigint,   // initialUsdsoPerFighter as proxy
        quoteBalanceB:  duelRaw[9] as unknown as bigint,   // same; no live balance in this ABI
        fundsRecovered: duelRaw[10] as unknown as boolean, // bool at tuple index 10
        simulated:      Boolean(duelRaw[12]),              // bool at tuple index 12
      }
    : null;

  // Combine the two separate currentOdds reads into one odds object.
  const odds = oddsARaw !== undefined && oddsBRaw !== undefined
    ? {
        degenBps: Number(oddsARaw),
        whaleBps: Number(oddsBRaw),
      }
    : null;

  /**
   * THE BETTING LINE, DERIVED FROM THE BETS THEMSELVES.
   *
   * `currentOdds` on the Bookmaker is an owner-set oracle field and nothing
   * maintains it: `initializeOdds` and `updateOdds` are both owner-only, so it
   * reads [0, 0] for every duel on chain today — checked across fixtures, matrix
   * fights and demo fights alike. Rendering it gave every card a line of "0% / 0%"
   * and a bar with no width on either side.
   *
   * The pot IS the line here — this is a parimutuel book, so a side's share of the
   * stakes is exactly its implied chance. Those totals are tallied from BetPlaced,
   * so they are as live as the bets are.
   *
   * `hasBets` is separate on purpose. With an empty pot there is no line at all,
   * and a caller must be able to say so rather than draw a 50/50 that nobody
   * wagered on.
   */
  const pot = totalBetsA + totalBetsB;
  const hasBets = pot > BigInt(0);
  const shareA = hasBets ? Number((totalBetsA * BigInt(1000)) / pot) / 10 : 50;
  const shareB = hasBets ? 100 - shareA : 50;

  /**
   * Rounds completed, not callbacks.
   *
   * `duels().completedCallbacks` counts ONE PER FIGHTER, so a nine-round fight ends
   * at eighteen — and every consumer that printed it as a round showed "RND 18 / 9".
   * Two of the three did. Divided here, once, so the mistake cannot be made again by
   * whoever reads this next.
   */
  const currentRound = Math.min(
    Math.ceil((duel?.currentTurn ?? 0) / 2),
    duel?.turns ?? 0,
  );
  const status       = duel?.status ?? 0;
  const isActive     = status === DUEL_STATUS_ACTIVE;
  const isResolved   = status === DUEL_STATUS_RESOLVED;
  const winnerSlot   = isResolved && duel ? duel.winnerSlot : null;

  const refetch = useCallback(() => {
    refetchDuel();
    refetchOddsA();
    refetchOddsB();
  }, [refetchDuel, refetchOddsA, refetchOddsB]);

  return {
    duel,
    odds,
    totalBetsA,
    totalBetsB,
    hasBets,
    shareA,
    shareB,
    currentRound,
    isActive,
    isResolved,
    winnerSlot,
    isLoading: duelLoading,
    error: duelError ?? null,
    refetch,
  };
}
