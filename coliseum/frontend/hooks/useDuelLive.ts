'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublicClient, useWatchContractEvent, useReadContracts } from 'wagmi';
import { parseAbiItem, formatUnits } from 'viem';
import { ABIS, CONTRACT_ADDRESSES, POOLS, FIGHTER_ACTIONS, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';
import { getLogsChunked, duelToBlock } from '@/lib/logs';
import type { DuelData } from '@/hooks/useDuelState';

type RawLog = { transactionHash: `0x${string}` | null; logIndex: number | null; args: unknown };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PoolHolding {
  token: string;          // pool key e.g. "WETH"
  baseAmount: string;     // formatted base token amount
  quoteAmount: string;    // formatted USDso amount
}

export interface FighterLive {
  valueUsdso: bigint;           // total portfolio value in USDso (18 dec)
  pnl: bigint;                  // value - initialUsdsoPerFighter (signed)
  pnlNum: number;               // for UI display (float)
  holdings: PoolHolding[];      // per-pool base+quote amounts
  lastAction: string;           // e.g. "BUY WBTC", "HOLD", or "" if none yet
  thinking: boolean;            // FighterMoveRequested with no subsequent FighterMove
}

export interface PoolMarket {
  poolKey: string;              // "WETH" / "WBTC" / "SOMI"
  poolAddress: `0x${string}`;
  markPrice: bigint;            // latest mark price (18 dec USDso per base token)
  markPriceNum: number;         // float for display
  history: number[];            // chronological mark prices (floats)
}

export interface DuelLiveResult {
  fighterA: FighterLive;
  fighterB: FighterLive;
  markets: PoolMarket[];
  isLoading: boolean;
}

// ─── Events (parsed items for getLogs) ───────────────────────────────────────

const MARK_PRICE_EVENT = parseAbiItem(
  'event MarkPriceSnapshot(uint256 indexed duelId, address indexed pool, uint256 markPrice, uint16 turnNum)',
);

const FIGHTER_MOVE_EVENT = parseAbiItem(
  'event FighterMove(uint256 indexed duelId, uint8 indexed fighterId, uint8 action, uint128 orderId)',
);

const FIGHTER_MOVE_REQUESTED_EVENT = parseAbiItem(
  'event FighterMoveRequested(uint256 indexed duelId, uint8 indexed fighterId, uint256 requestId)',
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EMPTY_FIGHTER: FighterLive = {
  valueUsdso: BigInt(0),
  pnl: BigInt(0),
  pnlNum: 0,
  holdings: [],
  lastAction: '',
  thinking: false,
};

const EMPTY_RESULT: DuelLiveResult = {
  fighterA: EMPTY_FIGHTER,
  fighterB: EMPTY_FIGHTER,
  markets: [],
  isLoading: false,
};

function bigintToNum(v: bigint, decimals: number): number {
  return Number(formatUnits(v, decimals));
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDuelLive(
  duelId: bigint,
  duel: DuelData | null,
): DuelLiveResult {
  const enabled = duelId > BigInt(0) && duel !== null && duel.status !== 0;
  const publicClient = usePublicClient();

  // ── Mark price state: latest price + history per pool ─────────────────────
  // keyed by pool address (lowercased)
  const [markPrices, setMarkPrices] = useState<Map<string, { price: bigint; history: number[] }>>(new Map());

  // ── Last action state per fighter (registry index) ─────────────────────────
  // keyed by fighterId (registry index)
  const [lastActions, setLastActions] = useState<Map<number, string>>(new Map());

  // ── Thinking state: fighterId → bool ──────────────────────────────────────
  const [thinking, setThinking] = useState<Map<number, boolean>>(new Map());

  // ── Dedup refs for live event watchers ────────────────────────────────────
  const seenMarkPrices = useRef<Set<string>>(new Set());
  const seenMoves      = useRef<Set<string>>(new Set());
  const seenRequests   = useRef<Set<string>>(new Set());

  // ── Reset all state when duelId changes ───────────────────────────────────
  useEffect(() => {
    setMarkPrices(new Map());
    setLastActions(new Map());
    setThinking(new Map());
    seenMarkPrices.current = new Set();
    seenMoves.current      = new Set();
    seenRequests.current   = new Set();
  }, [duelId]);

  // ── Ingest MarkPriceSnapshot logs ─────────────────────────────────────────
  const ingestMarkPriceLogs = useCallback(
    (logs: readonly { transactionHash: `0x${string}` | null; logIndex: number | null; args: unknown }[]) => {
      setMarkPrices((prev) => {
        const next = new Map(prev);
        for (const log of logs) {
          const args = log.args as { duelId?: bigint; pool?: `0x${string}`; markPrice?: bigint; turnNum?: number };
          if (args.duelId !== duelId) continue;
          const key = `${log.transactionHash}:${log.logIndex}`;
          if (seenMarkPrices.current.has(key)) continue;
          seenMarkPrices.current.add(key);
          const poolAddr = args.pool?.toLowerCase() ?? '';
          const price = args.markPrice ?? BigInt(0);
          const existing = next.get(poolAddr) ?? { price: BigInt(0), history: [] };
          next.set(poolAddr, {
            price,
            history: [...existing.history, bigintToNum(price, 18)],
          });
        }
        return next;
      });
    },
    [duelId],
  );

  // ── Ingest FighterMove logs ────────────────────────────────────────────────
  const ingestMoveLogs = useCallback(
    (logs: readonly { transactionHash: `0x${string}` | null; logIndex: number | null; args: unknown }[]) => {
      for (const log of logs) {
        const args = log.args as { duelId?: bigint; fighterId?: number; action?: number };
        if (args.duelId !== duelId) continue;
        const key = `${log.transactionHash}:${log.logIndex}`;
        if (seenMoves.current.has(key)) continue;
        seenMoves.current.add(key);
        const fid = args.fighterId ?? -1;
        const action = args.action ?? 0;
        const actionLabel = FIGHTER_ACTIONS[action] ?? 'HOLD';
        setLastActions((prev) => new Map(prev).set(fid, actionLabel));
        // Once a FighterMove arrives, thinking is done for that fighter
        setThinking((prev) => new Map(prev).set(fid, false));
      }
    },
    [duelId],
  );

  // ── Ingest FighterMoveRequested logs ──────────────────────────────────────
  const ingestRequestLogs = useCallback(
    (logs: readonly { transactionHash: `0x${string}` | null; logIndex: number | null; args: unknown }[]) => {
      for (const log of logs) {
        const args = log.args as { duelId?: bigint; fighterId?: number };
        if (args.duelId !== duelId) continue;
        const key = `${log.transactionHash}:${log.logIndex}`;
        if (seenRequests.current.has(key)) continue;
        seenRequests.current.add(key);
        const fid = args.fighterId ?? -1;
        setThinking((prev) => new Map(prev).set(fid, true));
      }
    },
    [duelId],
  );

  // ── Historical backfill (getLogs) ─────────────────────────────────────────
  // Scan only the duel's own block span (start → start + turns×600 + tail), in
  // chunks, so the public RPC's log-range limit can't blank older duels.
  const fromBlock = duel?.startBlock ?? BOOKMAKER_DEPLOY_BLOCK;
  const turns = duel?.turns ?? 3;
  useEffect(() => {
    if (!enabled || !publicClient) return;
    let cancelled = false;
    void (async () => {
      const toBlock = duelToBlock(fromBlock, turns);
      try {
        const [markLogs, moveLogs, reqLogs] = await Promise.all([
          getLogsChunked(publicClient, { address: CONTRACT_ADDRESSES.Arena, event: MARK_PRICE_EVENT, args: { duelId }, fromBlock, toBlock }),
          getLogsChunked(publicClient, { address: CONTRACT_ADDRESSES.Arena, event: FIGHTER_MOVE_EVENT, args: { duelId }, fromBlock, toBlock }),
          getLogsChunked(publicClient, { address: CONTRACT_ADDRESSES.Arena, event: FIGHTER_MOVE_REQUESTED_EVENT, args: { duelId }, fromBlock, toBlock }),
        ]);
        if (cancelled) return;
        ingestMarkPriceLogs(markLogs as RawLog[]);
        // Process moves first, then requests — so thinking state is correct
        // (move clears thinking, request sets it; latest event wins)
        ingestMoveLogs(moveLogs as RawLog[]);
        ingestRequestLogs(reqLogs as RawLog[]);
      } catch {
        // Non-fatal: live watchers below pick up new events
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, publicClient, duelId, fromBlock, turns]);

  // ── Live watchers ─────────────────────────────────────────────────────────
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'MarkPriceSnapshot',
    args: { duelId },
    onLogs(logs) { ingestMarkPriceLogs(logs); },
    enabled,
  });

  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'FighterMove',
    args: { duelId },
    onLogs(logs) { ingestMoveLogs(logs); },
    enabled,
  });

  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'FighterMoveRequested',
    args: { duelId },
    onLogs(logs) { ingestRequestLogs(logs); },
    enabled,
  });

  // ── Active pools (from duel.poolMask) ─────────────────────────────────────
  const activePools = !duel ? [] : POOLS.filter((p) => (duel.poolMask & p.bit) !== 0);

  // ── Read fighterBalances for each active pool × 2 fighters ────────────────
  // Build batched contract reads: [poolA×fighterA, poolA×fighterB, poolB×fighterA, …]
  const fighterAIndex = duel?.fighterA ?? 0;
  const fighterBIndex = duel?.fighterB ?? 0;

  const balanceContracts = activePools.flatMap((pool) => [
    {
      address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
      abi: ABIS.Arena,
      functionName: 'fighterBalances' as const,
      args: [pool.address, duelId, fighterAIndex] as [string, bigint, number],
    },
    {
      address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
      abi: ABIS.Arena,
      functionName: 'fighterBalances' as const,
      args: [pool.address, duelId, fighterBIndex] as [string, bigint, number],
    },
  ]);

  const { data: balancesRaw, isLoading: balancesLoading } = useReadContracts({
    contracts: balanceContracts,
    query: { enabled: enabled && activePools.length > 0, refetchInterval: 10_000 },
  });

  // ── Derive per-fighter portfolio value ─────────────────────────────────────
  // balancesRaw is indexed as: [pool0×A, pool0×B, pool1×A, pool1×B, ...]
  if (!enabled || !duel) return EMPTY_RESULT;

  const initialUsdso = duel.quoteBalanceA; // initialUsdsoPerFighter (same for A and B)

  let valueA = BigInt(0);
  let valueB = BigInt(0);
  const holdingsA: PoolHolding[] = [];
  const holdingsB: PoolHolding[] = [];

  activePools.forEach((pool, pi) => {
    const rawA = balancesRaw?.[pi * 2];
    const rawB = balancesRaw?.[pi * 2 + 1];

    const balA = (rawA?.status === 'success' && rawA.result) ? (rawA.result as [bigint, bigint]) : null;
    const balB = (rawB?.status === 'success' && rawB.result) ? (rawB.result as [bigint, bigint]) : null;

    const poolAddr = pool.address.toLowerCase();
    const markEntry = markPrices.get(poolAddr);
    const markPrice = markEntry?.price ?? BigInt(0);

    if (balA) {
      const [baseA, quoteA] = balA;
      // value = quote + base * markPrice / 10^decimals
      const baseValueA = markPrice > BigInt(0)
        ? baseA * markPrice / (BigInt(10) ** BigInt(pool.decimals))
        : BigInt(0);
      valueA += quoteA + baseValueA;
      holdingsA.push({
        token: pool.key,
        baseAmount: formatUnits(baseA, pool.decimals),
        quoteAmount: formatUnits(quoteA, 18),
      });
    }

    if (balB) {
      const [baseB, quoteB] = balB;
      const baseValueB = markPrice > BigInt(0)
        ? baseB * markPrice / (BigInt(10) ** BigInt(pool.decimals))
        : BigInt(0);
      valueB += quoteB + baseValueB;
      holdingsB.push({
        token: pool.key,
        baseAmount: formatUnits(baseB, pool.decimals),
        quoteAmount: formatUnits(quoteB, 18),
      });
    }
  });

  // ── Markets ────────────────────────────────────────────────────────────────
  const markets: PoolMarket[] = activePools.map((pool) => {
    const entry = markPrices.get(pool.address.toLowerCase());
    const price = entry?.price ?? BigInt(0);
    return {
      poolKey: pool.key,
      poolAddress: pool.address,
      markPrice: price,
      markPriceNum: bigintToNum(price, 18),
      history: entry?.history ?? [],
    };
  });

  // ── Compose result ─────────────────────────────────────────────────────────
  const pnlA = valueA > BigInt(0) ? (valueA > initialUsdso ? valueA - initialUsdso : -(initialUsdso - valueA)) : BigInt(0);
  const pnlB = valueB > BigInt(0) ? (valueB > initialUsdso ? valueB - initialUsdso : -(initialUsdso - valueB)) : BigInt(0);

  // A resolved duel is over — no fighter is "thinking". (Matters for replays of
  // finished duels, where a trailing FighterMoveRequested has no clearing move.)
  const duelOver = duel.status === 3;

  const fA: FighterLive = {
    valueUsdso: valueA,
    pnl: pnlA,
    pnlNum: Number(formatUnits(pnlA, 18)),
    holdings: holdingsA,
    lastAction: lastActions.get(fighterAIndex) ?? '',
    thinking: duelOver ? false : (thinking.get(fighterAIndex) ?? false),
  };

  const fB: FighterLive = {
    valueUsdso: valueB,
    pnl: pnlB,
    pnlNum: Number(formatUnits(pnlB, 18)),
    holdings: holdingsB,
    lastAction: lastActions.get(fighterBIndex) ?? '',
    thinking: duelOver ? false : (thinking.get(fighterBIndex) ?? false),
  };

  return {
    fighterA: fA,
    fighterB: fB,
    markets,
    isLoading: balancesLoading,
  };
}
