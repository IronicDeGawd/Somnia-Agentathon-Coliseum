/**
 * Get testnet USDso by selling STT into the SOMI/USDso native pool.
 *
 * STT = SOMI on testnet (chain's native token).
 * Pool: SOMI/USDso (native) — 0x259fD6559214dd5aD3752322426eA9F9fABEFff4
 *
 * Mechanism:
 *   isBid = false  → selling SOMI (STT), receiving USDso
 *   orderType = 2  → IOC (required for wallet/native funding)
 *   msg.value      → the STT amount to sell (pulled from native balance)
 *   No ERC-20 approve needed — native token.
 *
 * Current price: ~0.17 USDso per SOMI. Selling 50 STT → ~8.5 USDso.
 *
 * Run: npx hardhat run scripts/00-get-usdso.ts --network somnia
 */

import hre from "hardhat";
import { parseEther, formatUnits } from "viem";
import "dotenv/config";

// SOMI/USDso native pool on testnet
const SOMI_POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as const;
const USDSO    = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171" as const;

const POOL_ABI = [
  {
    // Payable taker variant for native SOMI — pulls input from msg.value
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
    inputs: [
      { name: "user",  type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token",  type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "",        type: "uint256" }],
  },
] as const;

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const pub      = await hre.viem.getPublicClient();
  const me       = wallet.account.address;

  const sttBal   = await pub.getBalance({ address: me });
  const usdso0   = await pub.readContract({ address: USDSO, abi: ERC20_ABI, functionName: "balanceOf", args: [me] });

  console.log("Wallet:", me);
  console.log("STT balance:", formatUnits(sttBal, 18), "STT");
  console.log("USDso balance before:", formatUnits(usdso0, 18), "USDso\n");

  // --- Sell 50 STT → USDso via IOC ---
  // isBid=false = sell base (SOMI/STT), receive quote (USDso)
  // Best bid (via WS): ~0.1727 USDso/SOMI. Floor price 0.16 crosses safely.
  // IOC fills what it can at or above this price, cancels the rest.
  // quantity = msg.value = 50 STT in raw wei
  const sellAmount  = parseEther("50");       // 50 STT
  const limitPrice  = parseEther("0.15");     // floor — well below best bid
  const quantity    = sellAmount;             // same as msg.value for native pool
  // CRITICAL: testnet rejects expireTimestampNs=0 despite docs claiming "0 = no expiry"
  const expireNs    = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;

  console.log("Selling 50 STT → USDso via SOMI/USDso pool (IOC)...");
  console.log("  isBid=false, price floor=0.15, orderType=2 (IOC)");
  console.log("  expireNs:", expireNs.toString(), "(now + 1h)\n");

  // --- Simulate first via eth_call ---
  console.log("Simulating via eth_call...");
  const sim = await pub.simulateContract({
    account: wallet.account,
    address: SOMI_POOL,
    abi: POOL_ABI,
    functionName: "placeTakerOrderWithoutVault",
    value: sellAmount,
    args: [
      false, 0n, limitPrice, quantity, expireNs, 2, 0,
      "0x0000000000000000000000000000000000000000", 0n,
    ],
  });
  const [simSuccess, simOrderId] = sim.result as [boolean, bigint];
  console.log(`  simulate result: success=${simSuccess}, orderId=${simOrderId.toString()}`);
  if (!simSuccess) {
    console.log("⚠️  Simulation says success=false — would silently reject. Aborting broadcast.");
    return;
  }
  console.log("  ✅ Simulation passed, broadcasting...\n");

  const hash = await wallet.writeContract({
    address: SOMI_POOL,
    abi: POOL_ABI,
    functionName: "placeTakerOrderWithoutVault",
    value: sellAmount,
    args: [
      false,    // isBid — false = sell SOMI, receive USDso
      0n,       // userData
      limitPrice,
      quantity,
      expireNs, // testnet REQUIRES non-zero (docs claim 0=no-expiry but it rejects)
      2,        // orderType: IOC
      0,        // selfMatchingOption: CancelTaker
      "0x0000000000000000000000000000000000000000",
      0n,       // builderFeeBpsTimes1k
    ],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log("TX:", hash);
  console.log("Block:", receipt.blockNumber.toString());
  console.log("Logs:", receipt.logs.length, receipt.logs.length > 0 ? "(order placed ✅)" : "(no logs — possible silent reject ⚠️)");

  // Check if USDso landed in vault (IOC fills go to vault balance first)
  const vaultBal = await pub.readContract({
    address: SOMI_POOL, abi: POOL_ABI,
    functionName: "getWithdrawableBalance",
    args: [me, USDSO],
  }) as bigint;
  console.log("\nUSDso in vault:", formatUnits(vaultBal, 18));

  if (vaultBal > 0n) {
    console.log("Withdrawing USDso from vault to wallet...");
    const wHash = await wallet.writeContract({
      address: SOMI_POOL, abi: POOL_ABI,
      functionName: "withdraw",
      args: [USDSO, vaultBal],
    });
    await pub.waitForTransactionReceipt({ hash: wHash });
    console.log("Withdrawn:", wHash);
  }

  const usdsoFinal = await pub.readContract({
    address: USDSO, abi: ERC20_ABI,
    functionName: "balanceOf", args: [me],
  }) as bigint;
  const sttFinal = await pub.getBalance({ address: me });

  console.log("\n=== Result ===");
  console.log("USDso balance after:", formatUnits(usdsoFinal, 18), "USDso");
  console.log("STT balance after:", formatUnits(sttFinal, 18), "STT");

  if (usdsoFinal > 0n) {
    console.log("\n✅ Success — you have USDso. Run npm run test:dreamdex next.");
  } else {
    console.log("\n⚠️  USDso still 0. Possible reasons:");
    console.log("  - No resting bids in the SOMI/USDso orderbook (thin testnet book)");
    console.log("  - IOC found nothing to match and cancelled silently");
    console.log("  - In that case, ask devrel for a direct USDso airdrop");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
