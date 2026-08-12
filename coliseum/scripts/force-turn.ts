import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"
  ));
  const arena = await hre.viem.getContractAt("Arena", manifest.contracts.Arena.address);
  const pub = await hre.viem.getPublicClient();
  // DUEL_ID picks which running duel to advance; defaults to the first active one.
  const explicit = process.env.DUEL_ID;
  const ids = await arena.read.getActiveDuelIds() as bigint[];
  const duelId = explicit ? BigInt(explicit) : ids[0];
  if (duelId === undefined) { console.log("no active duel"); return; }
  console.log(`Calling turn(${duelId})... (active: ${ids.join(", ") || "none"})`);
  const tx = await arena.write.turn([duelId]);
  console.log("tx:", tx);
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log(`block ${r.blockNumber}, status ${r.status}, logs ${r.logs.length}`);
}
main().catch(e => console.error(e?.shortMessage ?? e));
