import hre from "hardhat";
import fs from "fs"; import path from "path";
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const pub = await hre.viem.getPublicClient();
  const duelId = await arena.read.activeDuelId() as bigint;
  console.log("Finalizing duel", duelId);
  const tx = await arena.write.finalizeDuel([duelId]);
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("tx:", tx, "status:", r.status, "logs:", r.logs.length);
  for (const log of r.logs) {
    if (log.topics.length === 3) {
      const winnerIdHex = log.topics[2]!;
      console.log("  topic[2] (winner fighter id):", parseInt(winnerIdHex, 16));
    }
  }
  const finalDuel = await arena.read.duels([duelId]) as readonly unknown[];
  console.log("  winnerSlot:", finalDuel[11]);
  console.log("  status:", finalDuel[8], "(3=Resolved)");
}
main().catch(e => console.error(e?.shortMessage ?? e));
