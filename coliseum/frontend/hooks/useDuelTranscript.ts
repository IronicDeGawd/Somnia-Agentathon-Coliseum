'use client';

import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { parseAbiItem } from 'viem';
import { CONTRACT_ADDRESSES, actionLabels, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';
import type { SlotKind } from '@/lib/contracts';
import { getLogsChunked, duelToBlock } from '@/lib/logs';
import { blockTimes } from '@/lib/blockTime';

const FIGHTER_MOVE_EVENT = parseAbiItem(
  'event FighterMove(uint256 indexed duelId, uint8 indexed fighterId, uint8 action, uint128 orderId)',
);
const FIGHTER_MOVE_FAILED_EVENT = parseAbiItem(
  'event FighterMoveFailed(uint256 indexed duelId, uint8 indexed fighterId, string reason)',
);

export interface TranscriptEntry {
  round: number;          // 1-based; two fighter moves per round
  fighterId: number;      // registry index
  action: string | null;  // e.g. "BUY SOMI" / "HOLD", or null when the move failed
  reason: string | null;  // failure reason when failed
  failed: boolean;
  /** The block this move was mined in. Kept so it can be given a time. */
  block: bigint;
  /**
   * Wall-clock seconds, once the block has been asked. Undefined means "not
   * looked up yet, or the node would not say" — never a guess. See lib/blockTime.
   */
  timestamp?: number;
}

type RawLog = { blockNumber: bigint | null; logIndex: number | null; args: Record<string, unknown> };

/**
 * Move-by-move transcript for a (usually resolved) duel, read from FighterMove /
 * FighterMoveFailed events over the duel's own block span (chunked getLogs, so the
 * RPC's 1000-block range cap doesn't blank it). Ordered chronologically; rounds
 * are derived by pairing the two fighter moves per turn.
 */
export function useDuelTranscript(
  duelId: bigint,
  startBlock?: bigint,
  turns?: number,
  lastTurnBlock?: bigint,
  /**
   * What the fight's three slots hold, from `useDuelSlots`. Without it a move is
   * named after the coin book that slot would hold on a spot fight — which is the
   * wrong market's name on an events or perps fight, not merely a vaguer one.
   */
  slots?: SlotKind[],
): { entries: TranscriptEntry[]; isLoading: boolean } {
  const publicClient = usePublicClient();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isLoading, setLoading] = useState(true);

  const labels = actionLabels(slots);
  const labelKey = labels.join('|');

  useEffect(() => {
    if (!publicClient || duelId <= BigInt(0)) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const fromBlock = startBlock ?? BOOKMAKER_DEPLOY_BLOCK;
      const toBlock = duelToBlock(fromBlock, turns ?? 3, lastTurnBlock);
      const [moves, fails] = await Promise.all([
        getLogsChunked(publicClient, { address: CONTRACT_ADDRESSES.Arena, event: FIGHTER_MOVE_EVENT, args: { duelId }, fromBlock, toBlock }),
        getLogsChunked(publicClient, { address: CONTRACT_ADDRESSES.Arena, event: FIGHTER_MOVE_FAILED_EVENT, args: { duelId }, fromBlock, toBlock }),
      ]);
      if (cancelled) return;

      const merged = [
        ...(moves as RawLog[]).map((m) => ({
          block: m.blockNumber ?? BigInt(0),
          logIndex: m.logIndex ?? 0,
          fighterId: Number(m.args.fighterId),
          action: labels[Number(m.args.action)] ?? 'HOLD',
          reason: null as string | null,
          failed: false,
        })),
        ...(fails as RawLog[]).map((f) => ({
          block: f.blockNumber ?? BigInt(0),
          logIndex: f.logIndex ?? 0,
          fighterId: Number(f.args.fighterId),
          action: null as string | null,
          reason: String(f.args.reason ?? ''),
          failed: true,
        })),
      ];

      merged.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));

      const ordered: TranscriptEntry[] = merged.map((e, i) => ({
        round: Math.floor(i / 2) + 1,
        fighterId: e.fighterId,
        action: e.action,
        reason: e.reason,
        failed: e.failed,
        block: e.block,
      }));

      // Show the moves first, then fill the times in. The list is the point; the
      // clock is an adornment, and blocking the whole transcript on thirty extra
      // round-trips would make a finished fight look like a page that failed.
      setEntries(ordered);
      setLoading(false);

      const times = await blockTimes(publicClient, ordered.map((e) => e.block));
      if (cancelled) return;
      setEntries(ordered.map((e) => ({ ...e, timestamp: times.get(String(e.block)) })));
    })();
    return () => { cancelled = true; };
  // labelKey rather than `labels`: a fresh array every render would re-run this on
  // every paint, and the join changes exactly when a name actually changes — which
  // is when the slot reads land and the transcript must be relabelled.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, duelId, startBlock, turns, lastTurnBlock, labelKey]);

  return { entries, isLoading };
}
