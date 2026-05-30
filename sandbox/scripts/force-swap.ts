/**
 * Gated STT→USDso swap on the SOMI/USDso pool.
 *
 * Hardened flow (never blind-broadcasts):
 *   1. Read best bid from the REST orderbook (api.dreamdex.io) for a price reference.
 *   2. Set sell floor a few ticks BELOW best bid (crosses; fills at best bid via
 *      price-time priority). Correct price for a SELL is at-or-below the bid.
 *   3. eth_call simulate placeTakerOrderWithoutVault with the exact broadcast args.
 *      - (false, 0)  → on-chain pool can't match (no resting on-chain bids, even if
 *                      REST advertises liquidity). ABORT — saves gas.
 *      - (true, id)  → broadcast for real.
 *   4. Withdraw filled USDso from the pool vault back to the wallet.
 *
 * Why the gate matters: the testnet on-chain book is intermittent. REST may show
 * bids while the on-chain matchable book is empty. A blind taker order then
 * succeeds mechanically (status=1) but fills nothing and wastes ~300k gas. The
 * simulate gate detects that for free.
 *
 * Env: SELL_AMOUNT (STT to sell, default 200).
 * Run: pnpm exec hardhat run scripts/force-swap.ts --network somnia
 */
import hre from "hardhat";
import { parseEther, formatUnits } from "viem";

const SOMI_POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as const;
const USDSO     = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171" as const;
const ZERO      = "0x0000000000000000000000000000000000000000" as const;
const TICK      = parseEther("0.0001"); // pool tickSize
const REST_URL  = "https://api.dreamdex.io/v0/orderbooks?symbols=SOMI:USDso";

const POOL_ABI = [
  {
    name: "placeTakerOrderWithoutVault",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "isBid",              type: "bool"    },
      { name: "userData",           type: "uint64"  },
      { name: "price",              type: "uint256" },
      { name: "quantity",           type: "uint256" },
      { name: "expireTimestampNs",  type: "uint64"  },
      { name: "orderType",          type: "uint8"   },
      { name: "selfMatchingOption", type: "uint8"   },
      { name: "builder",            type: "address" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
    ],
    outputs: [
      { name: "success",  type: "bool"    },
      { name: "orderId",  type: "uint128" },
    ],
  },
  {
    name: "getWithdrawableBalance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "u", type: "address" }, { name: "t", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

const ERC20_ABI = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
}] as const;

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const me = wallet.account.address;

  const sellAmount = parseEther(process.env.SELL_AMOUNT ?? "200");

  // ── 1. Read best bid from REST ────────────────────────────────────────────
  let bestBid: bigint;
  try {
    const res = await fetch(REST_URL);
    const data = await res.json();
    const bids = data?.orderbooks?.[0]?.bids ?? [];
    console.log(`REST bids: ${bids.slice(0, 3).map((b: any) => `${b.price}×${b.quantity}`).join(", ") || "(none)"}`);
    if (bids.length === 0) { console.log("No REST bids — nothing to sell into. Abort."); return; }
    bestBid = parseEther(String(bids[0].price));
  } catch (e: any) {
    console.log("REST orderbook fetch failed:", e?.message || e, "— abort.");
    return;
  }

  // ── 2. Sell floor = best bid − 10 ticks, tick-aligned ─────────────────────
  const floor = ((bestBid - 10n * TICK) / TICK) * TICK;
  console.log(`Best bid ${formatUnits(bestBid, 18)} → sell floor ${formatUnits(floor, 18)} (priceRaw=${floor})`);
  console.log(`Selling ${formatUnits(sellAmount, 18)} STT...`);

  const expireNs = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;
  const args = [false, 0n, floor, sellAmount, expireNs, 2, 0, ZERO, 0n] as const;

  // ── 3. Simulate gate ──────────────────────────────────────────────────────
  console.log("Simulating (eth_call)...");
  try {
    const sim = await pub.simulateContract({
      account: wallet.account, address: SOMI_POOL, abi: POOL_ABI,
      functionName: "placeTakerOrderWithoutVault", value: sellAmount, args,
    });
    const [ok, orderId] = sim.result as [boolean, bigint];
    console.log(`  simulate → success=${ok}, orderId=${orderId}`);
    if (!ok) { console.log("  (false,0) → on-chain pool has no matchable bid. NOT broadcasting."); return; }
  } catch (e: any) {
    console.log("  simulate reverted:", e?.shortMessage || String(e).slice(0, 160), "— abort.");
    return;
  }

  // ── 4. Broadcast + withdraw ───────────────────────────────────────────────
  const usdsoBefore = await pub.readContract({ address: USDSO, abi: ERC20_ABI, functionName: "balanceOf", args: [me] }) as bigint;
  console.log("  ✅ simulate passed — broadcasting...");
  const hash = await wallet.writeContract({
    address: SOMI_POOL, abi: POOL_ABI, functionName: "placeTakerOrderWithoutVault",
    value: sellAmount, args,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`TX: ${hash}\nBlock: ${r.blockNumber}, status: ${r.status}, logs: ${r.logs.length}`);

  const vaultBal = await pub.readContract({
    address: SOMI_POOL, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [me, USDSO],
  }) as bigint;
  if (vaultBal > 0n) {
    console.log(`Withdrawing ${formatUnits(vaultBal, 18)} USDso from vault...`);
    const wHash = await wallet.writeContract({
      address: SOMI_POOL, abi: POOL_ABI, functionName: "withdraw", args: [USDSO, vaultBal],
    });
    await pub.waitForTransactionReceipt({ hash: wHash });
  }

  const usdsoAfter = await pub.readContract({ address: USDSO, abi: ERC20_ABI, functionName: "balanceOf", args: [me] }) as bigint;
  console.log(`\nUSDso: ${formatUnits(usdsoBefore, 18)} → ${formatUnits(usdsoAfter, 18)}  (gained ${formatUnits(usdsoAfter - usdsoBefore, 18)})`);
}

main().catch((e) => { console.error("FAILED:", e?.shortMessage || e); process.exitCode = 1; });
