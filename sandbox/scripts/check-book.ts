import { createPublicClient, http } from "viem";

const POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as const;
const RPC = "https://api.infra.testnet.somnia.network";

const ABI = [{
  name: "getBookLevels",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "isBid", type: "bool" }, { name: "depth", type: "uint256" }],
  outputs: [{
    name: "", type: "tuple[]",
    components: [
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
    ],
  }],
}] as const;

const client = createPublicClient({ transport: http(RPC) });

(async () => {
  const bids = await client.readContract({
    address: POOL, abi: ABI, functionName: "getBookLevels", args: [true, 5n],
  });
  const asks = await client.readContract({
    address: POOL, abi: ABI, functionName: "getBookLevels", args: [false, 5n],
  });
  console.log("BIDS (top 5):");
  for (const b of bids as any[]) {
    console.log(`  price: ${b.price.toString()} (${Number(b.price)/1e18} USDso)  qty: ${b.quantity.toString()} (${Number(b.quantity)/1e18} SOMI)`);
  }
  console.log("\nASKS (top 5):");
  for (const a of asks as any[]) {
    console.log(`  price: ${a.price.toString()} (${Number(a.price)/1e18} USDso)  qty: ${a.quantity.toString()} (${Number(a.quantity)/1e18} SOMI)`);
  }
})();
