'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useReadContract, useWatchContractEvent, usePublicClient } from 'wagmi';
import { parseAbiItem } from 'viem';
import { ABIS, CONTRACT_ADDRESSES } from '@/lib/contracts';

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
  odds: { degenBps: number; whaleBps: number } | null;
  totalBetsA: bigint;
  totalBetsB: bigint;
  currentTurn: number;
  isActive: boolean;
  isResolved: boolean;
  winnerSlot: number | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useDuelState(duelId: bigint): UseDuelStateResult {
  const enabled = duelId > BigInt(0);  // eslint-disable-line @typescript-eslint/no-unnecessary-condition

  // ── Arena.duels(duelId) — polled every 10s ────────────────────────────────
  const {
    data: duelRaw,
    isLoading: duelLoading,
    refetch: refetchDuel,
  } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'duels',
    args: [duelId],
    query: {
      enabled,
      refetchInterval: 10_000,
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
        // accumulates keys for other duels (the live watcher is broad-filtered).
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
  useWatchContractEvent({
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
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'TurnAdvanced',
    onLogs(logs) {
      for (const log of logs) {
        const args = log.args as { duelId?: bigint };
        if (args.duelId === duelId) {
          refetchDuel();
        }
      }
    },
    enabled,
  });

  // ── OddsUpdated → refetch odds ────────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    eventName: 'OddsUpdated',
    onLogs(logs) {
      for (const log of logs) {
        const args = log.args as { duelId?: bigint };
        if (args.duelId === duelId) {
          refetchOddsA();
          refetchOddsB();
        }
      }
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

  const currentTurn  = duel?.currentTurn ?? 0;
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
    currentTurn,
    isActive,
    isResolved,
    winnerSlot,
    isLoading: duelLoading,
    refetch,
  };
}
