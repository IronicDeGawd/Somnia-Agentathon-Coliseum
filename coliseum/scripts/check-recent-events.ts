import hre from "hardhat";
import { decodeEventLog } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = m.contracts.Arena.address;
  const pub = await hre.viem.getPublicClient();
  const bn = await pub.getBlockNumber();
  // Look back ~3000 blocks for events
  const logs = await pub.getLogs({
    address: arena,
    fromBlock: bn - 999n,
    toBlock: bn,
  });
  console.log(`Found ${logs.length} logs in last 3000 blocks on Arena ${arena}`);
  const arenaContract = await hre.viem.getContractAt("Arena", arena);
  const abi = arenaContract.abi;
  for (const l of logs) {
    try {
      const dec = decodeEventLog({ abi, data: l.data, topics: l.topics });
      console.log(`  ${l.blockNumber} ${dec.eventName}`, JSON.stringify(dec.args, (_, v) => typeof v === "bigint" ? v.toString() : v));
    } catch (e) {
      console.log(`  ${l.blockNumber} (undecodable)`);
    }
  }
}
main().catch(console.error);
