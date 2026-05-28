import hre from "hardhat";
import { formatUnits } from "viem";

const SOMI_POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as const;

const ABI = [
  {
    name: "getPoolParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "baseToken",  type: "address" },
      { name: "quoteToken", type: "address" },
      { name: "makerFee",   type: "uint256" },
      { name: "takerFee",   type: "uint256" },
      { name: "tickSize",   type: "uint256" },
      { name: "minQuantity",type: "uint256" },
      { name: "lotSize",    type: "uint256" },
    ],
  },
] as const;

async function main() {
  const pub = await hre.viem.getPublicClient();
  const p = await pub.readContract({
    address: SOMI_POOL, abi: ABI, functionName: "getPoolParams",
  }) as readonly [string, string, bigint, bigint, bigint, bigint, bigint];
  console.log("base:", p[0]);
  console.log("quote:", p[1]);
  console.log("makerFee:", p[2].toString());
  console.log("takerFee:", p[3].toString());
  console.log("tickSize:", formatUnits(p[4], 18), "USDso/SOMI");
  console.log("minQuantity:", formatUnits(p[5], 18), "SOMI =", p[5].toString(), "wei");
  console.log("lotSize:", formatUnits(p[6], 18), "SOMI =", p[6].toString(), "wei");
}
main().catch(console.error);
