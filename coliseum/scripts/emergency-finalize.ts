import hre from "hardhat";
import fs from "fs"; import path from "path";
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const pub = await hre.viem.getPublicClient();
  const duelId = await arena.read.activeDuelId() as bigint;
  if (duelId === 0n) { console.log("No active duel"); return; }
  console.log(`emergencyFinalize(${duelId})...`);
  const tx = await arena.write.emergencyFinalize([duelId]);
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("tx:", tx, "status:", r.status, "logs:", r.logs.length);
  const finalDuel = await arena.read.duels([duelId]) as readonly unknown[];
  console.log("  status:", finalDuel[8], "(3=Resolved)");
  console.log("  winnerSlot:", finalDuel[11]);
}
main().catch(e => console.error(e?.shortMessage ?? e));
