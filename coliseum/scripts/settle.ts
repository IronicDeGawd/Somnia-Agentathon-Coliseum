import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const bookmaker = await hre.viem.getContractAt("Bookmaker", m.contracts.Bookmaker.address);
  const pub = await hre.viem.getPublicClient();
  const [w] = await hre.viem.getWalletClients();
  const usdso = m.external.usdso;

  const duelId = BigInt(process.env.DUEL_ID ?? "1");
  const usdsoAbi = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;

  const before = await pub.readContract({ address: usdso, abi: usdsoAbi, functionName: "balanceOf", args: [w.account.address] }) as bigint;
  console.log(`USDso before settle: ${formatUnits(before, 18)}`);

  console.log(`settleBets(${duelId})...`);
  const tx = await bookmaker.write.settleBets([duelId]);
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("tx:", tx, "status:", r.status, "logs:", r.logs.length);

  const after = await pub.readContract({ address: usdso, abi: usdsoAbi, functionName: "balanceOf", args: [w.account.address] }) as bigint;
  console.log(`USDso after settle:  ${formatUnits(after, 18)}`);
  console.log(`Gained from bet:     ${formatUnits(after - before, 18)} USDso`);

  const rake = await bookmaker.read.rakeAccrued([duelId]);
  console.log(`Rake accrued:        ${formatUnits(rake as bigint, 18)} USDso`);
}
main().catch(e => console.error(e?.shortMessage ?? e));
