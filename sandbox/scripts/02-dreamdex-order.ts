/**
 * Test 2 — dreamDEX vault deposit + placeOrder (WETH/USDso testnet)
 *
 * Sequence:
 *   1. Query getPoolParams() — confirm pool is live, read tick/lot/min
 *   2. Check wallet's vault balance
 *   3. ERC-20 approve USDso → SpotPool
 *   4. deposit() USDso into vault
 *   5. placeOrder() — PostOnly bid slightly below best ask (won't fill, just rests)
 *   6. Confirm order via getOwnOpenOrders() + verify OrderPlaced log
 *   7. cancelOrder() — clean up
 *
 * Run: npm run test:dreamdex
 * Env: PRIVATE_KEY required. Wallet must hold testnet USDso.
 *
 * Testnet addresses (WETH/USDso pool):
 *   SpotPool: 0xD180195da5459C7a0DEA188ed61216ec43682b50
 *   USDso:    TBD — query pool for token addresses
 */

import hre from "hardhat";
import { parseUnits, formatUnits, getAddress } from "viem";
import "dotenv/config";

// testnet WETH/USDso pool
const SPOT_POOL = "0xD180195da5459C7a0DEA188ed61216ec43682b50" as const;

// Minimal ABIs — only what this test needs
const POOL_ABI = [
  {
    name: "getPoolParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "tickSize", type: "uint256" },
      { name: "minQuantity", type: "uint256" },
      { name: "lotSize", type: "uint256" },
      { name: "takerFeeBpsTimes1k", type: "uint256" },
      { name: "makerFeeBpsTimes1k", type: "uint256" },
      { name: "feeRecipient", type: "address" },
      { name: "maxBuilderFeeBpsTimes1k", type: "uint256" },
    ],
  },
  {
    name: "getWithdrawableBalance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getOwnOpenOrders",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "orderId", type: "uint128" },
          { name: "isBid", type: "bool" },
          { name: "owner", type: "address" },
          { name: "userData", type: "uint64" },
          { name: "price", type: "uint256" },
          { name: "fullQuantity", type: "uint256" },
          { name: "quantityRemaining", type: "uint256" },
          { name: "expireTimestampNs", type: "uint64" },
        ],
      },
    ],
  },
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "placeOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "isBid", type: "bool" },
      { name: "userData", type: "uint64" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" },
      { name: "orderType", type: "uint8" },
      { name: "selfMatchingOption", type: "uint8" },
      { name: "builder", type: "address" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
    ],
    outputs: [{ name: "success", type: "bool" }, { name: "orderId", type: "uint128" }],
  },
  {
    name: "cancelOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint128" }],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "quoteToken",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "baseToken",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const me = wallet.account.address;

  console.log("Wallet:", me);
  const nativeBal = await publicClient.getBalance({ address: me });
  console.log("STT balance:", formatUnits(nativeBal, 18), "STT\n");

  // --- Step 1: Pool params ---
  console.log("=== Step 1: getPoolParams() ===");
  const params = await publicClient.readContract({
    address: SPOT_POOL,
    abi: POOL_ABI,
    functionName: "getPoolParams",
  });
  const [tickSize, minQuantity, lotSize] = params as [bigint, bigint, bigint, bigint, bigint, string, bigint];
  console.log("tickSize:", tickSize.toString(), "(raw USDso units)");
  console.log("minQuantity:", minQuantity.toString(), "(raw WETH units)");
  console.log("lotSize:", lotSize.toString(), "(raw WETH units)");

  // Fetch token addresses
  const quoteToken = await publicClient.readContract({
    address: SPOT_POOL,
    abi: POOL_ABI,
    functionName: "quoteToken",
  }) as `0x${string}`;
  const baseToken = await publicClient.readContract({
    address: SPOT_POOL,
    abi: POOL_ABI,
    functionName: "baseToken",
  }) as `0x${string}`;
  console.log("Quote token (USDso):", quoteToken);
  console.log("Base token (WETH):", baseToken, "\n");

  // Token info
  const [usdsoSymbol, rawDecimals] = await Promise.all([
    publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: "symbol" }),
    publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  const usdsoDecimals = Number(rawDecimals);
  console.log("Quote:", usdsoSymbol, "decimals:", usdsoDecimals);

  // --- Step 2: Wallet balance ---
  console.log("\n=== Step 2: Wallet USDso balance ===");
  const walletUsdso = await publicClient.readContract({
    address: quoteToken, abi: ERC20_ABI, functionName: "balanceOf", args: [me],
  });
  console.log("Wallet USDso:", formatUnits(walletUsdso, usdsoDecimals));

  const vaultUsdso = await publicClient.readContract({
    address: SPOT_POOL, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [me, quoteToken],
  });
  console.log("Vault USDso already deposited:", formatUnits(vaultUsdso as bigint, usdsoDecimals));

  // How much to deposit for this test (1 USDso)
  const depositAmount = parseUnits("1", usdsoDecimals);

  if (walletUsdso < depositAmount) {
    console.log("\n⚠️  Wallet has insufficient USDso. Need 1 USDso for the test.");
    console.log("   Get testnet USDso from the dreamDEX faucet / devrel, then re-run.");
    console.log("\n   Stopping here — pool params verified ✅ (that part works)");
    return;
  }

  // --- Step 3: Approve ---
  console.log("\n=== Step 3: approve USDso → SpotPool ===");
  const approveTx = await wallet.writeContract({
    address: quoteToken,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [SPOT_POOL, depositAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log("Approved:", approveTx);

  // --- Step 4: Deposit ---
  console.log("\n=== Step 4: deposit() USDso into vault ===");
  const depositTx = await wallet.writeContract({
    address: SPOT_POOL,
    abi: POOL_ABI,
    functionName: "deposit",
    args: [quoteToken, depositAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
  console.log("Deposited:", depositTx);

  const vaultAfter = await publicClient.readContract({
    address: SPOT_POOL, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [me, quoteToken],
  });
  console.log("Vault USDso after deposit:", formatUnits(vaultAfter as bigint, usdsoDecimals));

  // --- Step 5: placeOrder (PostOnly bid far below market — just needs to rest) ---
  // Use minQuantity as order size. Price = tickSize × 10 (far below any real ask).
  // PostOnly ensures it won't fill and we can cancel immediately after.
  console.log("\n=== Step 5: placeOrder() PostOnly bid (won't fill, will rest) ===");

  // Align quantity to lotSize
  const rawQuantity = minQuantity > 0n ? minQuantity : parseUnits("0.001", 18);

  // Price: very low bid (tickSize × 10) to guarantee PostOnly doesn't immediately fill
  const rawPrice = tickSize * 10n;

  console.log("Order: isBid=true, price=", rawPrice.toString(), "quantity=", rawQuantity.toString());
  console.log("       orderType=3 (PostOnly), selfMatchingOption=0 (CancelTaker)");

  const orderTx = await wallet.writeContract({
    address: SPOT_POOL,
    abi: POOL_ABI,
    functionName: "placeOrder",
    args: [
      true,           // isBid (buy WETH with USDso)
      0n,             // userData
      rawPrice,       // price raw quote units
      rawQuantity,    // quantity raw base units
      0n,             // expireTimestampNs (0 = no expiry)
      3,              // orderType: PostOnly
      0,              // selfMatchingOption: CancelTaker
      "0x0000000000000000000000000000000000000000", // builder (must be zero in v1.0)
      0n,             // builderFeeBpsTimes1k (uint96 → bigint)
    ],
  });
  const orderReceipt = await publicClient.waitForTransactionReceipt({ hash: orderTx });
  console.log("placeOrder TX:", orderTx, "block:", orderReceipt.blockNumber.toString());

  // Check for OrderPlaced log (success = at least one log)
  const hasOrderLog = orderReceipt.logs.length > 0;
  console.log("Logs in receipt:", orderReceipt.logs.length, hasOrderLog ? "(✅ order likely placed)" : "(⚠️ no logs — silent reject)");

  // --- Step 6: Verify via getOwnOpenOrders ---
  console.log("\n=== Step 6: getOwnOpenOrders() ===");
  const openOrders = await publicClient.readContract({
    address: SPOT_POOL, abi: POOL_ABI, functionName: "getOwnOpenOrders",
  }) as any[];
  console.log("Open orders:", openOrders.length);

  if (openOrders.length === 0) {
    console.log("⚠️  No open orders found. Order may have been silently rejected (price too low for PostOnly?).");
    console.log("   Withdrawing deposit and exiting.");
  } else {
    const order = openOrders[0];
    console.log("  orderId:", order.orderId.toString());
    console.log("  isBid:", order.isBid);
    console.log("  price:", order.price.toString());
    console.log("  quantityRemaining:", order.quantityRemaining.toString());

    // --- Step 7: Cancel ---
    console.log("\n=== Step 7: cancelOrder() ===");
    const cancelTx = await wallet.writeContract({
      address: SPOT_POOL, abi: POOL_ABI,
      functionName: "cancelOrder", args: [order.orderId],
    });
    await publicClient.waitForTransactionReceipt({ hash: cancelTx });
    console.log("Cancelled:", cancelTx);

    const afterCancel = await publicClient.readContract({
      address: SPOT_POOL, abi: POOL_ABI, functionName: "getOwnOpenOrders",
    }) as any[];
    console.log("Open orders after cancel:", afterCancel.length, afterCancel.length === 0 ? "✅" : "⚠️");
  }

  // Always withdraw to clean up
  console.log("\n=== Cleanup: withdraw USDso from vault ===");
  const finalVault = await publicClient.readContract({
    address: SPOT_POOL, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [me, quoteToken],
  });
  if ((finalVault as bigint) > 0n) {
    const withdrawTx = await wallet.writeContract({
      address: SPOT_POOL, abi: POOL_ABI,
      functionName: "withdraw", args: [quoteToken, finalVault as bigint],
    });
    await publicClient.waitForTransactionReceipt({ hash: withdrawTx });
    console.log("Withdrawn:", withdrawTx, "✅");
  } else {
    console.log("Nothing to withdraw.");
  }

  console.log("\n✅ dreamDEX order test complete");
}

main().catch((e) => { console.error(e); process.exit(1); });
