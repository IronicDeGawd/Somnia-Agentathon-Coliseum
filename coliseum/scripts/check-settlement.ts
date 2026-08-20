import hre from "hardhat";
import { formatUnits, parseAbiItem } from "viem";
import fs from "fs"; import path from "path";
async function main(){
  const m = JSON.parse(fs.readFileSync(path.join(__dirname,"..","deployments","somnia.json"),"utf-8"));
  const arena = m.contracts.Arena.address as `0x${string}`;
  const pub = await hre.viem.getPublicClient();
  const head = await pub.getBlockNumber();
  const span = BigInt(process.env.SPAN ?? 70000);
  const from = head > span ? head - span : 0n;
  const settled = parseAbiItem("event AssetSettled(uint256 indexed duelId, address indexed pool, uint256 quantity, uint256 proceeds)");
  const skipped = parseAbiItem("event AssetSettleSkipped(uint256 indexed duelId, address indexed pool, string reason)");
  for (const [label, ev] of [["SETTLED", settled], ["SKIPPED", skipped]] as const) {
    let found = 0, refused = 0, ranges = 0;
    for (let b = from; b < head; b += 1000n) {
      ranges++;
      const to = b + 999n > head ? head : b + 999n;
      try {
        const logs = await pub.getLogs({ address: arena, event: ev as any, fromBlock: b, toBlock: to });
        for (const l of logs) {
          const a = l.args as any;
          found++;
          if (label === "SETTLED") console.log(`  SETTLED duel ${a.duelId} pool ${String(a.pool).slice(0,10)}… sold ${formatUnits(a.quantity,18)} for ${formatUnits(a.proceeds,18)} USDso  (block ${l.blockNumber})`);
          else console.log(`  skipped duel ${a.duelId} pool ${String(a.pool).slice(0,10)}… — ${a.reason}  (block ${l.blockNumber})`);
        }
      } catch { refused++; }
    }
    // A refused range is indistinguishable from an empty one unless it is counted.
    // Silence here once read as "settlement never ran" when the window was simply
    // shorter than the fights it was meant to cover.
    if (found === 0) console.log(`  no ${label} events in the last ${span} blocks`);
    if (refused > 0) console.log(`  !! ${refused}/${ranges} block ranges were refused — the count above is a floor, not the total`);
  }
}
main().catch(e=>{console.error(e.shortMessage??e.message??e);process.exit(1)});
