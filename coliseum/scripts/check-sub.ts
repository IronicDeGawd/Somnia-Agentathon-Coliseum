import hre from "hardhat";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const bookmaker = await hre.viem.getContractAt("Bookmaker", m.contracts.Bookmaker.address);
  const pub = await hre.viem.getPublicClient();
  const subArena = await arena.read.subscriptionId() as bigint;
  const subBook = await bookmaker.read.subscriptionId() as bigint;
  console.log("Arena subscriptionId:    ", subArena);
  console.log("Bookmaker subscriptionId:", subBook);
  console.log();

  const PRECOMPILE = "0x0000000000000000000000000000000000000100" as const;
  const ABI = [{
    name: "getSubscriptionInfo", type: "function", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "subscriptionData", type: "tuple", components: [
        { name: "eventTopics",             type: "bytes32[4]" },
        { name: "origin",                  type: "address" },
        { name: "caller",                  type: "address" },
        { name: "emitter",                 type: "address" },
        { name: "handlerContractAddress",  type: "address" },
        { name: "handlerFunctionSelector", type: "bytes4" },
        { name: "priorityFeePerGas",       type: "uint64" },
        { name: "maxFeePerGas",            type: "uint64" },
        { name: "gasLimit",                type: "uint64" },
        { name: "isGuaranteed",            type: "bool" },
        { name: "isCoalesced",             type: "bool" },
      ]},
      { name: "owner", type: "address" },
    ],
  }] as const;

  for (const [name, id] of [["Arena", subArena], ["Bookmaker", subBook]] as const) {
    try {
      const res = await pub.readContract({
        address: PRECOMPILE, abi: ABI, functionName: "getSubscriptionInfo", args: [id],
      });
      console.log(`--- ${name} sub ${id} ---`);
      console.log(JSON.stringify(res, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
    } catch (e: any) {
      console.log(`--- ${name} sub ${id}: ERROR ---`);
      console.log(`  ${e.shortMessage || e.message}`);
      console.log("  (If 'revert' or 'subscription not found': the subscription was auto-removed.)");
    }
    console.log();
  }

  // Also check balances
  const arenaBal = await pub.getBalance({ address: arena.address });
  const bookBal = await pub.getBalance({ address: bookmaker.address });
  console.log(`Arena STT:    ${Number(arenaBal) / 1e18}`);
  console.log(`Bookmaker STT: ${Number(bookBal) / 1e18}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
