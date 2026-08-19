'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublicClient, useReadContracts } from 'wagmi';
import { parseAbiItem, formatUnits } from 'viem';
import { ABIS, CONTRACT_ADDRESSES, POOL_SLOTS, actionLabels, slotLabel, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';
import type { SlotKind } from '@/lib/contracts';
import { getLogsChunked, duelToBlock } from '@/lib/logs';
import { getWsClient } from '@/lib/wsClient';
import type { DuelData } from '@/hooks/useDuelState';

type RawLog = { transactionHash: `0x${string}` | null; logIndex: number | null; args: unknown };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PoolHolding {
  token: string;          // pool key e.g. "WETH"
  baseAmount: string;     // formatted base token amount
  quoteAmount: string;    // formatted USDso amount
}

/**
 * One market a perps fighter is actually in.
 *
 * `size` is SIGNED and that sign is the whole point: positive is a long, negative
 * is a short, and zero means the fighter never entered this market. A holdings
 * row cannot express that — an amount is a quantity owned, and a short owns
 * nothing — which is why perps gets its own shape rather than being squeezed into
 * the spot one.
 */
export interface PerpPosition {
  market: string;               // slot label, e.g. "ETH"
  poolAddress: `0x${string}`;
  size: bigint;                 // signed, in base units
  baseDecimals: number;
  entryPrice: bigint;           // 18-dec USDso, the price it got in at
  markPrice: bigint;            // 18-dec USDso, the price right now
}

/**
 * What a perps fighter is worth, and why.
 *
 * A perps fighter has ONE account backing all three of its markets, so there is no
 * per-market balance to add up — the score is account equity, which is collateral
 * plus unrealised profit plus funding, and the Arena is the contract that decides
 * it. `live` false means the oracle could not be read just now; `snapshot` is then
 * what a finalize at this moment would score instead.
 */
export interface FighterPerp {
  live: boolean;
  equity: bigint;               // signed, 18 dec — only meaningful when `live`
  snapshot: bigint;             // 18 dec, the last recorded score
  account: `0x${string}`;
  /** 0 healthy · 1 margin call · 2 partial liquidation · 3 close-out. */
  marginStatus: number;
  /** The collateral this fighter started with, which is what PnL is measured from. */
  budget: bigint;
  positions: PerpPosition[];
}

export interface FighterLive {
  valueUsdso: bigint;           // total portfolio value in USDso (18 dec)
  pnl: bigint;                  // value - initialUsdsoPerFighter (signed)
  pnlNum: number;               // for UI display (float)
  holdings: PoolHolding[];      // per-pool base+quote amounts
  lastAction: string;           // e.g. "BUY WBTC", "HOLD", or "" if none yet
  thinking: boolean;            // FighterMoveRequested with no subsequent FighterMove
  /**
   * Present only on a perps fight, and when it is present it — not `holdings` —
   * is where the fighter's value comes from. See `FighterPerp`.
   */
  perp?: FighterPerp;
}

export interface PoolMarket {
  poolKey: string;              // "WETH" / "WBTC" / "SOMI", or a question like "BTCUP"
  poolAddress: `0x${string}`;
  markPrice: bigint;            // latest mark price (18 dec USDso per base token)
  markPriceNum: number;         // float for display
  history: number[];            // chronological mark prices (floats)
  /**
   * True when this slot holds a prediction question rather than a coin book. The
   * number then means a PROBABILITY between zero and one, not a price, so it must
   * not be shown with a currency symbol or a "/USDso" pair suffix.
   */
  isQuestion: boolean;
  /**
   * True when this slot is a perpetual futures market. It carries a label like a
   * question does, but its number is a PRICE — so the two cannot be told apart by
   * the label alone.
   */
  isPerp: boolean;
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

/** A slot's label ("BTCUP", "BTC"), or null for a plain coin book. */
const questionLabel = slotLabel;

function bigintToNum(v: bigint, decimals: number): number {
  return Number(formatUnits(v, decimals));
}

// ── localStorage cache ────────────────────────────────────────────────────────
// The live feed lives in React state, so a refresh blanks it until the getLogs
// backfill returns — and that backfill intermittently errors on the public RPC.
// We snapshot the accumulated state (and the dedup keys) per duel so a refresh
// repaints instantly; the backfill + live WS then reconcile, deduping against the
// restored seen-keys so nothing is double-counted. Bump the version on shape change.
interface LiveCache {
  markPrices: [string, { price: string; history: number[] }][];
  lastActions: [number, number][];
  thinking: [number, boolean][];
  seenMarkPrices: string[];
  seenMoves: string[];
  seenRequests: string[];
}

// v2 stores action IDs rather than labels. What an id MEANS depends on which
// markets the fight is on, and those are not known at the moment a move arrives —
// so a label baked in at ingest could be wrong and then cached as wrong.
const liveCacheKey = (duelId: bigint) => `coliseum:duellive:v2:${duelId.toString()}`;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDuelLive(
  duelId: bigint,
  duel: DuelData | null,
): DuelLiveResult {
  const enabled = duelId > BigInt(0) && duel !== null && duel.status !== 0;
  // The WS feed subscribes on duelId alone. `enabled` additionally requires
  // `duel`, which arrives from useDuelState — so gating the subscription on it
  // meant the working live feed sat idle waiting on another hook's freshness,
  // and the first turns of a duel were missed. The getLogs backfill below still
  // waits for `duel`, because it needs startBlock to stay bounded.
  const subscribeEnabled = duelId > BigInt(0);
  const publicClient = usePublicClient();

  // ── Mark price state: latest price + history per pool ─────────────────────
  // keyed by pool address (lowercased)
  const [markPrices, setMarkPrices] = useState<Map<string, { price: bigint; history: number[] }>>(new Map());

  // ── Last action state per fighter (registry index) ─────────────────────────
  // keyed by fighterId (registry index)
  const [lastActions, setLastActions] = useState<Map<number, number>>(new Map());

  // ── Thinking state: fighterId → bool ──────────────────────────────────────
  const [thinking, setThinking] = useState<Map<number, boolean>>(new Map());

  // ── Dedup refs for live event watchers ────────────────────────────────────
  const seenMarkPrices = useRef<Set<string>>(new Set());
  const seenMoves      = useRef<Set<string>>(new Set());
  const seenRequests   = useRef<Set<string>>(new Set());

  // ── Hydrate from cache on duelId change (else reset) ──────────────────────
  // Restores the feed instantly on refresh; seeds the seen-refs so the backfill
  // and live WS below reconcile without double-counting already-ingested logs.
  useEffect(() => {
    const reset = () => {
      setMarkPrices(new Map());
      setLastActions(new Map());
      setThinking(new Map());
      seenMarkPrices.current = new Set();
      seenMoves.current      = new Set();
      seenRequests.current   = new Set();
    };
    if (typeof window === 'undefined' || duelId <= BigInt(0)) { reset(); return; }
    try {
      const raw = window.localStorage.getItem(liveCacheKey(duelId));
      if (!raw) { reset(); return; }
      const c = JSON.parse(raw) as LiveCache;
      const mp = new Map<string, { price: bigint; history: number[] }>();
      for (const [addr, v] of c.markPrices) mp.set(addr, { price: BigInt(v.price), history: v.history });
      setMarkPrices(mp);
      setLastActions(new Map(c.lastActions));
      setThinking(new Map(c.thinking));
      seenMarkPrices.current = new Set(c.seenMarkPrices);
      seenMoves.current      = new Set(c.seenMoves);
      seenRequests.current   = new Set(c.seenRequests);
    } catch {
      reset();
    }
  }, [duelId]);

  // ── Persist live state to cache (skip the initial empty state so the hydrate
  //    above is never clobbered before it applies) ───────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || duelId <= BigInt(0)) return;
    if (markPrices.size === 0 && lastActions.size === 0) return;
    try {
      const payload: LiveCache = {
        markPrices: Array.from(markPrices.entries()).map(
          ([addr, v]) => [addr, { price: v.price.toString(), history: v.history }],
        ),
        lastActions: Array.from(lastActions.entries()),
        thinking: Array.from(thinking.entries()),
        seenMarkPrices: Array.from(seenMarkPrices.current),
        seenMoves: Array.from(seenMoves.current),
        seenRequests: Array.from(seenRequests.current),
      };
      window.localStorage.setItem(liveCacheKey(duelId), JSON.stringify(payload));
    } catch {
      // Quota exceeded / unavailable — non-fatal, state still lives in memory.
    }
  }, [duelId, markPrices, lastActions, thinking]);

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
        // The ID, not a label. Which market each id refers to is only known once
        // the fight's three slots have been read, and that read may not have
        // returned yet — see `slotKinds` below.
        setLastActions((prev) => new Map(prev).set(fid, action));
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
  const lastTurnBlock = duel?.lastTurnBlock;
  useEffect(() => {
    if (!enabled || !publicClient) return;
    let cancelled = false;
    void (async () => {
      // Bound by the duel's actual lastTurnBlock so a delayed in-progress duel's
      // already-emitted events aren't dropped before the live WS feed takes over.
      const toBlock = duelToBlock(fromBlock, turns, lastTurnBlock);
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
        // Non-fatal: the live WS feed below picks up new events
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, publicClient, duelId, fromBlock, turns, lastTurnBlock]);

  // ── Live feed: stream events over the dedicated WebSocket (eth_subscribe) ───
  // Replaces wagmi useWatchContractEvent, which was silent because the app's
  // HTTP transport can't do eth_subscribe. watchEvent over the WS client pushes
  // FighterMove/MarkPriceSnapshot/FighterMoveRequested in real time.
  useEffect(() => {
    if (!subscribeEnabled) return;
    const client = getWsClient();
    if (!client) return;
    const unwatchers: (() => void)[] = [];
    try {
      unwatchers.push(
        client.watchEvent({
          address: CONTRACT_ADDRESSES.Arena,
          event: MARK_PRICE_EVENT,
          args: { duelId },
          onLogs: (logs) => ingestMarkPriceLogs(logs as RawLog[]),
          onError: () => {},
        }),
      );
      unwatchers.push(
        client.watchEvent({
          address: CONTRACT_ADDRESSES.Arena,
          event: FIGHTER_MOVE_EVENT,
          args: { duelId },
          onLogs: (logs) => ingestMoveLogs(logs as RawLog[]),
          onError: () => {},
        }),
      );
      unwatchers.push(
        client.watchEvent({
          address: CONTRACT_ADDRESSES.Arena,
          event: FIGHTER_MOVE_REQUESTED_EVENT,
          args: { duelId },
          onLogs: (logs) => ingestRequestLogs(logs as RawLog[]),
          onError: () => {},
        }),
      );
    } catch {
      // WS unavailable — backfill + 10s balance poll still render the duel.
    }
    return () => {
      for (const u of unwatchers) { try { u(); } catch { /* already torn down */ } }
    };
  }, [subscribeEnabled, duelId, ingestMarkPriceLogs, ingestMoveLogs, ingestRequestLogs]);

  // ── Active pools: asked, not guessed ──────────────────────────────────────
  // This used to pick a hardcoded table from `duel.simulated`. That flag is
  // two-valued — practice or not — so an EVENTS fight reported false and resolved
  // to the real spot pools, and every balance read landed at an address where the
  // fight holds nothing. Events desks also move to fresh addresses every few
  // minutes, so no table could have been right. The Arena records each fight's
  // three markets when it starts; read those, and read each one's base decimals
  // rather than assuming (a desk presents 18, a real WBTC book is 8).
  const { data: poolReads } = useReadContracts({
    contracts: [
      {
        address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
        abi: ABIS.Arena,
        functionName: 'duelPoolsOf' as const,
        args: [duelId] as [bigint],
      },
    ],
    query: { enabled: duelId > BigInt(0) },
  });

  const duelPools = (poolReads?.[0]?.result as readonly `0x${string}`[] | undefined) ?? undefined;

  const { data: metaReads } = useReadContracts({
    contracts: (duelPools ?? []).flatMap((addr) => [
      {
        address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
        abi: ABIS.Arena,
        functionName: 'poolMeta' as const,
        args: [addr] as [`0x${string}`],
      },
      {
        // A slot holding a prediction desk carries the QUESTION it asks ("BTCUP").
        // Without it the page labels the slot by the asset it is named after, so a
        // probability of 0.845 reads as "WETH/USDso $0.8450" — a price, which it is
        // not. Empty for an ordinary coin book, which is what every spot pool is.
        address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
        abi: ABIS.Arena,
        functionName: 'poolQuestion' as const,
        args: [addr] as [`0x${string}`],
      },
      {
        // A perps slot ALSO carries a label ("BTC"), so the label alone no longer
        // says how to read the number behind it. A question's number is a chance
        // between zero and one; a perp's is a price in the tens of thousands. Ask
        // outright, or Bitcoin at $64,000 renders as 6,400,000%.
        address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
        abi: ABIS.Arena,
        functionName: 'isPerpPool' as const,
        args: [addr] as [`0x${string}`],
      },
    ]),
    query: { enabled: !!duelPools },
  });

  const activePools = !duel || !duelPools
    ? []
    : POOL_SLOTS.flatMap((slot, i) => {
        if ((duel.poolMask & slot.bit) === 0) return [];
        const address = duelPools[i];
        if (!address || /^0x0+$/.test(address)) return [];
        const meta = metaReads?.[i * 3]?.result as readonly [number, bigint, bigint, bigint] | undefined;
        const question = metaReads?.[i * 3 + 1]?.result as `0x${string}` | undefined;
        const isPerp = metaReads?.[i * 3 + 2]?.result === true;
        const label = questionLabel(question);
        return [{
          key: label ?? (slot.key as string),
          // A perps slot has a label but quotes a price, so it is NOT a question.
          isQuestion: label !== null && !isPerp,
          isPerp,
          bit: slot.bit as number,
          address,
          // Fall back to 18 only while the read is in flight; every registered pool
          // has this cached on-chain.
          decimals: meta ? Number(meta[0]) : 18,
        }];
      });

  // ── What each of the three slots holds ────────────────────────────────────
  // Kept in slot order and NOT filtered by the mask, because the action ids are
  // numbered against slots rather than against the markets a fight happens to use.
  const slotKinds: SlotKind[] | undefined = duelPools && metaReads
    ? POOL_SLOTS.map((_, i) => ({
        label: questionLabel(metaReads[i * 3 + 1]?.result as `0x${string}` | undefined),
        isPerp: metaReads[i * 3 + 2]?.result === true,
      }))
    : undefined;

  // Six ids, two per slot, and what a pair MEANS depends on the market behind it:
  // buy and sell on a coin book, back and drop on a question, long and short on a
  // perpetual. Undefined until the slots are read, so a move reads by its
  // spot-book name for a moment rather than by the wrong market's name forever.
  const moveLabels = actionLabels(slotKinds);
  const labelOf = (id?: number) => (id === undefined ? '' : moveLabels[id] ?? 'HOLD');

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
    query: { enabled: enabled && activePools.length > 0, refetchInterval: 10_000, refetchIntervalInBackground: true },
  });

  // ── Perps: the score, and the positions behind it ─────────────────────────
  // A perps fight is scored from account equity, NOT from the per-pool ledger read
  // above. That ledger is credited with the full deposit on every pool at start and
  // a perps trade never touches it again — so reading it makes both fighters look
  // worth three times their deposit, unchanged, for the whole fight. Payouts were
  // never affected (they come from equity), but the scoreboard was.
  const isPerpDuel = activePools.some((p) => p.isPerp);

  const { data: perpRaw, isLoading: perpLoading } = useReadContracts({
    contracts: [fighterAIndex, fighterBIndex].map((f) => ({
      address: CONTRACT_ADDRESSES.Arena as `0x${string}`,
      abi: ABIS.Arena,
      functionName: 'perpPositionOf' as const,
      args: [duelId, f] as [bigint, number],
    })),
    query: {
      enabled: enabled && isPerpDuel,
      refetchInterval: 10_000,
      refetchIntervalInBackground: true,
    },
  });

  const perpResultOf = (i: number) => {
    const r = perpRaw?.[i];
    if (r?.status !== 'success' || !r.result) return null;
    return r.result as readonly [boolean, bigint, bigint, `0x${string}`, number];
  };

  // The per-market breakdown needs the fighter's trading ADDRESS, which only the
  // read above can supply — so this is a second round rather than one batch.
  const perpAccounts = [perpResultOf(0)?.[3], perpResultOf(1)?.[3]];
  const haveAccounts = perpAccounts.every((a) => a && !/^0x0+$/.test(a));

  const { data: positionsRaw } = useReadContracts({
    contracts: haveAccounts
      ? perpAccounts.flatMap((account) =>
          activePools.map((pool) => ({
            address: CONTRACT_ADDRESSES.MarginBank,
            abi: ABIS.MarginBank,
            functionName: 'getPosition' as const,
            args: [account as `0x${string}`, pool.address] as [`0x${string}`, `0x${string}`],
          })),
        )
      : [],
    query: {
      enabled: enabled && isPerpDuel && haveAccounts && activePools.length > 0,
      refetchInterval: 10_000,
      refetchIntervalInBackground: true,
    },
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

  // ── Perps override ─────────────────────────────────────────────────────────
  // On a perps fight everything derived above is wrong by construction, so it is
  // replaced rather than adjusted. Equity when the oracle answers; the last
  // recorded score when it does not — never a blend of the two, because a client
  // that cannot tell them apart cannot tell a flat fighter from a dark market.
  const buildPerp = (i: number): FighterPerp | undefined => {
    const r = perpResultOf(i);
    if (!r) return undefined;
    const [live, equity, snapshot, account, marginStatus] = r;
    const positions: PerpPosition[] = activePools.flatMap((pool, pi) => {
      const raw = positionsRaw?.[i * activePools.length + pi];
      if (raw?.status !== 'success' || !raw.result) return [];
      const [size, avgEntryPrice] = raw.result as readonly [bigint, bigint, bigint, bigint];
      // A fighter that never entered a market has no position to show, and a row
      // reading zero would be indistinguishable from one that closed out flat.
      if (size === BigInt(0)) return [];
      return [{
        market: pool.key,
        poolAddress: pool.address,
        size,
        baseDecimals: pool.decimals,
        entryPrice: avgEntryPrice,
        markPrice: markPrices.get(pool.address.toLowerCase())?.price ?? BigInt(0),
      }];
    });
    return { live, equity, snapshot, account, marginStatus, budget: initialUsdso, positions };
  };

  const perpA = isPerpDuel ? buildPerp(0) : undefined;
  const perpB = isPerpDuel ? buildPerp(1) : undefined;

  /** A perps fighter's score: equity while the oracle answers, else the snapshot. */
  const perpValue = (p?: FighterPerp) =>
    p ? (p.live ? p.equity : p.snapshot) : undefined;

  const perpValueA = perpValue(perpA);
  const perpValueB = perpValue(perpB);
  if (perpValueA !== undefined) valueA = perpValueA;
  if (perpValueB !== undefined) valueB = perpValueB;
  if (isPerpDuel) {
    // One account backs all three markets, so there is no per-pool balance to list.
    holdingsA.length = 0;
    holdingsB.length = 0;
  }

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
      isQuestion: pool.isQuestion,
      isPerp: pool.isPerp,
    };
  });

  // ── Compose result ─────────────────────────────────────────────────────────
  // The zero guard means "no balances have been read yet", not "this fighter is
  // worth nothing" — without it a fight shows a full loss for a moment while the
  // first read is in flight. It does NOT apply to perps: a fighter whose equity is
  // genuinely zero has lost its whole budget, and that is the one moment the
  // scoreboard most needs to say so.
  const pnlOf = (value: bigint, isPerp: boolean) =>
    isPerp || value > BigInt(0) ? value - initialUsdso : BigInt(0);
  const pnlA = pnlOf(valueA, perpValueA !== undefined);
  const pnlB = pnlOf(valueB, perpValueB !== undefined);

  // A resolved duel is over — no fighter is "thinking". (Matters for replays of
  // finished duels, where a trailing FighterMoveRequested has no clearing move.)
  const duelOver = duel.status === 3;

  const fA: FighterLive = {
    valueUsdso: valueA,
    pnl: pnlA,
    pnlNum: Number(formatUnits(pnlA, 18)),
    holdings: holdingsA,
    lastAction: labelOf(lastActions.get(fighterAIndex)),
    thinking: duelOver ? false : (thinking.get(fighterAIndex) ?? false),
    perp: perpA,
  };

  const fB: FighterLive = {
    valueUsdso: valueB,
    pnl: pnlB,
    pnlNum: Number(formatUnits(pnlB, 18)),
    holdings: holdingsB,
    lastAction: labelOf(lastActions.get(fighterBIndex)),
    thinking: duelOver ? false : (thinking.get(fighterBIndex) ?? false),
    perp: perpB,
  };

  return {
    fighterA: fA,
    fighterB: fB,
    markets,
    isLoading: balancesLoading || (isPerpDuel && perpLoading),
  };
}
