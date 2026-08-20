// count-sides — how many orders in a fight were entries and how many were exits.
//
// The number that matters for a market whose exit was withheld: a rising total
// means nothing if every order is still an entry. Reads OrderPlaced off the chain
// rather than trusting a log.
//
//   DUEL=76 pnpm exec hardhat run scripts/count-sides.ts --network somnia
//
// Env: DUEL (default 76), SPAN in blocks (default 60000 — about an hour and a half
// at this chain's pace). A window shorter than the age of the fight reads as "no
// orders", which is indistinguishable from a fight that never traded, so the count
// says when it found nothing rather than letting the silence speak.
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
  const span = BigInt(process.env.SPAN ?? 60000);
  const from = head > span ? head - span : 0n;
  for (let b = from; b < head; b += 1000n) {
    const to = b + 999n > head ? head : b + 999n;
    const logs = await pub.getLogs({ address: arena, event: ev as any, fromBlock: b, toBlock: to });
    for (const l of logs) {
      const a = l.args as any;
      if (a.duelId !== target) continue;
      if (a.isBid) bids++; else asks++;
      console.log(`  fighter ${a.fighterId} ${a.isBid ? "BACK" : "DROP"} qty ${formatUnits(a.quantity,18)} @ ${formatUnits(a.price,18)}  blk ${l.blockNumber}`);
    }
  }
  console.log(`\n  duel ${target}: ${bids} back, ${asks} drop  (scanned ${span} blocks back from ${head})`);
  if (bids + asks === 0) {
    console.log("  NOTHING FOUND — widen SPAN before concluding the fight placed no orders.");
  }
}
main().catch(e=>{console.error(e.shortMessage??e.message??e);process.exit(1)});
