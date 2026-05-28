import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs"; import path from "path";
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  for (const [name, addr] of Object.entries({ WETH: m.external.poolWeth, WBTC: m.external.poolWbtc, SOMI: m.external.poolSomi })) {
    const meta = await arena.read.poolMeta([addr]) as readonly [number, bigint, bigint, bigint];
    console.log(`${name} (${addr})`);
    console.log(`  baseDecimals: ${meta[0]}`);
    console.log(`  minQuantity:  ${meta[1].toString()} (${formatUnits(meta[1], meta[0])})`);
    console.log(`  lotSize:      ${meta[2].toString()}`);
    console.log(`  tickSize:     ${meta[3].toString()}`);
  }
}
main().catch(console.error);
