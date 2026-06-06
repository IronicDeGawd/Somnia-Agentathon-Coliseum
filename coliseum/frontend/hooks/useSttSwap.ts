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
  {
    // Mirrors the on-chain ISpotPool ABI exactly. `numLevels` is uint64 — wrong
    // type silently mismatches the selector and the call reverts with no data.
    // Returns up to numLevels resting orders sorted price-time. Empty side = [].
    name: 'getBookLevels',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'isBid', type: 'bool' },
      { name: 'numLevels', type: 'uint64' },
    ],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'price', type: 'uint256' },
          { name: 'quantity', type: 'uint256' },
        ],
      },
    ],
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
  | 'fallback-awaiting-signature'
  | 'fallback-swapping'
  | 'done'
  | 'error';

export type SwapPath = 'market' | 'fallback' | null;

export interface SwapResult {
  swapHash?: `0x${string}`;
  withdrawHash?: `0x${string}`;
  fallbackHash?: `0x${string}`;
  usdsoGained?: bigint;
  path?: SwapPath;
}

const MAX_SIMULATE_ATTEMPTS = 3;
const SIMULATE_RETRY_MS = 2500;

const FALLBACK_ABI = [
  {
    name: 'fallbackSwap',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    name: 'usdsoReceivedBy',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'u', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'sttPerUsdso',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'minSttIn',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function useSttSwap() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [stage, setStage] = useState<SwapStage>('idle');
  const [attempt, setAttempt] = useState<{ n: number; max: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SwapResult>({});

  const reset = useCallback(() => {
    setStage('idle');
    setAttempt(null);
    setError(null);
    setResult({});
  }, []);

  const runFallbackPath = useCallback(
    async (sellAmount: bigint) => {
      if (!address || !publicClient || !walletClient) {
        throw new Error('Wallet not connected');
      }
      const fb = CONTRACT_ADDRESSES.SwapFallback;
      if (!fb || fb === '0x0000000000000000000000000000000000000000') {
        throw new Error('On-chain book has no buyers and the SwapFallback contract is not deployed. Ask the operator to fund the reserve.');
      }

      // Read claim cap + min input. Reject early if user has already claimed
      // their lifetime allowance.
      const [received, minIn] = await Promise.all([
        publicClient.readContract({ address: fb, abi: FALLBACK_ABI, functionName: 'usdsoReceivedBy', args: [address] }) as Promise<bigint>,
        publicClient.readContract({ address: fb, abi: FALLBACK_ABI, functionName: 'minSttIn' }) as Promise<bigint>,
      ]);
      if (received >= BigInt(1e18)) {
        throw new Error('You have already claimed the 1 USDso fallback once. This is a one-shot per address — wait for the real book to refill, or ask the operator to top up.');
      }
      if (sellAmount < minIn) {
        throw new Error(`Fallback path requires at least ${formatUnits(minIn, 18)} STT.`);
      }

      const usdsoBefore = (await publicClient.readContract({
        address: CONTRACT_ADDRESSES.USDso,
        abi: [
          { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
        ] as const,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint;

      setStage('fallback-awaiting-signature');
      const gasPrice = await publicClient.getGasPrice();
      const fallbackHash = await walletClient.writeContract({
        address: fb,
        abi: FALLBACK_ABI,
        functionName: 'fallbackSwap',
        value: sellAmount,
        gasPrice,
        gas: BigInt(100000),
      });
      setResult((r) => ({ ...r, fallbackHash, path: 'fallback' }));
      setStage('fallback-swapping');
      await publicClient.waitForTransactionReceipt({ hash: fallbackHash });

      const usdsoAfter = (await publicClient.readContract({
        address: CONTRACT_ADDRESSES.USDso,
        abi: [
          { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
        ] as const,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint;

      setResult((r) => ({ ...r, usdsoGained: usdsoAfter - usdsoBefore }));
      setStage('done');
    },
    [address, publicClient, walletClient],
  );

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
        // 1-3. Read best bid on-chain + simulate the taker, retrying up to
        // MAX_SIMULATE_ATTEMPTS times. Testnet on-chain book is intermittent;
        // each attempt re-reads the book and re-runs eth_call. Gas is never
        // spent until simulate returns (true, orderId). If all attempts fail,
        // we fall through to the SwapFallback contract.
        let args:
          | readonly [boolean, bigint, bigint, bigint, bigint, number, number, `0x${string}`, bigint]
          | null = null;
        for (let n = 1; n <= MAX_SIMULATE_ATTEMPTS; n++) {
          setAttempt({ n, max: MAX_SIMULATE_ATTEMPTS });

          setStage('reading-book');
          const bids = (await publicClient.readContract({
            address: SOMI_POOL,
            abi: POOL_ABI,
            functionName: 'getBookLevels',
            args: [true, BigInt(1)],
          })) as readonly { price: bigint; quantity: bigint }[];

          const bestBid = bids.length > 0 ? bids[0].price : BigInt(0);
          if (bestBid === BigInt(0)) {
            if (n < MAX_SIMULATE_ATTEMPTS) await sleep(SIMULATE_RETRY_MS);
            continue;
          }
          const floor = ((bestBid - BigInt(10) * TICK) / TICK) * TICK;
          const expireNs =
            BigInt(Math.floor(Date.now() / 1000) + 3600) * BigInt(1_000_000_000);
          const candidate = [false, BigInt(0), floor, sellAmount, expireNs, 2, 0, ZERO, BigInt(0)] as const;

          setStage('simulating');
          try {
            const sim = await publicClient.simulateContract({
              account: address,
              address: SOMI_POOL,
              abi: POOL_ABI,
              functionName: 'placeTakerOrderWithoutVault',
              value: sellAmount,
              args: candidate,
            });
            const [ok] = sim.result as [boolean, bigint];
            if (ok) {
              args = candidate;
              break;
            }
          } catch {
            // Simulate reverted; treated the same as (false, 0).
          }

          if (n < MAX_SIMULATE_ATTEMPTS) await sleep(SIMULATE_RETRY_MS);
        }
        setAttempt(null);

        if (!args) {
          // Market path exhausted — try the SwapFallback contract.
          await runFallbackPath(sellAmount);
          return;
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

        const gasPrice = await publicClient.getGasPrice();
        const swapHash = await walletClient.writeContract({
          address: SOMI_POOL,
          abi: POOL_ABI,
          functionName: 'placeTakerOrderWithoutVault',
          value: sellAmount,
          args,
          gasPrice,
          gas: BigInt(2000000),
        });
        setResult((r) => ({ ...r, swapHash, path: 'market' }));
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
            gasPrice,
            gas: BigInt(100000),
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
    [address, publicClient, walletClient, runFallbackPath],
  );

  return {
    stage,
    attempt,
    error,
    result,
    swap,
    reset,
    fmtUsdso: (v: bigint) => formatUnits(v, 18),
  };
}
