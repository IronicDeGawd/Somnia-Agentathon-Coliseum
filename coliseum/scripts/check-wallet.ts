import hre from "hardhat";
import { formatEther, formatUnits } from "viem";
import fs from "fs"; import path from "path";
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const pub = await hre.viem.getPublicClient();
  const [w] = await hre.viem.getWalletClients();
  const stt = await pub.getBalance({ address: w.account.address });
  const usdsoAbi = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
  const usdso = await pub.readContract({ address: m.external.usdso, abi: usdsoAbi, functionName: "balanceOf", args: [w.account.address] }) as bigint;
  console.log("Wallet:", w.account.address);
  console.log("STT:", formatEther(stt));
  console.log("USDso:", formatUnits(usdso, 18));
}
main().catch(console.error);
