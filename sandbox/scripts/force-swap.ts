/**
 * Force-broadcast STT→USDso swap on SOMI/USDso native pool.
 * Skips simulation to actually test the on-chain behavior.
 */
import hre from "hardhat";
import { parseEther, formatUnits } from "viem";

const SOMI_POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as const;
const USDSO     = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171" as const;

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

  const sellAmount = parseEther(process.env.SELL_AMOUNT ?? "100");
  // Best bid ~0.1508. Limit at 0.15 should cross.
  const limitPrice = parseEther("0.15");
  const expireNs = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;

  console.log(`Selling ${formatUnits(sellAmount, 18)} STT, limit ${formatUnits(limitPrice, 18)} USDso/SOMI`);

  const usdsoBefore = await pub.readContract({
    address: USDSO, abi: ERC20_ABI, functionName: "balanceOf", args: [me],
  }) as bigint;
  console.log(`USDso before: ${formatUnits(usdsoBefore, 18)}`);

  console.log("Broadcasting (no simulate)...");
  const hash = await wallet.writeContract({
    address: SOMI_POOL,
    abi: POOL_ABI,
    functionName: "placeTakerOrderWithoutVault",
    value: sellAmount,
    args: [
      false,        // isBid: sell base
      0n,           // userData
      limitPrice,
      sellAmount,   // quantity in SOMI (1:1 with msg.value)
      expireNs,
      2,            // IOC
      0,            // CancelTaker if self-match
      "0x0000000000000000000000000000000000000000",
      0n,
    ],
  });
  console.log("TX:", hash);

  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`Block: ${r.blockNumber}, status: ${r.status}, logs: ${r.logs.length}`);

  // Check vault balance
  const vaultBal = await pub.readContract({
    address: SOMI_POOL, abi: POOL_ABI, functionName: "getWithdrawableBalance",
    args: [me, USDSO],
  }) as bigint;
  console.log(`Vault USDso: ${formatUnits(vaultBal, 18)}`);

  if (vaultBal > 0n) {
    console.log("Withdrawing to wallet...");
    const wHash = await wallet.writeContract({
      address: SOMI_POOL, abi: POOL_ABI, functionName: "withdraw",
      args: [USDSO, vaultBal],
    });
    await pub.waitForTransactionReceipt({ hash: wHash });
  }

  const usdsoAfter = await pub.readContract({
    address: USDSO, abi: ERC20_ABI, functionName: "balanceOf", args: [me],
  }) as bigint;
  console.log(`\nUSDso after: ${formatUnits(usdsoAfter, 18)}`);
  console.log(`Gained: ${formatUnits(usdsoAfter - usdsoBefore, 18)} USDso`);
}

main().catch((e) => { console.error("FAILED:", e?.shortMessage || e); process.exitCode = 1; });
