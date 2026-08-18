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
 * A MOVE IS A BARE NUMBER, one to six, and what it means depends on the markets
 * that fight was bound to: buy and sell on a coin book, back and drop on a
 * prediction question, long and short on a perpetual. So each duel's own three
 * markets are read and its moves named against them. A fixed table of coin names
 * would report a fighter that shorted Bitcoin as having bought Ethereum — the same
 * class of quiet mislabelling this script exists to catch.
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

/** bytes8 of ASCII, right-padded with zeros. */
const text=(raw:string)=>Buffer.from(raw.slice(2),"hex").toString("ascii").replace(/\0+$/,"");

async function main(){
  const m=JSON.parse(fs.readFileSync(path.join(__dirname,"..","deployments","somnia.json"),"utf-8"));
  const pub=await hre.viem.getPublicClient(); const arena=m.contracts.Arena.address;
  const a=await hre.viem.getContractAt("Arena",arena);

  // Pool address → display name, filled in as duels are encountered.
  const names:Record<string,string>={};

  /**
   * One duel's seven action names, in the order `ArenaUtils.actionName` numbers
   * them — which is NOT sequential: ids 1 and 2 are slot 1, ids 3 and 4 are slot 0,
   * ids 5 and 6 are slot 2, and odd ids are the upward direction.
   */
  const actionsOf=new Map<number,string[]>();
  async function actions(duelId:number):Promise<string[]>{
    const cached=actionsOf.get(duelId); if(cached) return cached;
    const fallback=["Hold","BuyWBTC","SellWBTC","BuyWETH","SellWETH","BuySOMI","SellSOMI"];
    let out=fallback;
    try{
      const pools=await a.read.duelPoolsOf([BigInt(duelId)]) as string[];
      const kinds=await Promise.all(pools.map(async(p)=>{
        if(!p||/^0x0+$/.test(p)) return {label:"",perp:false};
        const label=text(await a.read.poolQuestion([p as `0x${string}`]) as string);
        let perp=false;
        try{ perp=await (a.read as any).isPerpPool([p as `0x${string}`]) as boolean; }catch{}
        names[p.toLowerCase()]=label||p.slice(0,8);
        return {label,perp};
      }));
      out=["Hold"];
      for(let id=1;id<=6;id++){
        const slot=id<=2?1:(id<=4?0:2);
        const up=id%2===1;
        const k=kinds[slot];
        if(k?.perp&&k.label) out.push(`${up?"Long":"Short"}${k.label}`);
        else if(k?.label)    out.push(`${up?"Back":"Drop"}${k.label}`);
        else                 out.push(fallback[id]);
      }
    }catch{}
    actionsOf.set(duelId,out);
    return out;
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
          if(tag==="m"){moves++;const act=await actions(id);rows.push(`${l.blockNumber} #${id} fighter ${g.fighterId} → ${act[Number(g.action)]??"Hold"}`);}
          if(tag==="o"){orders++;await actions(id);rows.push(`${l.blockNumber} #${id} fighter ${g.fighterId} ORDER ${names[String(g.pool).toLowerCase()]??g.pool} ${g.isBid?"buy":"sell"} qty ${formatEther(g.quantity)} @ ${formatEther(g.price)}`);}
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
