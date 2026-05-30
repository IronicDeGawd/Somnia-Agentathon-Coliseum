'use client';

import { useAccount, useReadContract } from 'wagmi';
import { formatUnits } from 'viem';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';

export function useUSDsoBalance(address?: string) {
  const { address: connectedAddress } = useAccount();
  const target = (address ?? connectedAddress) as `0x${string}` | undefined;

  const { data, isLoading } = useReadContract({
    address: CONTRACT_ADDRESSES.USDso,
    abi: ABIS.USDso,
    functionName: 'balanceOf',
    args: target ? [target] : undefined,
    query: {
      enabled: !!target,
      refetchInterval: 10000,
    },
  });

  const balance = (data as bigint | undefined) ?? BigInt(0);
  const formatted = Number(formatUnits(balance, 18)).toFixed(2);

  return { balance, formatted, isLoading };
}

export function useUSDsoAllowance(spender: string) {
  const { address: connectedAddress } = useAccount();

  const { data, isLoading } = useReadContract({
    address: CONTRACT_ADDRESSES.USDso,
    abi: ABIS.USDso,
    functionName: 'allowance',
    args: connectedAddress ? [connectedAddress, spender as `0x${string}`] : undefined,
    query: {
      enabled: !!connectedAddress && !!spender,
      refetchInterval: 10000,
    },
  });

  const allowance = (data as bigint | undefined) ?? BigInt(0);

  return { allowance, isLoading };
}
