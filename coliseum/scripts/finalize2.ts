import hre from "hardhat";
import fs from "fs";
async function main() {
  const m = JSON.parse(fs.readFileSync("deployments/somnia.json", "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address as `0x${string}`);
  const pub = await hre.viem.getPublicClient();
  const tx = await arena.write.finalizeDuel([1n]);
  const receipt = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("tx:", tx, "status:", receipt.status);
  for (const log of receipt.logs) {
    console.log(" event topic0:", log.topics[0]?.slice(0, 12), "indexed:", log.topics.slice(1).map(t => t?.slice(0, 12)).join(","));
  }
  console.log("activeDuelId after:", await arena.read.activeDuelId());
}
main().catch(e => { console.error("finalize failed:", e.shortMessage || e.message); process.exitCode = 1; });
