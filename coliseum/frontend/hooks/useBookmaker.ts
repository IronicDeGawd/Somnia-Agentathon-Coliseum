'use client';

import { useReadContract, useWriteContract } from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES } from '@/lib/contracts';

export const useBookmaker = (duelId?: bigint) => {
  const { writeContractAsync: writeContract } = useWriteContract();

  // Read current odds from Bookmaker
  const { data: oddsData, isLoading, refetch } = useReadContract({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    functionName: 'currentOdds',
    // currentOdds(duelId, index) — index 0 = fighterA odds (BPS)
    args: duelId !== undefined ? [duelId, BigInt(0)] : undefined,
    query: {
      enabled: duelId !== undefined,
    },
  });

  // Approve ERC20 quote token allowance
  const approveQuoteToken = async (amount: bigint) => {
    return writeContract({
      address: CONTRACT_ADDRESSES.USDso,
      abi: ABIS.USDso,
      functionName: 'approve',
      args: [CONTRACT_ADDRESSES.Bookmaker, amount],
    });
  };

  // Place bet on a combatant slot
  const placeBet = async (id: bigint, slot: number, amount: bigint) => {
    return writeContract({
      address: CONTRACT_ADDRESSES.Bookmaker,
      abi: ABIS.Bookmaker,
      functionName: 'placeBet',
      args: [id, slot, amount],
    });
  };

  // Settle bets for a concluded duel
  const settleBets = async (id: bigint) => {
    return writeContract({
      address: CONTRACT_ADDRESSES.Bookmaker,
      abi: ABIS.Bookmaker,
      functionName: 'settleBets',
      args: [id],
    });
  };

  // oddsData is a single uint16 (BPS) for fighterA. WhaleOdds = 10000 - degenOdds.
  const degenOddsBps = oddsData ? Number(oddsData) : 0;
  return {
    odds: oddsData ? {
      degenOdds: degenOddsBps / 100,
      whaleOdds: (10000 - degenOddsBps) / 100,
    } : null,
    isLoading,
    refetch,
    approveQuoteToken,
    placeBet,
    settleBets,
  };
};
