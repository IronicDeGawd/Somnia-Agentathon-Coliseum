// ============================================================================
// Standalone Matchmaker deploy.
// ----------------------------------------------------------------------------
// Deploys ONLY the Matchmaker contract, reusing the already-live Arena and
// USDso from deployments/<network>.json. Leaves FighterRegistry, Arena, and
// Bookmaker untouched. Appends the Matchmaker address to the manifest.
//
//   pnpm exec hardhat run scripts/deploy-matchmaker.ts --network somnia
// ============================================================================

import hre from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const network = hre.network.name;
  console.log(`\nMatchmaker deploy — network: ${network}`);

  // ── Load existing manifest ────────────────────────────────────────────────
  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No deployment manifest at deployments/${network}.json — ` +
      `deploy Arena + Bookmaker first (scripts/deploy.ts).`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const arenaAddr = manifest?.contracts?.Arena?.address as `0x${string}` | undefined;
  const usdsoAddr = manifest?.external?.usdso as `0x${string}` | undefined;
  const regAddr   = manifest?.contracts?.FighterRegistry?.address as `0x${string}` | undefined;

  if (!arenaAddr) throw new Error("Arena address missing from manifest.");
  if (!usdsoAddr) throw new Error("USDso address missing from manifest.external.");
  if (!regAddr)   throw new Error("FighterRegistry address missing from manifest.");

  console.log(`  Reusing Arena:    ${arenaAddr}`);
  console.log(`  Reusing USDso:    ${usdsoAddr}`);
  console.log(`  Reusing Registry: ${regAddr}`);

  const [wallet] = await hre.viem.getWalletClients();
  const deployer = wallet.account.address;
  const publicClient = await hre.viem.getPublicClient();
  console.log(`  Deployer:       ${deployer}`);

  // ── Deploy Matchmaker(arena, usdso) ───────────────────────────────────────
  console.log("\nDeploying Matchmaker...");
  const matchmaker = await hre.viem.deployContract("Matchmaker", [arenaAddr, usdsoAddr, regAddr]);
  console.log(`  Matchmaker:     ${matchmaker.address}`);

  // ── Sanity reads against the live Arena ───────────────────────────────────
  try {
    const half3 = await matchmaker.read.halfDeposit([3]);
    const half15 = await matchmaker.read.halfDeposit([15]);
    console.log(`  halfDeposit(3):  ${half3}`);
    console.log(`  halfDeposit(15): ${half15}`);
    const free = await matchmaker.read.arenaFree();
    console.log(`  arenaFree():     ${free}`);
  } catch (e) {
    console.log("  (sanity read skipped — Arena view call reverted)");
  }

  // ── Append to manifest (preserve everything else) ─────────────────────────
  manifest.contracts = manifest.contracts ?? {};
  manifest.contracts.Matchmaker = { address: matchmaker.address };
  const block = await publicClient.getBlockNumber();
  manifest.matchmakerDeployBlock = block.toString();

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nManifest updated: deployments/${network}.json`);

  // ── Reminder for the frontend wiring ──────────────────────────────────────
  console.log("\n┌─ NEXT STEP ────────────────────────────────────────────────┐");
  console.log("│ Paste this into coliseum/frontend/lib/contracts.ts:        │");
  console.log(`│   Matchmaker: '${matchmaker.address}' as const,`);
  console.log("└────────────────────────────────────────────────────────────┘");
  console.log("\nMatchmaker deploy complete.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
