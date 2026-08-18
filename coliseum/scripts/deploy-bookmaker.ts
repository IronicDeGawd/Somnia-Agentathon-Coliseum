// ============================================================================
// Standalone Bookmaker redeploy.
// ----------------------------------------------------------------------------
// The Bookmaker is an ordinary contract, not a router with swappable parts, so
// changing its code means a new address. Everything it depends on — Arena,
// USDso, FighterRegistry, Matchmaker, the inference platform — is reused from
// deployments/<network>.json, and only the Bookmaker entry is rewritten.
//
// BEFORE running this:
//   1. Settle every open line on the outgoing Bookmaker. It holds bettors' USDso
//      until settleBets pays out, and a new address cannot see those bets. This
//      script REFUSES to deploy while the old one still holds USDso.
//   2. Drain the old one's STT (withdrawNative). A subscription attached to it
//      keeps firing while it can pay, and an abandoned contract with fuel is a
//      contract that quietly burns it — measured at ~34 STT/hour. Leave a margin:
//      it spends ~0.01 STT per block, so asking for the exact balance read a
//      moment earlier makes the transfer fail and reverts the whole call.
//
// AFTER running this:
//   - paste the new address into frontend/lib/contracts.ts and rebuild the
//     frontend (the address is compiled in, not read from the manifest)
//   - restart the bots, which snapshot the manifest at startup
//   - fund it and call resubscribe() if it should drive its own re-pricing
//
//   pnpm exec hardhat run scripts/deploy-bookmaker.ts --network somnia
// ============================================================================

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { formatEther } from "viem";

async function main() {
  const network = hre.network.name;
  console.log(`\nBookmaker redeploy — network: ${network}`);

  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No deployment manifest at deployments/${network}.json.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const arenaAddr      = manifest?.contracts?.Arena?.address as `0x${string}` | undefined;
  const usdsoAddr      = manifest?.external?.usdso as `0x${string}` | undefined;
  const registryAddr   = manifest?.contracts?.FighterRegistry?.address as `0x${string}` | undefined;
  const matchmakerAddr = manifest?.contracts?.Matchmaker?.address as `0x${string}` | undefined;
  const platformAddr   = manifest?.external?.platform as `0x${string}` | undefined;
  const turnInterval   = manifest?.contracts?.Arena?.turnIntervalBlocks as string | undefined;
  const oldAddr        = manifest?.contracts?.Bookmaker?.address as `0x${string}` | undefined;

  if (!arenaAddr)      throw new Error("Arena address missing from manifest.");
  if (!usdsoAddr)      throw new Error("USDso address missing from manifest.external.");
  if (!registryAddr)   throw new Error("FighterRegistry address missing from manifest.");
  if (!matchmakerAddr) throw new Error("Matchmaker address missing from manifest.");
  if (!platformAddr)   throw new Error("platform address missing from manifest.external.");
  if (!turnInterval)   throw new Error("Arena.turnIntervalBlocks missing from manifest.");

  const publicClient = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();

  console.log(`  Reusing Arena:      ${arenaAddr}`);
  console.log(`  Reusing USDso:      ${usdsoAddr}`);
  console.log(`  Reusing Registry:   ${registryAddr}`);
  console.log(`  Reusing Matchmaker: ${matchmakerAddr}`);
  console.log(`  Reusing platform:   ${platformAddr}`);
  console.log(`  Turn interval:      ${turnInterval} blocks`);
  console.log(`  Deployer:           ${wallet.account.address}`);

  // ── Refuse to abandon bettors' money ──────────────────────────────────────
  if (oldAddr) {
    const held = (await publicClient.readContract({
      address: usdsoAddr,
      abi: [{
        type: "function", name: "balanceOf", stateMutability: "view",
        inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }],
      }],
      functionName: "balanceOf",
      args: [oldAddr],
    })) as bigint;
    const stt = await publicClient.getBalance({ address: oldAddr });
    console.log(`\n  Outgoing ${oldAddr}`);
    console.log(`    holds ${formatEther(held)} USDso, ${formatEther(stt)} STT`);
    if (held > 0n) {
      throw new Error(
        `the outgoing Bookmaker still holds ${formatEther(held)} USDso — that is bet stakes and ` +
        `accrued rake, and the new address cannot pay them out. Settle every open line and ` +
        `withdraw the rake first.`,
      );
    }
    if (stt > 0n) {
      console.log(`    NOTE: it still has STT. Anything subscribed to it can keep spending that.`);
    }
  }

  // ── Deploy ────────────────────────────────────────────────────────────────
  console.log("\nDeploying Bookmaker...");
  const bookmaker = await hre.viem.deployContract("Bookmaker", [
    arenaAddr, usdsoAddr, registryAddr, matchmakerAddr, platformAddr, BigInt(turnInterval),
  ]);
  console.log(`  Bookmaker:          ${bookmaker.address}`);

  // ── Sanity reads: prove it is wired to the live Arena, and shipped OFF ─────
  console.log(`  owner:              ${await bookmaker.read.owner()}`);
  console.log(`  arena:              ${await bookmaker.read.arena()}`);
  console.log(`  TURN_INTERVAL:      ${await bookmaker.read.TURN_INTERVAL_BLOCKS()}`);
  console.log(`  reactivityOn:       ${await bookmaker.read.reactivityOn()}  (opt-in, as intended)`);
  console.log(`  subscriptionId:     ${await bookmaker.read.subscriptionId()}`);

  // ── Rewrite only the Bookmaker entry ──────────────────────────────────────
  manifest.contracts = manifest.contracts ?? {};
  if (oldAddr) manifest.contracts.Bookmaker = { ...manifest.contracts.Bookmaker, previousAddress: oldAddr };
  manifest.contracts.Bookmaker = {
    ...manifest.contracts.Bookmaker,
    address: bookmaker.address,
    deployBlock: (await publicClient.getBlockNumber()).toString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nManifest updated: deployments/${network}.json`);

  console.log("\n┌─ NEXT STEPS ───────────────────────────────────────────────┐");
  console.log("│ 1. frontend/lib/contracts.ts:                              │");
  console.log(`│      Bookmaker: '${bookmaker.address}' as const,`);
  console.log("│ 2. rsync + rebuild the frontend + restart the bots         │");
  console.log("│ 3. fund it (>=33 STT) and call resubscribe() to switch      │");
  console.log("│    one-shot Reactivity on                                  │");
  console.log("└────────────────────────────────────────────────────────────┘");
}

main().catch((err) => {
  console.error(err?.shortMessage ?? err);
  process.exitCode = 1;
});
