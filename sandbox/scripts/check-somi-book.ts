/**
 * Read the SOMI/USDso pool order book to find the actual best bid price.
 */
import hre from "hardhat";
import { formatUnits } from "viem";

const SOMI_POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as const;

const ABI = [
  {
    name: "getBookLevels",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "isBid", type: "bool" },
      { name: "depth", type: "uint64" },
    ],
    outputs: [{
      type: "tuple[]",
      components: [
        { name: "price",    type: "uint256" },
        { name: "quantity", type: "uint256" },
      ],
    }],
  },
] as const;

async function main() {
  const pub = await hre.viem.getPublicClient();

  console.log("\nSOMI/USDso pool:", SOMI_POOL);

  const bids = await pub.readContract({
    address: SOMI_POOL, abi: ABI, functionName: "getBookLevels", args: [true, 10n],
  }) as readonly { price: bigint; quantity: bigint }[];

  const asks = await pub.readContract({
    address: SOMI_POOL, abi: ABI, functionName: "getBookLevels", args: [false, 10n],
  }) as readonly { price: bigint; quantity: bigint }[];

  console.log("\n=== BIDS (people buying SOMI = where we sell to) ===");
  if (bids.length === 0) console.log("  (empty)");
  for (const b of bids) {
    console.log(`  ${formatUnits(b.price, 18)} USDso/SOMI × ${formatUnits(b.quantity, 18)} SOMI`);
  }

  console.log("\n=== ASKS (people selling SOMI) ===");
  if (asks.length === 0) console.log("  (empty)");
  for (const a of asks) {
    console.log(`  ${formatUnits(a.price, 18)} USDso/SOMI × ${formatUnits(a.quantity, 18)} SOMI`);
  }
}

main().catch(console.error);
