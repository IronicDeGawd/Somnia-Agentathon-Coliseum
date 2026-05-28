import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"
  ));
  const arena = await hre.viem.getContractAt("Arena", manifest.contracts.Arena.address);
  const pub = await hre.viem.getPublicClient();
  console.log("Calling turn()...");
  const tx = await arena.write.turn();
  console.log("tx:", tx);
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log(`block ${r.blockNumber}, status ${r.status}, logs ${r.logs.length}`);
}
main().catch(e => console.error(e?.shortMessage ?? e));
