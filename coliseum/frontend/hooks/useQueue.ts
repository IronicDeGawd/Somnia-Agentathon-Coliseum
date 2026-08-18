'use client';

import { useState, useCallback } from 'react';
import { useAccount, useReadContract, useWriteContract, usePublicClient, useSwitchChain } from 'wagmi';
import { maxUint256 } from 'viem';
import { CONTRACT_ADDRESSES, ABIS, MarketKind } from '@/lib/contracts';
import { config, somniaTestnet } from '@/lib/chain';

/**
 * Join the waiting line for one round count on one market.
 *
 * The market is part of the line's identity: you only ever match someone who
 * chose the same one, because a spot fight and an events fight are priced
 * differently and could not share a pot.
 */
export function useQueue(
  fighter: number,
  turns: 3 | 6 | 9 | 15,
  market: MarketKind = MarketKind.Events,
) {
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
    args: [turns, market],
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
    // THE FLOOR HAS TO COVER THE MATCHING SIDE, not the cheap one.
    //
    // Queueing costs a few hundred thousand gas when the line is empty and MILLIONS
    // when it is not, because the second player's transaction starts the fight
    // inline. The estimate is taken when the button is clicked, so a player who
    // clicks while the line looks empty and is matched before their transaction
    // executes gets billed for the expensive path against an estimate for the cheap
    // one — and the floor is the only thing standing between them and running out of
    // gas.
    //
    // Measured 2026-08-19, start gas by market and tier:
    //   spot 3r 4,121,508 · practice 6r 4,167,733 · practice 9r 4,641,014
    //   events 3r 5,012,991 · events 9r 5,013,303 · events 6r 5,223,101
    //   spot 9r 5,112,026 · perps 3r 6,426,405 · perps 6r 6,423,842
    //   PERPS 9r 29,200,558
    //
    // The old floor was 5,000,000 and a six-round events start needed 5,223,101 — it
    // failed by 223,101, the player lost their gas, the deposit was never taken, and
    // the site showed a failed queue with nothing explaining it. Raising it to
    // 12,000,000 fixed every tier except the two perps tiers that select Ethereum,
    // where a start costs nearly thirty million and no browser attempt could ever
    // have succeeded.
    //
    // The figure is only charged if it is used, so a generous ceiling costs a player
    // nothing; being short costs them the whole transaction. Sized above the worst
    // measured start with room for a market set that moves.
    //
    // WORTH REVISITING: a perps start at the nine-round tier is four and a half times
    // any other, which is a large enough jump to be worth understanding rather than
    // budgeting around.
    const FLOOR = BigInt(40000000);
    const FALLBACK = BigInt(40000000);
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
          gas: BigInt(1500000),
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
          args: [fighter, turns, market],
          account: address,
        }),
      );

      const txHash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.Matchmaker,
        abi: ABIS.Matchmaker,
        functionName: 'queue',
        args: [fighter, turns, market],
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
  }, [address, chainId, fighter, turns, market, halfDeposit, publicClient, writeContractAsync, switchChainAsync, refetchAllowance]);

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
        args: [turns, market],
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
  }, [address, chainId, turns, market, publicClient, writeContractAsync, switchChainAsync, refetchHalfDeposit]);

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
