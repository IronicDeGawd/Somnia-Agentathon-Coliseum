// Can a CONTRACT buy the chain's own coin on that market, or only a wallet?
// The pot's order reverts; the deployer's identical order fills. This isolates
// which of those two facts is about being a contract.
import hre from "hardhat";
import { formatUnits, parseUnits, parseAbi } from "viem";
import fs from "fs"; import path from "path";
const PROBE = parseAbi([
  "function trade(address,bool,uint64,uint256,uint256,uint64,uint8,uint256) returns (bool,uint128)",
  "function approveToken(address,address,uint256)",
  "function sweep(address,address)",
]);
const POOL = parseAbi([
  "function getPoolParams() view returns (address,address,uint256,uint256,uint256,uint256,uint256)",
  "function getBookLevels(bool,uint64) view returns ((uint256 price,uint256 quantity)[])",
]);
const ERC20 = parseAbi(["function mint(address,uint256)","function balanceOf(address) view returns (uint256)"]);
async function main(){
  const m = JSON.parse(fs.readFileSync(path.join(__dirname,"..","deployments","somnia.json"),"utf-8"));
  const probe = (process.env.CONTAINER ?? "0xc7e81371d0aededa1dd0b0db63e6c56692186bf5") as `0x${string}`;
  const pool = m.external.poolSomi as `0x${string}`;
  const usdso = m.external.usdso as `0x${string}`;
  const pub = await hre.viem.getPublicClient(); const [op] = await hre.viem.getWalletClients();

  const p = await pub.readContract({address:pool,abi:POOL,functionName:"getPoolParams"}) as readonly unknown[];
  const tick=p[4] as bigint, minQ=p[5] as bigint, lot=p[6] as bigint;
  const asks = await pub.readContract({address:pool,abi:POOL,functionName:"getBookLevels",args:[false,1n]}) as readonly {price:bigint;quantity:bigint}[];
  // Parameterised so the pot's exact combination can be reproduced from a contract
  // that is known to work, and then bisected one variable at a time.
  const COINS = BigInt(process.env.COINS ?? "1");
  const TICKS = BigInt(process.env.TICKS ?? "50");
  const ALLOWN = BigInt(process.env.ALLOW_NUM ?? "3");
  const ALLOWD = BigInt(process.env.ALLOW_DEN ?? "1");
  const EXPIRY = BigInt(process.env.EXPIRY_S ?? "3600");
  let qty = COINS * 10n**18n; if(lot>0n && qty%lot!==0n) qty=((qty/lot)+1n)*lot;
  if (qty < minQ) qty = minQ;
  let price = asks[0].price + TICKS*tick; price=(price/tick)*tick;
  const cost=(price*qty)/10n**18n;
  console.log(`  params: coins=${COINS} ticks=${TICKS} allow=${ALLOWN}/${ALLOWD} expiry=${EXPIRY}s`);

  await pub.waitForTransactionReceipt({hash: await op.writeContract({address:usdso,abi:ERC20,functionName:"mint",args:[probe,parseUnits("40",18)]})});
  await pub.waitForTransactionReceipt({hash: await op.writeContract({address:probe,abi:PROBE,functionName:"approveToken",args:[usdso,pool,(cost*ALLOWN)/ALLOWD]})});

  const c0 = await pub.getBalance({address:probe});
  const u0 = await pub.readContract({address:usdso,abi:ERC20,functionName:"balanceOf",args:[probe]}) as bigint;
  console.log(`container ${probe}`);
  console.log(`  before: ${formatUnits(u0,18)} stable, ${formatUnits(c0,18)} coin`);
  console.log(`  BUY ${formatUnits(qty,18)} coin at ${formatUnits(price,18)} (best ask ${formatUnits(asks[0].price,18)}), allowance ${formatUnits((cost*ALLOWN)/ALLOWD,18)}`);
  const blk = await pub.getBlock();
  try {
    const h = await op.writeContract({address:probe,abi:PROBE,functionName:"trade",args:[pool,true,0n,price,qty,(blk.timestamp+EXPIRY)*1_000_000_000n,1,0n]});
    const r = await pub.waitForTransactionReceipt({hash:h});
    console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
  } catch(e:any){ console.log(`  REVERTED: ${(e.shortMessage??e.message).split("\n")[0]}`); }
  const c1 = await pub.getBalance({address:probe});
  const u1 = await pub.readContract({address:usdso,abi:ERC20,functionName:"balanceOf",args:[probe]}) as bigint;
  console.log(`  after:  ${formatUnits(u1,18)} stable, ${formatUnits(c1,18)} coin`);
  console.log(`\n  ${c1>c0 ? "A CONTRACT CAN buy the coin here — so the pot's revert is about the pot, not about being a contract."
    : "A CONTRACT CANNOT buy the coin here — the venue only delivers native to a wallet. The pot needs a different route."}`);
  await op.writeContract({address:probe,abi:PROBE,functionName:"approveToken",args:[usdso,pool,0n]});
}
main().catch(e=>{console.error(e.shortMessage??e.message??e);process.exit(1)});
