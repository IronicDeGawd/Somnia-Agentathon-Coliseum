// count-sides — how many orders in a fight were entries and how many were exits.
//
// The number that matters for a market whose exit was withheld: a rising total
// means nothing if every order is still an entry. Reads OrderPlaced off the chain
// rather than trusting a log.
//
//   DUEL=76 pnpm exec hardhat run scripts/count-sides.ts --network somnia
//
// Env: DUEL (default 76), SPAN is fixed at 20000 blocks — about half an hour, so
// run it soon after the fight or widen it here.
import hre from "hardhat";
import { parseAbiItem, formatUnits } from "viem";
import fs from "fs"; import path from "path";
async function main(){
  const m = JSON.parse(fs.readFileSync(path.join(__dirname,"..","deployments","somnia.json"),"utf-8"));
  const arena = m.contracts.Arena.address as `0x${string}`;
  const pub = await hre.viem.getPublicClient();
  const head = await pub.getBlockNumber();
  const ev = parseAbiItem("event OrderPlaced(address indexed pool, uint8 indexed fighterId, uint256 duelId, uint128 orderId, bool isBid, uint256 price, uint256 quantity, uint8 orderType)");
  const target = BigInt(process.env.DUEL ?? 76);
  let bids=0, asks=0;
  for (let b = head - 20000n; b < head; b += 1000n) {
    const to = b + 999n > head ? head : b + 999n;
    const logs = await pub.getLogs({ address: arena, event: ev as any, fromBlock: b, toBlock: to });
    for (const l of logs) {
      const a = l.args as any;
      if (a.duelId !== target) continue;
      if (a.isBid) bids++; else asks++;
      console.log(`  fighter ${a.fighterId} ${a.isBid ? "BACK" : "DROP"} qty ${formatUnits(a.quantity,18)} @ ${formatUnits(a.price,18)}  blk ${l.blockNumber}`);
    }
  }
  console.log(`\n  duel ${target}: ${bids} back, ${asks} drop`);
}
main().catch(e=>{console.error(e.shortMessage??e.message??e);process.exit(1)});
