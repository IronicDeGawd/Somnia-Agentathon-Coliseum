'use client';

import { useState, useCallback } from 'react';
import { useAccount, useReadContract, useWriteContract, usePublicClient } from 'wagmi';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';
import { config } from '@/lib/chain';

export function useQueue(fighter: number, turns: 3 | 6 | 9 | 15) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ config });
  const { writeContractAsync } = useWriteContract();

  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- reads ---

  const { data: halfDepositRaw, refetch: refetchHalfDeposit } = useReadContract({
    address: CONTRACT_ADDRESSES.Matchmaker,
    abi: ABIS.Matchmaker,
    functionName: 'halfDeposit',
    args: [turns],
    query: { enabled: true },
  });

  const halfDeposit: bigint | null =
    halfDepositRaw !== undefined ? (halfDepositRaw as bigint) : null;

  const { data: allowanceRaw, refetch: refetchAllowance } = useReadContract({
    address: CONTRACT_ADDRESSES.USDso,
    abi: ABIS.USDso,
    functionName: 'allowance',
    args: address ? [address, CONTRACT_ADDRESSES.Matchmaker] : undefined,
    query: { enabled: !!address },
  });

  const { data: balanceRaw } = useReadContract({
    address: CONTRACT_ADDRESSES.USDso,
    abi: ABIS.USDso,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const usdsoBalance: bigint = balanceRaw !== undefined ? (balanceRaw as bigint) : BigInt(0);
  const hasEnough: boolean =
    !!address && halfDeposit !== null && usdsoBalance >= halfDeposit;

  // --- helpers ---

  function resetState() {
    setIsPending(true);
    setIsSuccess(false);
    setError(null);
  }

  // --- actions ---

  const enterQueue = useCallback(async (): Promise<void> => {
    if (!address) {
      setError('Wallet not connected');
      return;
    }
    if (halfDeposit === null) {
      setError('Deposit amount not yet loaded');
      return;
    }
    if (!publicClient) {
      setError('Public client unavailable');
      return;
    }

    resetState();

    try {
      // Somnia Shannon testnet only accepts legacy (type-0) transactions.
      // Passing gasPrice forces viem/MetaMask out of EIP-1559 (type-2) mode.
      const gasPrice = await publicClient.getGasPrice();
      const currentAllowance = (allowanceRaw as bigint | undefined) ?? BigInt(0);

      if (currentAllowance < halfDeposit) {
        const approveTxHash = await writeContractAsync({
          address: CONTRACT_ADDRESSES.USDso,
          abi: ABIS.USDso,
          functionName: 'approve',
          args: [CONTRACT_ADDRESSES.Matchmaker, halfDeposit],
          gasPrice,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
        await refetchAllowance();
      }

      const txHash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.Matchmaker,
        abi: ABIS.Matchmaker,
        functionName: 'queue',
        args: [fighter, turns],
        gasPrice,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      setIsSuccess(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsPending(false);
    }
  }, [address, allowanceRaw, fighter, turns, halfDeposit, publicClient, writeContractAsync, refetchAllowance]);

  const cancelQueue = useCallback(async (): Promise<void> => {
    if (!address) {
      setError('Wallet not connected');
      return;
    }
    if (!publicClient) {
      setError('Public client unavailable');
      return;
    }

    resetState();

    try {
      const gasPrice = await publicClient.getGasPrice();
      const txHash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.Matchmaker,
        abi: ABIS.Matchmaker,
        functionName: 'cancelQueue',
        args: [turns],
        gasPrice,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await refetchHalfDeposit();

      setIsSuccess(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsPending(false);
    }
  }, [address, turns, publicClient, writeContractAsync, refetchHalfDeposit]);

  const claimWinnings = useCallback(async (duelId: bigint): Promise<void> => {
    if (!address) {
      setError('Wallet not connected');
      return;
    }
    if (!publicClient) {
      setError('Public client unavailable');
      return;
    }

    resetState();

    try {
      const gasPrice = await publicClient.getGasPrice();
      const txHash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.Matchmaker,
        abi: ABIS.Matchmaker,
        functionName: 'claimWinnings',
        args: [duelId],
        gasPrice,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      setIsSuccess(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsPending(false);
    }
  }, [address, publicClient, writeContractAsync]);

  return {
    halfDeposit,
    usdsoBalance,
    hasEnough,
    enterQueue,
    cancelQueue,
    claimWinnings,
    isPending,
    isSuccess,
    error,
  };
}
