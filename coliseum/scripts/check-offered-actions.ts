// What is each fighter actually being offered right now? The only honest way to
// tell whether a market is on the table, as opposed to whether a fighter happened
// to pick it.
import hre from "hardhat";
import { parseAbi } from "viem";
import fs from "fs"; import path from "path";
const ARENA = parseAbi(["function previewTurnPrompt(uint256,uint8) view returns (string,string[])"]);
async function main(){
  const m = JSON.parse(fs.readFileSync(path.join(__dirname,"..","deployments","somnia.json"),"utf-8"));
  const arena = m.contracts.Arena.address as `0x${string}`;
  const duelId = BigInt(process.env.DUEL ?? "0");
  const pub = await hre.viem.getPublicClient();
  for (const f of [0, 1]) {
    try {
      const [summary, actions] = await pub.readContract({
        address: arena, abi: ARENA, functionName: "previewTurnPrompt", args: [duelId, f],
      }) as readonly [string, readonly string[]];
      console.log(`fighter ${f}: ${actions.join(", ")}`);
      const somi = actions.filter(a => /SOMI/i.test(a));
      console.log(`  coin market on the table: ${somi.length ? somi.join(", ") : "no"}`);
      console.log(`  ${summary.slice(0, 260)}\n`);
    } catch (e: any) { console.log(`fighter ${f}: ${(e.shortMessage ?? e.message).split("\n")[0]}`); }
  }
}
main().catch(e=>{console.error(e.shortMessage??e.message??e);process.exit(1)});
