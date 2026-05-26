import hre from "hardhat";

async function main() {
  const arena = await hre.viem.getContractAt(
    "Arena",
    "0xf218c91b47227ad3b1fa9891b01c6100ec271107" as `0x${string}`
  );
  const pub = await hre.viem.getPublicClient();

  const tx = await arena.write.finalizeDuel([1n]);
  console.log("finalize tx:", tx);
  const receipt = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("status:", receipt.status);

  for (const log of receipt.logs) {
    console.log(" topic0:", log.topics[0]?.slice(0, 12), "data:", log.data.slice(0, 80));
  }

  const activeId = await arena.read.activeDuelId() as bigint;
  console.log("activeDuelId now:", activeId);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
