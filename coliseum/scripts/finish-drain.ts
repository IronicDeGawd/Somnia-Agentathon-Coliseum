import hre from "hardhat";
import { formatEther, parseEther } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const bookmaker = await hre.viem.getContractAt("Bookmaker", m.contracts.Bookmaker.address);
  const pub = await hre.viem.getPublicClient();
  const [w] = await hre.viem.getWalletClients();
  const buffer = parseEther("1");

  // Withdraw rake from bookmaker (owner-only)
  console.log("Bookmaker.withdrawRake(1)...");
  try {
    const tx = await bookmaker.write.withdrawRake([1n, w.account.address]);
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log("  rake withdrawn");
  } catch (e: any) { console.log("  skip:", e?.shortMessage ?? e); }

  // Drain STT off both
  const arenaStt = await pub.getBalance({ address: arena.address });
  if (arenaStt > buffer) {
    const amt = arenaStt - buffer;
    const tx = await arena.write.withdrawNative([w.account.address, amt]);
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log("Arena.withdrawNative:", formatEther(amt), "STT");
  }
  const bookStt = await pub.getBalance({ address: bookmaker.address });
  if (bookStt > buffer) {
    const amt = bookStt - buffer;
    const tx = await bookmaker.write.withdrawNative([w.account.address, amt]);
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log("Bookmaker.withdrawNative:", formatEther(amt), "STT");
  }
}
main().catch(e => console.error(e?.shortMessage ?? e));
