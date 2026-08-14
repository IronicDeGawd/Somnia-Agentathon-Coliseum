import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs"; import path from "path";
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const slots: Record<string, string> = {
    WETH: m.external.poolWeth, WBTC: m.external.poolWbtc, SOMI: m.external.poolSomi,
  };
  if (await arena.read.eventPoolsSet()) {
    slots["event WETH slot"] = await arena.read.EVENT_POOL_WETH() as string;
    slots["event WBTC slot"] = await arena.read.EVENT_POOL_WBTC() as string;
    slots["event SOMI slot"] = await arena.read.EVENT_POOL_SOMI() as string;
  }
  for (const [name, addr] of Object.entries(slots)) {
    const meta = await arena.read.poolMeta([addr]) as readonly [number, bigint, bigint, bigint];
    const q = await arena.read.poolQuestion([addr]) as `0x${string}`;
    const question = Buffer.from(q.slice(2), "hex").toString("ascii").replace(/\0+$/, "");
    console.log(`${name} (${addr})`);
    console.log(`  baseDecimals: ${meta[0]}`);
    console.log(`  asks:         ${question ? `"${question}" (a prediction, priced as odds)` : "nothing — an ordinary asset"}`);
    console.log(`  minQuantity:  ${meta[1].toString()} (${formatUnits(meta[1], meta[0])})`);
    console.log(`  lotSize:      ${meta[2].toString()}`);
    console.log(`  tickSize:     ${meta[3].toString()}`);
  }
}
main().catch(console.error);
