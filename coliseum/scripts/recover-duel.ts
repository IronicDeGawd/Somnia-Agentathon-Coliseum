import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const pub = await hre.viem.getPublicClient();
  const [w] = await hre.viem.getWalletClients();
  const usdsoAddr = m.external.usdso;

  const usdsoAbi = [{
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  }] as const;

  const before = await pub.readContract({
    address: usdsoAddr, abi: usdsoAbi, functionName: "balanceOf", args: [w.account.address],
  }) as bigint;
  console.log("USDso before:", formatUnits(before, 18));

  const duelId = parseInt(process.env.DUEL_ID ?? "1", 10);
  console.log(`recoverFunds(${duelId})...`);
  const tx = await arena.write.recoverFunds([BigInt(duelId)]);
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("tx:", tx, "status:", r.status, "logs:", r.logs.length);

  const after = await pub.readContract({
    address: usdsoAddr, abi: usdsoAbi, functionName: "balanceOf", args: [w.account.address],
  }) as bigint;
  console.log("USDso after:", formatUnits(after, 18));
  console.log("Recovered:", formatUnits(after - before, 18), "USDso");
}
main().catch(e => console.error(e?.shortMessage ?? e));
