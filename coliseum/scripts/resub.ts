import hre from "hardhat";
import { parseEther } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", manifest.contracts.Arena.address);
  const pub = await hre.viem.getPublicClient();
  const [w] = await hre.viem.getWalletClients();

  const bal = await pub.getBalance({ address: arena.address });
  console.log("Arena STT:", Number(bal)/1e18);

  if (bal < parseEther("33")) {
    const need = parseEther("33") - bal + parseEther("2");
    console.log("Topping up", Number(need)/1e18, "STT...");
    const tx = await w.sendTransaction({ to: arena.address, value: need });
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  console.log("Calling resubscribe()...");
  const tx = await arena.write.resubscribe();
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("tx:", tx, "status:", r.status, "logs:", r.logs.length);
  console.log("new subscriptionId:", await arena.read.subscriptionId());
}
main().catch(e => console.error(e?.shortMessage ?? e));
