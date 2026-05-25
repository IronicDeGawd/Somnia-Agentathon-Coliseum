import hre from "hardhat";
import { parseEther } from "viem";
import fs from "fs";
import path from "path";

async function main() {
  const network = hre.network.name;
  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No deployment manifest found at ${manifestPath}. Run deploy first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const arenaAddress = manifest.contracts.Arena.address as `0x${string}`;
  const poolWeth = manifest.external.poolWeth as `0x${string}`;

  console.log(`Starting duel on ${network}`);
  console.log(`Arena:    ${arenaAddress}`);
  console.log(`Pool:     ${poolWeth}`);

  const arena = await hre.viem.getContractAt("Arena", arenaAddress);

  const txHash = await arena.write.startDuel([
    0,
    1,
    poolWeth,
    parseEther("100"),
  ]);

  const publicClient = await hre.viem.getPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status === "reverted") {
    throw new Error(`startDuel reverted — tx: ${txHash}`);
  }

  const activeDuelId = await arena.read.activeDuelId() as bigint;
  console.log(`startDuel tx:  ${txHash}`);
  console.log(`activeDuelId:  ${activeDuelId}`);
}

main().catch((err) => {
  console.error("start-duel failed:", err);
  process.exitCode = 1;
});
