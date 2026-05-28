import hre from "hardhat";
import { decodeEventLog } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const pub = await hre.viem.getPublicClient();
  const bn = await pub.getBlockNumber();
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const bookmaker = await hre.viem.getContractAt("Bookmaker", m.contracts.Bookmaker.address);

  // Last 999 blocks (limit)
  const fromBlock = bn - 999n;
  for (const [name, c] of [["Arena", arena], ["Bookmaker", bookmaker]] as const) {
    const logs = await pub.getLogs({ address: c.address, fromBlock, toBlock: bn });
    console.log(`\n--- ${name} (${logs.length} logs) ---`);
    for (const l of logs) {
      try {
        const dec = decodeEventLog({ abi: c.abi, data: l.data, topics: l.topics });
        console.log(`  ${l.blockNumber} ${dec.eventName}`, JSON.stringify(dec.args, (_, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 200));
      } catch (e) {
        console.log(`  ${l.blockNumber} (undecodable)`);
      }
    }
  }
}
main().catch(console.error);
