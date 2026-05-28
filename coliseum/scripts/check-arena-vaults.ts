import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arenaAddr = m.contracts.Arena.address;
  const usdso = m.external.usdso;
  const pools = [m.external.poolWeth, m.external.poolWbtc, m.external.poolSomi];
  const labels = ["WETH", "WBTC", "SOMI"];
  const pub = await hre.viem.getPublicClient();
  console.log("Arena:", arenaAddr);
  const poolAbi = [{
    name: "getWithdrawableBalance", type: "function", stateMutability: "view",
    inputs: [{ name: "u", type: "address" }, { name: "t", type: "address" }],
    outputs: [{ type: "uint256" }],
  }] as const;
  let total = 0n;
  for (let i = 0; i < 3; i++) {
    const bal = await pub.readContract({
      address: pools[i] as `0x${string}`, abi: poolAbi,
      functionName: "getWithdrawableBalance", args: [arenaAddr, usdso],
    }) as bigint;
    console.log(`  ${labels[i]} vault: ${formatUnits(bal, 18)} USDso`);
    total += bal;
  }
  const usdsoAbi = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
  const arenaUsdso = await pub.readContract({ address: usdso, abi: usdsoAbi, functionName: "balanceOf", args: [arenaAddr] }) as bigint;
  const arenaStt = await pub.getBalance({ address: arenaAddr });
  console.log(`  Arena direct USDso: ${formatUnits(arenaUsdso, 18)}`);
  console.log(`  Arena STT: ${Number(arenaStt)/1e18}`);
  console.log(`  Total USDso recoverable from pools: ${formatUnits(total, 18)}`);
}
main().catch(console.error);
