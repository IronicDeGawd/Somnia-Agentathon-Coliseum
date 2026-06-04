/**
 * Sell STT into the SOMI/USDso native pool to acquire USDso, with a DYNAMIC
 * floor (best bid - 10 ticks) so it fills regardless of current price.
 * SELL_AMOUNT (STT) env, default 350. Simulates before broadcasting.
 * Run: SELL_AMOUNT=350 pnpm exec hardhat run scripts/get-usdso.ts --network somnia
 */
import hre from "hardhat";
import { parseEther, formatUnits } from "viem";

const SOMI_POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as const;
const USDSO = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171" as const;
const TICK = parseEther("0.0001"); // SOMI/USDso tickSize

const POOL_ABI = [
  { name: "placeTakerOrderWithoutVault", type: "function", stateMutability: "payable",
    inputs: [
      { name: "isBid", type: "bool" }, { name: "userData", type: "uint64" }, { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" }, { name: "expireTimestampNs", type: "uint64" }, { name: "orderType", type: "uint8" },
      { name: "selfMatchingOption", type: "uint8" }, { name: "builder", type: "address" }, { name: "builderFeeBpsTimes1k", type: "uint96" },
    ], outputs: [{ name: "success", type: "bool" }, { name: "orderId", type: "uint128" }] },
  { name: "getBookLevels", type: "function", stateMutability: "view",
    inputs: [{ name: "isBid", type: "bool" }, { name: "numLevels", type: "uint64" }],
    outputs: [{ type: "tuple[]", components: [{ name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }] }] },
  { name: "getWithdrawableBalance", type: "function", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;
const ERC20 = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const me = wallet.account.address;
  const sellAmount = parseEther(process.env.SELL_AMOUNT ?? "350");

  const bids = await pub.readContract({ address: SOMI_POOL, abi: POOL_ABI, functionName: "getBookLevels", args: [true, BigInt(1)] }) as readonly { price: bigint; quantity: bigint }[];
  if (!bids.length || bids[0].price === BigInt(0)) { console.log("No bids — MM blackout. Abort."); return; }
  const bestBid = bids[0].price;
  const floor = ((bestBid - BigInt(10) * TICK) / TICK) * TICK; // align down to tick
  const expireNs = BigInt(Math.floor(Date.now() / 1000) + 3600) * BigInt(1_000_000_000);

  const usdsoBefore = await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [me] }) as bigint;
  console.log(`Selling ${formatUnits(sellAmount, 18)} STT · bestBid ${formatUnits(bestBid, 18)} · floor ${formatUnits(floor, 18)}`);
  console.log(`USDso before: ${formatUnits(usdsoBefore, 18)}`);

  const sim = await pub.simulateContract({
    account: wallet.account, address: SOMI_POOL, abi: POOL_ABI, functionName: "placeTakerOrderWithoutVault",
    value: sellAmount, args: [false, BigInt(0), floor, sellAmount, expireNs, 2, 0, "0x0000000000000000000000000000000000000000", BigInt(0)],
  });
  const [ok] = sim.result as [boolean, bigint];
  if (!ok) { console.log("simulate success=false — would reject. Abort."); return; }

  const hash = await wallet.writeContract({
    address: SOMI_POOL, abi: POOL_ABI, functionName: "placeTakerOrderWithoutVault",
    value: sellAmount, args: [false, BigInt(0), floor, sellAmount, expireNs, 2, 0, "0x0000000000000000000000000000000000000000", BigInt(0)],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log("swap tx:", hash);

  const vault = await pub.readContract({ address: SOMI_POOL, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [me, USDSO] }) as bigint;
  if (vault > BigInt(0)) {
    const w = await wallet.writeContract({ address: SOMI_POOL, abi: POOL_ABI, functionName: "withdraw", args: [USDSO, vault] });
    await pub.waitForTransactionReceipt({ hash: w });
    console.log("withdrew from vault:", formatUnits(vault, 18), "USDso");
  }
  const usdsoAfter = await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [me] }) as bigint;
  console.log(`USDso after: ${formatUnits(usdsoAfter, 18)} (+${formatUnits(usdsoAfter - usdsoBefore, 18)})`);
}
main().catch((e) => { console.error("get-usdso failed:", e); process.exitCode = 1; });
