'use client';

import { useReadContract, useWriteContract } from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES } from '@/lib/contracts';

export const useArena = (duelId?: bigint) => {
  const { writeContractAsync: writeContract } = useWriteContract();

  // Read duel parameters from on-chain Arena
  const { data: duelData, isError, isLoading, refetch } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'duels',
    args: duelId !== undefined ? [duelId] : undefined,
    query: {
      enabled: duelId !== undefined,
    },
  });

  // Start a new AI Duel
  const startDuel = async (fighterA: number, fighterB: number, turns: number) => {
    return writeContract({
      address: CONTRACT_ADDRESSES.Arena,
      abi: ABIS.Arena,
      functionName: 'startDuel',
      args: [fighterA, fighterB, turns],
    });
  };

  // Finalize / Settle a completed duel
  const finalizeDuel = async (id: bigint) => {
    return writeContract({
      address: CONTRACT_ADDRESSES.Arena,
      abi: ABIS.Arena,
      functionName: 'finalizeDuel',
      args: [id],
    });
  };

  // Recover owner-allocated deposits after duel settles
  const recoverFunds = async (id: bigint) => {
    return writeContract({
      address: CONTRACT_ADDRESSES.Arena,
      abi: ABIS.Arena,
      functionName: 'recoverFunds',
      args: [id],
    });
  };

  return {
    duel: duelData ? {
      creator: duelData[0],
      turns: duelData[1],
      poolMask: duelData[2],
      currentTurn: duelData[3],
      status: duelData[4],
      winnerSlot: duelData[5],
      quoteBalanceA: duelData[6],
      quoteBalanceB: duelData[7],
    } : null,
    isLoading,
    isError,
    refetch,
    startDuel,
    finalizeDuel,
    recoverFunds,
  };
};
