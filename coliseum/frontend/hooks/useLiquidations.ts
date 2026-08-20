'use client';

import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { parseAbiItem } from 'viem';

import { CONTRACT_ADDRESSES, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';
import { getLogsChunked, duelToBlock } from '@/lib/logs';
import { blockTimes } from '@/lib/blockTime';
import { liquidationRecords, type LiquidationRecord, type RawLiquidationLog } from '@/lib/liquidations';

/**
 * Which fighter rented which trading account for this fight.
 *
 * Read, never assumed. There are eight accounts and they are handed out and taken
 * back fight after fight, so an address on its own says nothing — a liquidation
 * against it might belong to a fight three days ago.
 */
const LEASED = parseAbiItem(
  'event Leased(uint256 indexed duelId, uint8 indexed fighterId, address indexed account, uint256 budget)',
);

/**
 * The venue's own record of a liquidation. `stageReached`, `marginStatusBefore` and
 * `marginStatusAfter` are enums on the protocol side, which encode as uint8.
 */
const ACCOUNT_LIQUIDATED = parseAbiItem(
  'event AccountLiquidated(address indexed account, uint256 positionsProcessed, uint8 stageReached, uint8 marginStatusBefore, uint8 marginStatusAfter)',
);

/**
 * What the venue did to this fight's fighters — for a live fight or one finished
 * long ago, equally.
 *
 * This is the half of the margin story that is PERMANENT. The page's own polling
 * can only witness a state while somebody is watching; a liquidation is an act the
 * venue records, so it can be read back forever. See lib/liquidations for why the
 * two are different kinds of fact, and why a plain margin call is neither.
 *
 * A note on what "empty" means here: no liquidation has ever happened to one of our
 * fighters, and — measured over 150,000 blocks — none has happened to anyone else on
 * this venue either. So an empty result is the expected result, and must not be
 * dressed up as a failure or as proof the query is wrong.
 */
export function useLiquidations(
  duelId: bigint,
  startBlock?: bigint,
  turns?: number,
  lastTurnBlock?: bigint,
): LiquidationRecord[] {
  const publicClient = usePublicClient();
  const [records, setRecords] = useState<LiquidationRecord[]>([]);

  useEffect(() => {
    if (!publicClient || duelId <= BigInt(0)) { setRecords([]); return; }
    let cancelled = false;
    void (async () => {
      const fromBlock = startBlock ?? BOOKMAKER_DEPLOY_BLOCK;
      const toBlock = duelToBlock(fromBlock, turns ?? 3, lastTurnBlock);

      const leased = await getLogsChunked(publicClient, {
        address: CONTRACT_ADDRESSES.PerpRegistry,
        event: LEASED as never,
        args: { duelId },
        fromBlock,
        toBlock,
      }) as { args: { account?: string; fighterId?: number } }[];
      if (cancelled) return;

      // A spot, events or practice fight rents nothing, so there is nothing to ask
      // the venue about. Stopping here also spares those fights a pointless scan.
      if (leased.length === 0) { setRecords([]); return; }

      const accountOf = new Map<string, number>();
      for (const l of leased) {
        if (l.args.account && l.args.fighterId !== undefined) {
          accountOf.set(l.args.account.toLowerCase(), Number(l.args.fighterId));
        }
      }

      const logs: RawLiquidationLog[] = [];
      for (const account of accountOf.keys()) {
        const found = await getLogsChunked(publicClient, {
          address: CONTRACT_ADDRESSES.LiquidationEngine,
          event: ACCOUNT_LIQUIDATED as never,
          args: { account: account as `0x${string}` },
          fromBlock,
          toBlock,
        }) as RawLiquidationLog[];
        logs.push(...found);
      }
      if (cancelled) return;

      const found = liquidationRecords(logs, accountOf);
      if (found.length === 0) { setRecords([]); return; }

      setRecords(found);
      const times = await blockTimes(publicClient, found.map((r) => r.block));
      if (cancelled) return;
      setRecords(found.map((r) => ({ ...r, timestamp: times.get(String(r.block)) })));
    })();
    return () => { cancelled = true; };
  }, [publicClient, duelId, startBlock, turns, lastTurnBlock]);

  return records;
}
