'use client';

import { useState, useCallback } from 'react';
import { useAccount, useWriteContract, usePublicClient, useSwitchChain } from 'wagmi';
import { maxUint256 } from 'viem';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';
import { config, somniaTestnet } from '@/lib/chain';

export function usePlaceBet(duelId: bigint, slot: 0 | 1, amount: bigint) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ config });
  const { switchChainAsync } = useSwitchChain();
  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

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
      if (chainId !== somniaTestnet.id) {
        await switchChainAsync({ chainId: somniaTestnet.id });
      }
      const gasPrice = publicClient ? await publicClient.getGasPrice() : undefined;

      // Step 1: Check allowance fresh from chain and approve if needed
      const currentAllowance = publicClient ? await publicClient.readContract({
        address: CONTRACT_ADDRESSES.USDso,
        abi: ABIS.USDso,
        functionName: 'allowance',
        args: [address, CONTRACT_ADDRESSES.Bookmaker],
      }) as bigint : BigInt(0);

      if (currentAllowance < amount) {
        const approveTxHash = await approveAsync({
          address: CONTRACT_ADDRESSES.USDso,
          abi: ABIS.USDso,
          functionName: 'approve',
          args: [CONTRACT_ADDRESSES.Bookmaker, maxUint256],
          gasPrice,
          gas: BigInt(100000),
        });
        if (publicClient && approveTxHash) {
          await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
        }
      }

      // Step 2: Place the bet
      await placeBetAsync({
        address: CONTRACT_ADDRESSES.Bookmaker,
        abi: ABIS.Bookmaker,
        functionName: 'placeBet',
        args: [duelId, slot, amount],
        gasPrice,
        gas: BigInt(200000),
      });

      setIsSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsPending(false);
    }
  }, [address, chainId, amount, duelId, slot, approveAsync, placeBetAsync, publicClient, switchChainAsync]);

  return { placeBet, isPending, isSuccess, error };
}
