/**
 * duel-tape.ts
 * ------------
 * Print what actually happened in recent fights: every move a fighter chose,
 * every order that reached a market, and every one that was refused.
 *
 * Reads the chain rather than the referee's log, so it shows the fight as it was
 * recorded. The rejections are the point — a fight can look like a quiet draw
 * when in truth its moves were being thrown away. That is exactly how the
 * settled-question bug was found: three of duel #6's five moves never reached a
 * market, and nothing in the duel's result said so.
 *
 *   FROM_DUEL=3 BLOCKS=6000 pnpm exec hardhat run scripts/duel-tape.ts --network somnia
 */
import hre from "hardhat"; import { parseAbiItem, formatEther } from "viem";
import fs from "fs"; import path from "path";
const MOVE=parseAbiItem("event FighterMove(uint256 indexed duelId, uint8 indexed fighterId, uint8 action, uint128 orderId)");
const PLACED=parseAbiItem("event OrderPlaced(address indexed pool, uint8 indexed fighterId, uint256 duelId, uint128 orderId, bool isBid, uint256 price, uint256 quantity, uint8 orderType)");
const REJ=parseAbiItem("event OrderRejected(address indexed pool, uint8 indexed fighterId, uint256 duelId, bool isBid, uint256 price, uint256 quantity, uint8 orderType, string reason)");
const COERCE=parseAbiItem("event FighterMoveCoerced(uint256 indexed duelId, uint8 indexed fighterId, string requested)");
const FAIL=parseAbiItem("event FighterMoveFailed(uint256 indexed duelId, uint8 indexed fighterId, string reason)");
const ACT=["Hold","BuyWBTC","SellWBTC","BuyWETH","SellWETH","BuySOMI","SellSOMI"];
async function main(){
  const m=JSON.parse(fs.readFileSync(path.join(__dirname,"..","deployments","somnia.json"),"utf-8"));
  const pub=await hre.viem.getPublicClient(); const arena=m.contracts.Arena.address;
  const a=await hre.viem.getContractAt("Arena",arena);
  const names:Record<string,string>={};
  for(const s of ["EVENT_POOL_WETH","EVENT_POOL_WBTC","EVENT_POOL_SOMI"]){
    const p=await (a.read as any)[s]() as string;
    const q=await a.read.poolQuestion([p as `0x${string}`]) as string;
    names[p.toLowerCase()]=Buffer.from(q.slice(2),"hex").toString("ascii").replace(/\0+$/,"")||p.slice(0,8);
  }
  const head=await pub.getBlockNumber();
  const rows:string[]=[]; let moves=0,orders=0,rej=0,co=0,fail=0;
  const span = BigInt(process.env.BLOCKS ?? "6000");
  const first = BigInt(process.env.FROM_DUEL ?? "3");
  for(let b=head-span;b<head;b+=900n){
    const to=b+899n>head?head:b+899n;
    for(const [ev,tag] of [[MOVE,"m"],[PLACED,"o"],[REJ,"r"],[COERCE,"c"],[FAIL,"f"]] as any){
      try{ const lo=await pub.getLogs({address:arena,event:ev,fromBlock:b,toBlock:to});
        for(const l of lo){ const g:any=(l as any).args; const id=Number(g.duelId);
          if(BigInt(id)<first) continue;
          if(tag==="m"){moves++;rows.push(`${l.blockNumber} #${id} fighter ${g.fighterId} → ${ACT[Number(g.action)]}`);}
          if(tag==="o"){orders++;rows.push(`${l.blockNumber} #${id} fighter ${g.fighterId} ORDER ${names[String(g.pool).toLowerCase()]??g.pool} ${g.isBid?"buy":"sell"} qty ${formatEther(g.quantity)} @ ${formatEther(g.price)}`);}
          if(tag==="r"){rej++;rows.push(`${l.blockNumber} #${id} REJECTED ${g.reason}`);}
          if(tag==="c"){co++;rows.push(`${l.blockNumber} #${id} COERCED "${g.requested}"`);}
          if(tag==="f"){fail++;rows.push(`${l.blockNumber} #${id} FAILED ${g.reason}`);}
        }
      }catch{}
    }
  }
  rows.sort(); rows.forEach(r=>console.log(r));
  console.log(`\nmoves ${moves} · orders ${orders} · rejected ${rej} · coerced ${co} · failed ${fail}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.shortMessage??e);process.exit(1)});
