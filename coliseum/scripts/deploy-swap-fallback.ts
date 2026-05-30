// ============================================================================
// Standalone SwapFallback deploy.
// ----------------------------------------------------------------------------
// Deploys ONLY the SwapFallback contract on the network and seeds it with
// USDso so the in-app fallback path has reserve to hand out. Funds collected
// STT to be swept later into the MM seeder bot wallet.
//
//   pnpm exec hardhat run scripts/deploy-swap-fallback.ts --network somnia
//
// Env:
//   FALLBACK_RATE      — STT per 1 USDso in wei (default 7e18 = 7 STT/USDso)
//   FALLBACK_MIN_IN    — min STT per call in wei (default 1e18 = 1 STT)
//   FALLBACK_USDSO_SEED — USDso (in whole tokens) to transfer in after deploy
//                         (default 5 — covers 5 unique claims at 1 USDso each)
// ============================================================================

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { parseEther } from "viem";

async function main() {
  const network = hre.network.name;
  console.log(`\nSwapFallback deploy — network: ${network}`);

  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No deployment manifest at deployments/${network}.json.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const usdsoAddr = manifest?.external?.usdso as `0x${string}` | undefined;
  if (!usdsoAddr) throw new Error("USDso address missing from manifest.external.");

  const rate = BigInt(process.env.FALLBACK_RATE ?? parseEther("7").toString());
  const minIn = BigInt(process.env.FALLBACK_MIN_IN ?? parseEther("1").toString());
  const seedUsdso = parseEther(process.env.FALLBACK_USDSO_SEED ?? "5");

  console.log(`  USDso:             ${usdsoAddr}`);
  console.log(`  sttPerUsdso:       ${rate} (${Number(rate) / 1e18} STT per 1 USDso)`);
  console.log(`  minSttIn:          ${minIn} (${Number(minIn) / 1e18} STT)`);
  console.log(`  USDso seed amount: ${seedUsdso} (${Number(seedUsdso) / 1e18} USDso)`);

  const [wallet] = await hre.viem.getWalletClients();
  const deployer = wallet.account.address;
  const pub = await hre.viem.getPublicClient();
  console.log(`  Deployer:          ${deployer}`);

  console.log("\nDeploying SwapFallback...");
  const fallback = await hre.viem.deployContract("SwapFallback", [usdsoAddr, rate, minIn]);
  console.log(`  SwapFallback:      ${fallback.address}`);

  if (seedUsdso > 0n) {
    console.log(`\nTransferring ${Number(seedUsdso) / 1e18} USDso seed to contract...`);
    const usdsoAbi = [
      {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "a", type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ] as const;
    const myBal = (await pub.readContract({
      address: usdsoAddr,
      abi: usdsoAbi,
      functionName: "balanceOf",
      args: [deployer],
    })) as bigint;
    if (myBal < seedUsdso) {
      console.log(`  ⚠ Deployer holds only ${Number(myBal) / 1e18} USDso (needs ${Number(seedUsdso) / 1e18}). Skipping seed.`);
    } else {
      const hash = await wallet.writeContract({
        address: usdsoAddr,
        abi: usdsoAbi,
        functionName: "transfer",
        args: [fallback.address, seedUsdso],
      });
      await pub.waitForTransactionReceipt({ hash });
      const reserve = (await pub.readContract({
        address: usdsoAddr,
        abi: usdsoAbi,
        functionName: "balanceOf",
        args: [fallback.address],
      })) as bigint;
      console.log(`  Reserve confirmed: ${Number(reserve) / 1e18} USDso`);
    }
  }

  manifest.contracts = manifest.contracts ?? {};
  manifest.contracts.SwapFallback = { address: fallback.address };
  manifest.swapFallbackDeployBlock = (await pub.getBlockNumber()).toString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nManifest updated: deployments/${network}.json`);

  console.log("\n┌─ NEXT STEP ────────────────────────────────────────────────┐");
  console.log("│ Paste into coliseum/frontend/lib/contracts.ts:             │");
  console.log(`│   SwapFallback: '${fallback.address}' as const,`);
  console.log("└────────────────────────────────────────────────────────────┘");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
