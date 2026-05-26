import hre from "hardhat";
import { parseEther, formatEther } from "viem";
import fs from "fs";
import path from "path";

async function main() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join("deployments", "somnia.json"), "utf-8"
  ));
  const arena = manifest.contracts.Arena.address as `0x${string}`;

  const [wallet] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();

  const before = await pub.getBalance({ address: arena });
  console.log(`Arena balance before: ${formatEther(before)} STT`);

  const amount = parseEther(process.env.TOPUP_STT ?? "33");
  const tx = await wallet.sendTransaction({ to: arena, value: amount });
  await pub.waitForTransactionReceipt({ hash: tx });

  const after = await pub.getBalance({ address: arena });
  console.log(`tx: ${tx}`);
  console.log(`Arena balance after:  ${formatEther(after)} STT`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
