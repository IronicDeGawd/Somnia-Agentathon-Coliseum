import hre from "hardhat";
import { formatUnits, parseEther, parseAbi } from "viem";
import fs from "fs"; import path from "path";
const POT = parseAbi(["function setBand(uint256,uint256)","function floorCoin() view returns (uint256)","function targetCoin() view returns (uint256)"]);
async function main(){
  const m = JSON.parse(fs.readFileSync(path.join(__dirname,"..","deployments","somnia.json"),"utf-8"));
  const pot = m.contracts.FuelPot.address as `0x${string}`;
  const pub = await hre.viem.getPublicClient(); const [op] = await hre.viem.getWalletClients();
  const floor = parseEther(process.env.FLOOR ?? "25"); const target = parseEther(process.env.TARGET ?? "40");
  const h = await op.writeContract({address:pot,abi:POT,functionName:"setBand",args:[floor,target]});
  await pub.waitForTransactionReceipt({hash:h});
  console.log(`band now ${formatUnits(await pub.readContract({address:pot,abi:POT,functionName:"floorCoin"}) as bigint,18)} .. ${formatUnits(await pub.readContract({address:pot,abi:POT,functionName:"targetCoin"}) as bigint,18)}`);
}
main().catch(e=>{console.error(e.shortMessage??e.message??e);process.exit(1)});
