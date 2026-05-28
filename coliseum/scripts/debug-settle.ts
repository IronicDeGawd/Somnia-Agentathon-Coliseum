import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const bookmaker = await hre.viem.getContractAt("Bookmaker", m.contracts.Bookmaker.address);
  const pub = await hre.viem.getPublicClient();
  const duelId = 1n;

  const [w] = await hre.viem.getWalletClients();
  try {
    const sim = await pub.simulateContract({
      account: w.account,
      address: bookmaker.address, abi: bookmaker.abi,
      functionName: "settleBets", args: [duelId],
    });
    console.log("simulate ok:", sim.result);
  } catch (e: any) {
    console.log("REVERT:", e.shortMessage, "\n");
    console.log("Cause:", e?.cause?.message || e?.cause);
    console.log("\nRaw:", e.message.slice(0, 500));
  }

  const usdsoAbi = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
  const bal = await pub.readContract({ address: m.external.usdso, abi: usdsoAbi, functionName: "balanceOf", args: [bookmaker.address] }) as bigint;
  console.log(`\nBookmaker USDso balance: ${formatUnits(bal, 18)}`);

  const settled = await bookmaker.read.duelSettled([duelId]);
  console.log("duelSettled:", settled);

  // Read first 5 bets if any
  for (let i = 0; i < 3; i++) {
    try {
      const bet = await bookmaker.read.bets([duelId, BigInt(i)]) as readonly unknown[];
      console.log(`bet[${i}]: stake=${formatUnits(bet[2] as bigint, 18)} fighter=${bet[1]} odds=${bet[3]}`);
    } catch { break; }
  }
}
main().catch(console.error);
