// ============================================================================
// deploy-event-desks — stand up the money plumbing for event-contract fights.
//
// Deploys one EventTreasury and six EventDesks against the LIVE Arena router,
// funds every desk, and records the addresses in the deployment manifest.
//
// Six desks = two event slots per fight x three concurrent fights, the Arena's
// maxActiveDuels. Desks are permanent and re-bindable; nothing here runs again
// per fight. Binding a desk to a market window is scripts/bind-event-window.ts.
//
// Run:
//   pnpm exec hardhat run scripts/deploy-event-desks.ts --network somnia
//
// Env:
//   PRIVATE_KEY   — funded testnet key; becomes owner of the treasury and desks.
//   DESKS         — how many desks to deploy (default 6).
//   FUND_EACH     — collateral per desk at bind time, whole tokens (default 50).
//   FORCE         — set to 1 to redeploy even if the manifest already has desks.
// ============================================================================

import hre from "hardhat";
import { formatUnits, parseAbiItem } from "viem";
import fs from "fs";
import path from "path";

// Where settled positions are claimed. Not the trading pool — a separate
// registry that identifies a market by an id only the creation log carries.
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388" as `0x${string}`;

const MARKET_CREATED = parseAbiItem(
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 yesId, uint256 noId, address collateral, string asset, uint256 strike, uint64 tradingStart, uint64 expiry, uint256 oracleQuestionId, string question, uint64 intervalSec)",
);

async function main() {
  const deskCount = Number(process.env.DESKS ?? "6");
  const fundEach = BigInt(process.env.FUND_EACH ?? "50") * 10n ** 6n;

  const manifestPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const arena = manifest.contracts.Arena.address as `0x${string}`;

  if (manifest.contracts.EventDesks && process.env.FORCE !== "1") {
    console.log("Manifest already has EventDesks. Set FORCE=1 to redeploy.");
    console.log(JSON.stringify(manifest.contracts.EventDesks, null, 2));
    return;
  }

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  console.log(`Deployer: ${wallet.account.address}`);
  console.log(`Arena:    ${arena}`);

  // The collateral address is read off a real market rather than typed in, so a
  // mistyped checksum cannot silently point the treasury at the wrong token.
  const collateral = await discoverCollateral(pub);
  console.log(`Collateral (from a live market): ${collateral}`);

  const treasury = await hre.viem.deployContract("EventTreasury", [collateral]);
  console.log(`\nEventTreasury: ${treasury.address}`);

  const desks: `0x${string}`[] = [];
  for (let i = 0; i < deskCount; i++) {
    const desk = await hre.viem.deployContract("EventDesk", [arena, MODULE]);
    desks.push(desk.address);
    console.log(`EventDesk[${i}]: ${desk.address}`);
  }

  console.log(`\nApproving desks on the treasury...`);
  for (const desk of desks) {
    const hash = await treasury.write.approveDesk([desk, true]);
    await pub.waitForTransactionReceipt({ hash });
  }

  // Enough for every desk, plus headroom for the top-ups that follow each bind.
  const total = fundEach * BigInt(desks.length) * 2n;
  console.log(`Refilling treasury with ${formatUnits(total, 6)} from the faucet...`);
  const refill = await treasury.write.refill([total]);
  await pub.waitForTransactionReceipt({ hash: refill });
  console.log(`Treasury balance: ${formatUnits((await treasury.read.balance()) as bigint, 6)}`);

  // Desks are NOT funded here. `fund` puts collateral into the bound market's
  // vault, and an unbound desk has no vault to put it in — so funding happens
  // in bind-event-window.ts, right after the desk is pointed at a window.
  manifest.contracts.EventDesks = {
    treasury: treasury.address,
    collateral,
    module: MODULE,
    desks,
    fundEach: fundEach.toString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nRecorded under contracts.EventDesks in ${path.basename(manifestPath)}`);
}

/// Read the collateral token off the most recent market creation. The indexer is
/// unreliable, so this walks the logs backwards the same way probe-event-desk does.
async function discoverCollateral(pub: any): Promise<`0x${string}`> {
  const head = await pub.getBlockNumber();
  for (let i = 0; i < 40; i++) {
    const to = head - BigInt(i * 1000);
    try {
      const logs = await pub.getLogs({ event: MARKET_CREATED, fromBlock: to - 999n, toBlock: to });
      if (logs.length) return logs[logs.length - 1].args.collateral as `0x${string}`;
    } catch { /* range unavailable */ }
  }
  throw new Error("no MarketCreated log found in the last 40k blocks — cannot discover collateral");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
