'use client';

import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { parseAbiItem } from 'viem';
import { CONTRACT_ADDRESSES, FIGHTER_ACTIONS, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';
import { getLogsChunked, duelToBlock } from '@/lib/logs';

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
): { entries: TranscriptEntry[]; isLoading: boolean } {
  const publicClient = usePublicClient();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isLoading, setLoading] = useState(true);

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
          action: FIGHTER_ACTIONS[Number(m.args.action)] ?? 'HOLD',
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

      setEntries(
        merged.map((e, i) => ({
          round: Math.floor(i / 2) + 1,
          fighterId: e.fighterId,
          action: e.action,
          reason: e.reason,
          failed: e.failed,
        })),
      );
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [publicClient, duelId, startBlock, turns, lastTurnBlock]);

  return { entries, isLoading };
}
