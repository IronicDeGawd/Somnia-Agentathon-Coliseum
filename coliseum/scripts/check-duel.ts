import hre from "hardhat";

async function main() {
  const arena = await hre.viem.getContractAt(
    "Arena",
    "0xf218c91b47227ad3b1fa9891b01c6100ec271107" as `0x${string}`
  );
  const activeDuelId = await arena.read.activeDuelId() as bigint;
  console.log("activeDuelId:", activeDuelId);
  if (activeDuelId === 0n) { console.log("no active duel"); return; }
  const duel = await arena.read.duels([activeDuelId]) as any[];
  console.log("duels(", activeDuelId, "):");
  console.log("  fighterA:", duel[0]);
  console.log("  fighterB:", duel[1]);
  console.log("  startBlock:", duel[2].toString());
  console.log("  lastTurnBlock:", duel[3].toString());
  console.log("  completedCallbacks:", duel[4], "/ 30");
  console.log("  status:", ["None","Pending","Active","Finalizing","Resolved"][duel[5]]);
  console.log("  pool:", duel[6]);

  const pub = await hre.viem.getPublicClient();
  console.log("current block:", (await pub.getBlockNumber()).toString());
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
