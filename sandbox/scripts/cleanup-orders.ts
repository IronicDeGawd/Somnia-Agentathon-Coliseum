/**
 * Cancel any leftover resting orders on the WETH/USDso pool.
 * One-shot cleanup for state left behind by earlier test runs.
 */
import hre from "hardhat";
import "dotenv/config";

const POOL = "0xD180195da5459C7a0DEA188ed61216ec43682b50" as const;

const ABI = [
  {
    name: "getOwnOpenOrders",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128[]" }],
  },
  {
    name: "cancelOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint128" }],
    outputs: [],
  },
] as const;

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();

  const orderIds = await pub.readContract({
    address: POOL, abi: ABI, functionName: "getOwnOpenOrders",
  }) as bigint[];

  console.log("Open orders:", orderIds.length);
  for (const id of orderIds) {
    console.log("  Cancelling", id.toString(), "...");
    const tx = await wallet.writeContract({
      address: POOL, abi: ABI, functionName: "cancelOrder", args: [id],
    });
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log("    ✅", tx);
  }
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
