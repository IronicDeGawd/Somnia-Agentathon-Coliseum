'use client';

import { useState, useCallback } from 'react';
import { useAccount, useReadContract, useWriteContract, usePublicClient, useSwitchChain } from 'wagmi';
import { maxUint256 } from 'viem';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';
import { config, somniaTestnet } from '@/lib/chain';

export function useQueue(fighter: number, turns: 3 | 6 | 9 | 15) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ config });
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

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

  const { refetch: refetchAllowance } = useReadContract({
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

  // Gas for Matchmaker calls whose heavy path makes an Arena external call
  // (queue→startDuel, claimWinnings→recoverFunds). Estimate live, add 50%
  // headroom, floor at 5M to survive the match race, fall back to 12M if the
  // Somnia estimator is momentarily unavailable. (ES2017 target: BigInt(), no n.)
  async function withGasHeadroom(estimate: () => Promise<bigint>): Promise<bigint> {
    const FLOOR = BigInt(5000000);
    const FALLBACK = BigInt(12000000);
    try {
      const est = await estimate();
      const buffered = (est * BigInt(15)) / BigInt(10);
      return buffered > FLOOR ? buffered : FLOOR;
    } catch {
      return FALLBACK;
    }
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
      if (chainId !== somniaTestnet.id) {
        await switchChainAsync({ chainId: somniaTestnet.id });
      }
      // Somnia Shannon testnet only accepts legacy (type-0) transactions.
      // Passing gasPrice forces viem/MetaMask out of EIP-1559 (type-2) mode.
      const gasPrice = await publicClient.getGasPrice();
      // Always read allowance fresh from chain — wagmi cache can be stale.
      const currentAllowance = await publicClient.readContract({
        address: CONTRACT_ADDRESSES.USDso,
        abi: ABIS.USDso,
        functionName: 'allowance',
        args: [address, CONTRACT_ADDRESSES.Matchmaker],
      }) as bigint;

      if (currentAllowance < halfDeposit) {
        const approveTxHash = await writeContractAsync({
          address: CONTRACT_ADDRESSES.USDso,
          abi: ABIS.USDso,
          functionName: 'approve',
          args: [CONTRACT_ADDRESSES.Matchmaker, maxUint256],
          gasPrice,
          gas: BigInt(100000),
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
        await refetchAllowance();
      }

      // When this player matches an already-queued opponent, queue() runs
      // Arena.startDuel inline (dreamDEX swaps + order placement) — millions of
      // gas, far above the cheap first-player path. Estimate per call with
      // headroom; floor guards the match race; fallback covers estimator outages.
      const queueGas = await withGasHeadroom(() =>
        publicClient.estimateContractGas({
          address: CONTRACT_ADDRESSES.Matchmaker,
          abi: ABIS.Matchmaker,
          functionName: 'queue',
          args: [fighter, turns],
          account: address,
        }),
      );

      const txHash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.Matchmaker,
        abi: ABIS.Matchmaker,
        functionName: 'queue',
        args: [fighter, turns],
        gasPrice,
        gas: queueGas,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      setIsSuccess(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsPending(false);
    }
  }, [address, chainId, fighter, turns, halfDeposit, publicClient, writeContractAsync, switchChainAsync, refetchAllowance]);

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
      if (chainId !== somniaTestnet.id) {
        await switchChainAsync({ chainId: somniaTestnet.id });
      }
      const gasPrice = await publicClient.getGasPrice();
      const txHash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.Matchmaker,
        abi: ABIS.Matchmaker,
        functionName: 'cancelQueue',
        args: [turns],
        gasPrice,
        gas: BigInt(200000),
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
  }, [address, chainId, turns, publicClient, writeContractAsync, switchChainAsync, refetchHalfDeposit]);

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
      if (chainId !== somniaTestnet.id) {
        await switchChainAsync({ chainId: somniaTestnet.id });
      }
      const gasPrice = await publicClient.getGasPrice();
      // The first claimer triggers Arena.recoverFunds (dreamDEX withdrawal) —
      // a heavy external call; the second claimer just reads + transfers. Size
      // the limit to the heavy path so the first claim never out-of-gas reverts.
      const claimGas = await withGasHeadroom(() =>
        publicClient.estimateContractGas({
          address: CONTRACT_ADDRESSES.Matchmaker,
          abi: ABIS.Matchmaker,
          functionName: 'claimWinnings',
          args: [duelId],
          account: address,
        }),
      );
      const txHash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.Matchmaker,
        abi: ABIS.Matchmaker,
        functionName: 'claimWinnings',
        args: [duelId],
        gasPrice,
        gas: claimGas,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      setIsSuccess(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsPending(false);
    }
  }, [address, chainId, publicClient, writeContractAsync, switchChainAsync]);

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
