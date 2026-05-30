'use client';

import { useState, useCallback } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';

export function usePlaceBet(duelId: bigint, slot: 0 | 1, amount: bigint) {
  const { address } = useAccount();
  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACT_ADDRESSES.USDso,
    abi: ABIS.USDso,
    functionName: 'allowance',
    args: address ? [address, CONTRACT_ADDRESSES.Bookmaker] : undefined,
    query: { enabled: !!address },
  });

  const { writeContractAsync: approveAsync } = useWriteContract();
  const { writeContractAsync: placeBetAsync } = useWriteContract();

  const placeBet = useCallback(async () => {
    if (!address) {
      setError(new Error('Wallet not connected'));
      return;
    }

    setIsPending(true);
    setIsSuccess(false);
    setError(null);

    try {
      // Step 1: Check allowance and approve if needed
      const { data: freshAllowance } = await refetchAllowance();
      const currentAllowance = (freshAllowance as bigint | undefined) ?? BigInt(0);

      if (currentAllowance < amount) {
        await approveAsync({
          address: CONTRACT_ADDRESSES.USDso,
          abi: ABIS.USDso,
          functionName: 'approve',
          args: [CONTRACT_ADDRESSES.Bookmaker, amount],
        });
      }

      // Step 2: Place the bet
      await placeBetAsync({
        address: CONTRACT_ADDRESSES.Bookmaker,
        abi: ABIS.Bookmaker,
        functionName: 'placeBet',
        args: [duelId, slot, amount],
      });

      setIsSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsPending(false);
    }
  }, [address, amount, duelId, slot, approveAsync, placeBetAsync, refetchAllowance]);

  return { placeBet, isPending, isSuccess, error };
}
