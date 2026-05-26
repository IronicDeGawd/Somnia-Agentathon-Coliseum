import hre from "hardhat";
import fs from "fs";

async function main() {
  const m = JSON.parse(fs.readFileSync("deployments/somnia.json", "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address as `0x${string}`);
  const activeDuelId = await arena.read.activeDuelId() as bigint;
  console.log("activeDuelId:", activeDuelId);
  if (activeDuelId === 0n) return;
  const duel = await arena.read.duels([activeDuelId]) as any[];
  console.log("status:", ["None","Pending","Active","Finalizing","Resolved"][duel[5]], "callbacks:", duel[4], "/30");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
