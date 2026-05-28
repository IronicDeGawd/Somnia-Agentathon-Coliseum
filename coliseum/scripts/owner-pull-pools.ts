import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const pub = await hre.viem.getPublicClient();
  const usdso = m.external.usdso;
  const pools = [m.external.poolWeth, m.external.poolWbtc, m.external.poolSomi];
  const labels = ["WETH", "WBTC", "SOMI"];

  for (let i = 0; i < 3; i++) {
    const poolAbi = [{
      name: "getWithdrawableBalance", type: "function", stateMutability: "view",
      inputs: [{ name: "u", type: "address" }, { name: "t", type: "address" }],
      outputs: [{ type: "uint256" }],
    }] as const;
    const bal = await pub.readContract({
      address: pools[i] as `0x${string}`, abi: poolAbi,
      functionName: "getWithdrawableBalance", args: [arena.address, usdso],
    }) as bigint;
    if (bal === 0n) { console.log(`  ${labels[i]}: empty`); continue; }
    console.log(`  withdrawFromPool ${labels[i]}: ${formatUnits(bal, 18)} USDso`);
    const tx = await arena.write.withdrawFromPool([pools[i], usdso, bal]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }
  const usdsoAbi = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
  const arenaBal = await pub.readContract({ address: usdso, abi: usdsoAbi, functionName: "balanceOf", args: [arena.address] }) as bigint;
  console.log(`Arena now holds: ${formatUnits(arenaBal, 18)} USDso (stuck — sweepToken blocks USDso post-H-1)`);
}
main().catch(e => console.error(e?.shortMessage ?? e));
