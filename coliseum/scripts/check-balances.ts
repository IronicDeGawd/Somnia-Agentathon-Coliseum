import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs"; import path from "path";
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const pub = await hre.viem.getPublicClient();
  const usdsoAbi = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
  const bal = await pub.readContract({ address: m.external.usdso, abi: usdsoAbi, functionName: "balanceOf", args: [arena.address] }) as bigint;
  const fees = await arena.read.accruedFees() as bigint;
  const seed = await arena.read.seedLiquidity() as bigint;
  console.log("Arena USDso balance:", formatUnits(bal, 18));
  console.log("seedLiquidity:", formatUnits(seed, 18));
  console.log("accruedFees:", formatUnits(fees, 18));
}
main().catch(console.error);
