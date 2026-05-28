import hre from "hardhat";
import { parseEther, formatEther } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const pub = await hre.viem.getPublicClient();
  const [w] = await hre.viem.getWalletClients();

  const bal = await pub.getBalance({ address: m.contracts.Bookmaker.address });
  console.log(`Bookmaker STT before: ${formatEther(bal)}`);

  const topup = parseEther("5"); // give it 5 STT buffer for ~20 LLM requests
  console.log(`Sending ${formatEther(topup)} STT...`);
  const tx = await w.sendTransaction({ to: m.contracts.Bookmaker.address, value: topup });
  await pub.waitForTransactionReceipt({ hash: tx });

  const balAfter = await pub.getBalance({ address: m.contracts.Bookmaker.address });
  console.log(`Bookmaker STT after: ${formatEther(balAfter)}`);
}
main().catch(e => console.error(e?.shortMessage ?? e));
