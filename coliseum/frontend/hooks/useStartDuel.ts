'use client';

import { useState, useCallback } from 'react';
import { useAccount, useReadContract, useWriteContract, usePublicClient } from 'wagmi';
import { parseAbiItem, decodeEventLog } from 'viem';
import { ABIS, CONTRACT_ADDRESSES } from '@/lib/contracts';

const DUEL_STARTED_EVENT = parseAbiItem(
  'event DuelStarted(uint256 indexed duelId, uint8 fighterA, uint8 fighterB, address indexed creator, uint16 turns, uint8 poolMask, uint256 startBlock)'
);

export function useStartDuel(fighterA: number, fighterB: number, turns: 3 | 6 | 9 | 15) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const { data: minDeposit } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'minDepositFor',
    args: [turns as unknown as number],
  });

  // Fee scales with turns on-chain (platformFee = base + perTurn × turns).
  const { data: platformFee } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'platformFee',
    args: [turns as unknown as number],
  });

  const totalRequired =
    minDeposit !== undefined && platformFee !== undefined
      ? (minDeposit as bigint) + (platformFee as bigint)
      : null;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACT_ADDRESSES.USDso,
    abi: ABIS.USDso,
    functionName: 'allowance',
    args: address && totalRequired !== null ? [address, CONTRACT_ADDRESSES.Arena] : undefined,
    query: { enabled: !!address && totalRequired !== null },
  });

  const startDuel = useCallback(async (): Promise<bigint | null> => {
    if (!address) {
      setError(new Error('Wallet not connected'));
      return null;
    }
    if (totalRequired === null) {
      setError(new Error('Deposit amount not yet loaded'));
      return null;
    }
    if (!publicClient) {
      setError(new Error('Public client unavailable'));
      return null;
    }

    setIsPending(true);
    setIsSuccess(false);
    setError(null);

    try {
      const currentAllowance = (allowance as bigint | undefined) ?? BigInt(0);
      if (currentAllowance < totalRequired) {
        const approveTxHash = await writeContractAsync({
          address: CONTRACT_ADDRESSES.USDso,
          abi: ABIS.USDso,
          functionName: 'approve',
          args: [CONTRACT_ADDRESSES.Arena, totalRequired],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
        await refetchAllowance();
      }

      const txHash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.Arena,
        abi: ABIS.Arena,
        functionName: 'startDuel',
        args: [fighterA, fighterB, turns as unknown as number],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: [DUEL_STARTED_EVENT],
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'DuelStarted') {
            const duelId = (decoded.args as { duelId: bigint }).duelId;
            setIsSuccess(true);
            return duelId;
          }
        } catch {
          // not a DuelStarted log — continue
        }
      }

      setIsSuccess(true);
      return null;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      return null;
    } finally {
      setIsPending(false);
    }
  }, [address, allowance, fighterA, fighterB, turns, totalRequired, publicClient, writeContractAsync, refetchAllowance]);

  return {
    startDuel,
    minDeposit: minDeposit !== undefined ? (minDeposit as bigint) : null,
    totalRequired,
    isPending,
    isSuccess,
    error,
  };
}
