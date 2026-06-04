'use client';

import { useEffect, useState } from 'react';
import { usePublicClient, useAccount } from 'wagmi';
import { parseAbi } from 'viem';
import { CONTRACT_ADDRESSES, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';

export interface MyBet {
  duelId: bigint;
  fighterId: number;
  stake: bigint;
  oddsBps: number;
  betIndex: bigint;
}

const BET_PLACED_ABI = parseAbi([
  'event BetPlaced(uint256 indexed duelId, uint8 indexed fighterId, address indexed bettor, uint256 stake, uint16 oddsAtPlacementBps, uint256 betIndex)',
]);

export function useMyBets(): {
  bets: MyBet[];
  isEmpty: boolean;
  isLoading: boolean;
} {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const [bets, setBets] = useState<MyBet[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!address || !publicClient) {
      setBets([]);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchBets() {
      if (!publicClient || !address) return;
      setIsLoading(true);
      try {
        const logs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.Bookmaker,
          event: BET_PLACED_ABI[0],
          args: { bettor: address },
          fromBlock: BOOKMAKER_DEPLOY_BLOCK,
          toBlock: 'latest',
        });

        if (cancelled) return;

        const parsed: MyBet[] = logs.map((log) => {
          const args = log.args as {
            duelId?: bigint;
            fighterId?: number;
            bettor?: `0x${string}`;
            stake?: bigint;
            oddsAtPlacementBps?: number;
            betIndex?: bigint;
          };
          return {
            duelId: args.duelId ?? BigInt(0),
            fighterId: args.fighterId !== undefined ? Number(args.fighterId) : 0,
            stake: args.stake ?? BigInt(0),
            oddsBps: args.oddsAtPlacementBps !== undefined ? Number(args.oddsAtPlacementBps) : 0,
            betIndex: args.betIndex ?? BigInt(0),
          };
        });

        setBets(parsed);
      } catch {
        if (!cancelled) setBets([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchBets();
    return () => { cancelled = true; };
  }, [address, publicClient]);

  const isEmpty = bets.length === 0;

  return { bets, isEmpty, isLoading };
}
