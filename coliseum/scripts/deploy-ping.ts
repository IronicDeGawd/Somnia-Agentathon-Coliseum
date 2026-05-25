import hre from "hardhat";

async function main() {
  console.log("Deploying Ping to network:", hre.network.name);

  const ping = await hre.viem.deployContract("Ping");
  console.log("Ping deployed at:", ping.address);

  const publicClient = await hre.viem.getPublicClient();
  const walletClients = await hre.viem.getWalletClients();
  if (!walletClients.length) throw new Error("No wallet clients — set PRIVATE_KEY in .env");
  const walletClient = walletClients[0];

  const txHash = await walletClient.writeContract({
    address: ping.address,
    abi: ping.abi,
    functionName: "pingAndLog",
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") throw new Error(`pingAndLog() reverted — tx: ${txHash}`);
  console.log("pingAndLog() tx hash:", txHash);
}

main().catch((err) => {
  console.error("deploy-ping failed:", err);
  process.exitCode = 1;
});
