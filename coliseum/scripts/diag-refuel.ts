import hre from "hardhat";
import { formatUnits, parseAbi, encodeFunctionData } from "viem";
import fs from "fs"; import path from "path";
const POOL = parseAbi([
  "function getPoolParams() view returns (address,address,uint256,uint256,uint256,uint256,uint256)",
  "function getBookLevels(bool,uint64) view returns ((uint256 price,uint256 quantity)[])",
  "function placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96) returns (bool,uint128)",
]);
const ERC20 = parseAbi(["function allowance(address,address) view returns (uint256)","function balanceOf(address) view returns (uint256)"]);
async function main(){
  const m = JSON.parse(fs.readFileSync(path.join(__dirname,"..","deployments","somnia.json"),"utf-8"));
  const pot = m.contracts.FuelPot.address as `0x${string}`;
  const pool = m.external.poolSomi as `0x${string}`;
  const usdso = m.external.usdso as `0x${string}`;
  const pub = await hre.viem.getPublicClient();
  const p = await pub.readContract({address:pool,abi:POOL,functionName:"getPoolParams"}) as readonly unknown[];
  const tick=p[4] as bigint, minQ=p[5] as bigint, lot=p[6] as bigint;
  const asks = await pub.readContract({address:pool,abi:POOL,functionName:"getBookLevels",args:[false,1n]}) as readonly {price:bigint;quantity:bigint}[];
  let price = asks[0].price + (asks[0].price*200n)/10000n; price=(price/tick)*tick;
  let qty = 8n*10n**18n; if(lot>0n) qty=(qty/lot)*lot;
  const cost=(price*qty)/10n**18n;
  console.log(`pot ${pot}`);
  console.log(`  order: BUY ${formatUnits(qty,18)} at ${formatUnits(price,18)} = ${formatUnits(cost,18)} stable (best ask ${formatUnits(asks[0].price,18)})`);
  console.log(`  pot stable balance ${formatUnits(await pub.readContract({address:usdso,abi:ERC20,functionName:"balanceOf",args:[pot]}) as bigint,18)}`);
  console.log(`  pot allowance to pool ${formatUnits(await pub.readContract({address:usdso,abi:ERC20,functionName:"allowance",args:[pot,pool]}) as bigint,18)}`);
  console.log(`  minQuantity ${formatUnits(minQ,18)}  lot ${formatUnits(lot,18)}  tick ${formatUnits(tick,18)}`);
  const blk = await pub.getBlock();
  const data = encodeFunctionData({abi:POOL,functionName:"placeOrder",args:[true,0n,price,qty,BigInt(Number(blk.timestamp)+300)*1_000_000_000n,1,0,"0x0000000000000000000000000000000000000000",0n]});
  // As the POT, with the allowance it would have. eth_call cannot grant the
  // allowance, so this shows whether anything OTHER than the allowance refuses.
  try {
    const r = await pub.call({to:pool,data,account:pot});
    console.log(`\n  as the pot, eth_call returned ${r.data}`);
    if (r.data && r.data.length >= 66) console.log(`    first word (success flag) = ${BigInt("0x"+r.data.slice(2,66))}`);
  } catch(e:any){ console.log(`\n  as the pot, eth_call REVERTED: ${(e.shortMessage??e.message).split("\n")[0]}`); }
  // Same order as a plain wallet that is known to work, for contrast.
  const [op] = await hre.viem.getWalletClients();
  try {
    const r2 = await pub.call({to:pool,data,account:op.account.address});
    console.log(`  as the deployer wallet, eth_call returned ${r2.data}`);
    if (r2.data && r2.data.length >= 66) console.log(`    first word (success flag) = ${BigInt("0x"+r2.data.slice(2,66))}`);
  } catch(e:any){ console.log(`  as the deployer wallet, eth_call REVERTED: ${(e.shortMessage??e.message).split("\n")[0]}`); }
}
main().catch(e=>{console.error(e.shortMessage??e.message??e);process.exit(1)});
