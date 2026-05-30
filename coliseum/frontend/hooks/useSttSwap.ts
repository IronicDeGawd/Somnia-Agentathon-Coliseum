'use client';

import { useState, useCallback } from 'react';
import { parseEther, formatUnits } from 'viem';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { CONTRACT_ADDRESSES } from '@/lib/contracts';

// SOMI/USDso pool on dreamDEX testnet (native STT is the pool's "SOMI" base).
const SOMI_POOL = '0x259fD6559214dd5aD3752322426eA9F9fABEFff4' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const TICK = parseEther('0.0001');

const POOL_ABI = [
  {
    name: 'placeTakerOrderWithoutVault',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'isBid', type: 'bool' },
      { name: 'userData', type: 'uint64' },
      { name: 'price', type: 'uint256' },
      { name: 'quantity', type: 'uint256' },
      { name: 'expireTimestampNs', type: 'uint64' },
      { name: 'orderType', type: 'uint8' },
      { name: 'selfMatchingOption', type: 'uint8' },
      { name: 'builder', type: 'address' },
      { name: 'builderFeeBpsTimes1k', type: 'uint96' },
    ],
    outputs: [
      { name: 'success', type: 'bool' },
      { name: 'orderId', type: 'uint128' },
    ],
  },
  {
    name: 'getWithdrawableBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'u', type: 'address' },
      { name: 't', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export type SwapStage =
  | 'idle'
  | 'reading-book'
  | 'simulating'
  | 'awaiting-signature'
  | 'swapping'
  | 'awaiting-withdraw'
  | 'withdrawing'
  | 'done'
  | 'error';

export interface SwapResult {
  swapHash?: `0x${string}`;
  withdrawHash?: `0x${string}`;
  usdsoGained?: bigint;
}

export function useSttSwap() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [stage, setStage] = useState<SwapStage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SwapResult>({});

  const reset = useCallback(() => {
    setStage('idle');
    setError(null);
    setResult({});
  }, []);

  const swap = useCallback(
    async (amountStt: string) => {
      if (!address || !publicClient || !walletClient) {
        setError('Wallet not connected');
        setStage('error');
        return;
      }

      let sellAmount: bigint;
      try {
        sellAmount = parseEther(amountStt);
      } catch {
        setError('Invalid amount');
        setStage('error');
        return;
      }
      if (sellAmount <= BigInt(0)) {
        setError('Amount must be > 0');
        setStage('error');
        return;
      }

      setError(null);
      setResult({});

      try {
        // 1. Read best bid via Next API proxy (avoids CORS).
        setStage('reading-book');
        const bookRes = await fetch('/api/dreamdex-book', { cache: 'no-store' });
        if (!bookRes.ok) throw new Error(`Orderbook fetch failed (${bookRes.status})`);
        const bookData = await bookRes.json();
        const bids = bookData?.orderbooks?.[0]?.bids ?? [];
        if (bids.length === 0) {
          throw new Error('No bids on the SOMI/USDso book right now — try again in a few seconds.');
        }
        const bestBid = parseEther(String(bids[0].price));

        // 2. Sell floor = best bid − 10 ticks, tick-aligned.
        const floor = ((bestBid - BigInt(10) * TICK) / TICK) * TICK;
        const expireNs =
          BigInt(Math.floor(Date.now() / 1000) + 3600) * BigInt(1_000_000_000);
        const args = [false, BigInt(0), floor, sellAmount, expireNs, 2, 0, ZERO, BigInt(0)] as const;

        // 3. Simulate — if (false, 0), abort gas-free.
        setStage('simulating');
        const sim = await publicClient.simulateContract({
          account: address,
          address: SOMI_POOL,
          abi: POOL_ABI,
          functionName: 'placeTakerOrderWithoutVault',
          value: sellAmount,
          args,
        });
        const [ok] = sim.result as [boolean, bigint];
        if (!ok) {
          throw new Error('On-chain book has no matchable bid right now. Retry shortly.');
        }

        // 4. Broadcast taker order.
        setStage('awaiting-signature');
        const usdsoBefore = (await publicClient.readContract({
          address: CONTRACT_ADDRESSES.USDso,
          abi: [
            {
              name: 'balanceOf',
              type: 'function',
              stateMutability: 'view',
              inputs: [{ type: 'address' }],
              outputs: [{ type: 'uint256' }],
            },
          ] as const,
          functionName: 'balanceOf',
          args: [address],
        })) as bigint;

        const swapHash = await walletClient.writeContract({
          address: SOMI_POOL,
          abi: POOL_ABI,
          functionName: 'placeTakerOrderWithoutVault',
          value: sellAmount,
          args,
        });
        setResult((r) => ({ ...r, swapHash }));
        setStage('swapping');
        await publicClient.waitForTransactionReceipt({ hash: swapHash });

        // 5. Withdraw filled USDso from pool vault.
        const vaultBal = (await publicClient.readContract({
          address: SOMI_POOL,
          abi: POOL_ABI,
          functionName: 'getWithdrawableBalance',
          args: [address, CONTRACT_ADDRESSES.USDso],
        })) as bigint;

        if (vaultBal > BigInt(0)) {
          setStage('awaiting-withdraw');
          const withdrawHash = await walletClient.writeContract({
            address: SOMI_POOL,
            abi: POOL_ABI,
            functionName: 'withdraw',
            args: [CONTRACT_ADDRESSES.USDso, vaultBal],
          });
          setResult((r) => ({ ...r, withdrawHash }));
          setStage('withdrawing');
          await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
        }

        const usdsoAfter = (await publicClient.readContract({
          address: CONTRACT_ADDRESSES.USDso,
          abi: [
            {
              name: 'balanceOf',
              type: 'function',
              stateMutability: 'view',
              inputs: [{ type: 'address' }],
              outputs: [{ type: 'uint256' }],
            },
          ] as const,
          functionName: 'balanceOf',
          args: [address],
        })) as bigint;

        setResult((r) => ({ ...r, usdsoGained: usdsoAfter - usdsoBefore }));
        setStage('done');
      } catch (e: unknown) {
        const msg =
          e instanceof Error
            ? (e as { shortMessage?: string }).shortMessage ?? e.message
            : String(e);
        setError(msg);
        setStage('error');
      }
    },
    [address, publicClient, walletClient],
  );

  return { stage, error, result, swap, reset, fmtUsdso: (v: bigint) => formatUnits(v, 18) };
}
