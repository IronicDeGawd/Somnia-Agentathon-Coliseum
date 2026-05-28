import hre from "hardhat";
import { formatUnits, maxUint256 } from "viem";
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
  const usdsoAddr = manifest.external.usdso as `0x${string}`;

  // Tunables via env
  const turns = parseInt(process.env.TURNS ?? "3", 10);
  const fighterA = parseInt(process.env.FIGHTER_A ?? "0", 10);
  const fighterB = parseInt(process.env.FIGHTER_B ?? "1", 10);

  console.log(`Starting duel on ${network}`);
  console.log(`  Arena:    ${arenaAddress}`);
  console.log(`  Fighters: ${fighterA} vs ${fighterB}`);
  console.log(`  Turns:    ${turns}`);

  const arena = await hre.viem.getContractAt("Arena", arenaAddress);
  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const me = wallet.account.address;

  // Check minimum deposit required for this tier
  const minDeposit = await arena.read.minDepositFor([turns]) as bigint;
  const platformFee = await arena.read.PLATFORM_FEE() as bigint;
  const required = minDeposit + platformFee;
  console.log(`  Min deposit: ${formatUnits(minDeposit, 18)} USDso + ${formatUnits(platformFee, 18)} fee = ${formatUnits(required, 18)} USDso`);

  // Check USDso balance
  const usdsoAbi = [{
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  }, {
    name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  }, {
    name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }],
  }] as const;

  const bal = await pub.readContract({
    address: usdsoAddr, abi: usdsoAbi, functionName: "balanceOf", args: [me],
  }) as bigint;
  console.log(`  Wallet USDso: ${formatUnits(bal, 18)}`);

  if (bal < required) {
    throw new Error(`Insufficient USDso: have ${formatUnits(bal, 18)}, need ${formatUnits(required, 18)}`);
  }

  // Approve arena to pull the deposit
  const allowance = await pub.readContract({
    address: usdsoAddr, abi: usdsoAbi, functionName: "allowance", args: [me, arenaAddress],
  }) as bigint;
  if (allowance < required) {
    console.log(`  Approving Arena for ${formatUnits(required, 18)} USDso...`);
    const approveTx = await wallet.writeContract({
      address: usdsoAddr, abi: usdsoAbi, functionName: "approve",
      args: [arenaAddress, maxUint256],
    });
    await pub.waitForTransactionReceipt({ hash: approveTx });
  }

  console.log(`\nCalling startDuel(${fighterA}, ${fighterB}, ${turns})...`);
  const txHash = await arena.write.startDuel([fighterA, fighterB, turns]);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status === "reverted") {
    throw new Error(`startDuel reverted — tx: ${txHash}`);
  }

  const activeDuelId = await arena.read.activeDuelId() as bigint;
  console.log(`  tx:           ${txHash}`);
  console.log(`  activeDuelId: ${activeDuelId}`);
}

main().catch((err) => {
  console.error("start-duel failed:", err?.shortMessage ?? err);
  process.exitCode = 1;
});
