import hre from "hardhat";

async function main() {
  const pub = await hre.viem.getPublicClient();
  const PRECOMPILE = "0x0000000000000000000000000000000000000100" as const;
  const ABI = [{
    name: "getSubscriptionInfo", type: "function", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "subscriptionData", type: "tuple", components: [
        { name: "eventTopics", type: "bytes32[4]" },
        { name: "origin", type: "address" },
        { name: "caller", type: "address" },
        { name: "emitter", type: "address" },
        { name: "handlerContractAddress", type: "address" },
        { name: "handlerFunctionSelector", type: "bytes4" },
        { name: "priorityFeePerGas", type: "uint64" },
        { name: "maxFeePerGas", type: "uint64" },
        { name: "gasLimit", type: "uint64" },
        { name: "isGuaranteed", type: "bool" },
        { name: "isCoalesced", type: "bool" },
      ]},
      { name: "owner", type: "address" },
    ],
  }] as const;

  for (const subId of [2216287n]) {
    try {
      const res = await pub.readContract({ address: PRECOMPILE, abi: ABI, functionName: "getSubscriptionInfo", args: [subId] });
      console.log(`sub ${subId}: ALIVE`);
      console.log(JSON.stringify(res, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
    } catch (e: any) {
      console.log(`sub ${subId}: DEAD — ${e.shortMessage || e.message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
