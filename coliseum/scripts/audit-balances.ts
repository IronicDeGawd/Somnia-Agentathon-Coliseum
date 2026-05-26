import hre from "hardhat";
import { formatEther } from "viem";
import fs from "fs";

const m = JSON.parse(fs.readFileSync("deployments/somnia.json", "utf-8"));
const ARENA = m.contracts.Arena.address as `0x${string}`;
const USDSO = m.external.usdso as `0x${string}`;
const POOLS = [m.external.poolWeth, m.external.poolWbtc, m.external.poolSomi] as `0x${string}`[];

async function main() {
  const pub = await hre.viem.getPublicClient();
  const balanceOfAbi = [{
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }],
  }] as const;
  const getWBAbi = [{
    name: "getWithdrawableBalance", type: "function", stateMutability: "view",
    inputs: [{ name: "u", type: "address" }, { name: "t", type: "address" }],
    outputs: [{ type: "uint256" }],
  }] as const;

  console.log("Arena ERC20 USDso balance:");
  const arenaErc = await pub.readContract({ address: USDSO, abi: balanceOfAbi, functionName: "balanceOf", args: [ARENA] }) as bigint;
  console.log(` ${formatEther(arenaErc)}`);

  console.log("\nPool vault balances (getWithdrawableBalance arena, USDSO):");
  for (const pool of POOLS) {
    try {
      const r = await pub.readContract({ address: pool, abi: getWBAbi, functionName: "getWithdrawableBalance", args: [ARENA, USDSO] }) as bigint;
      console.log(` ${pool}: ${formatEther(r)}`);
    } catch (e: any) {
      console.log(` ${pool}: ERROR ${e.shortMessage || e.message}`);
    }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
